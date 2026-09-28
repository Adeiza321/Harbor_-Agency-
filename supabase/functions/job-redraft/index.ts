import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { prepareResume, type ResumeInput } from "./resume.ts";

// Two things live here, both invoked from "Post a job":
//   1. Rewrites a job ad for search (Google for Jobs, LinkedIn, job boards) — the
//      "AI redraft for SEO" button (the original behaviour, unchanged below).
//   2. Reads an uploaded job brief (PDF, Word, text, photo) and pulls the job's fields
//      out of it, so a recruiter can drop in a brief instead of retyping it — the
//      "Upload a job brief" file picker. mode: "extract" with a base64 `file`.
// AI: Gemini first (GEMINI_API_KEY; model from GEMINI_MODEL). If Gemini fails, is over quota
// or hasn't answered within GEMINI_BUDGET_MS, Claude does it instead (ANTHROPIC_API_KEY;
// model from ANTHROPIC_MODEL, default the low-cost claude-haiku-4-5).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const EXTRACT_SHAPE =
  `{"title": string, "client": string, "location": string, "workSetup": "Onsite" | "Hybrid" | "Remote" | "", ` +
  `"employmentType": "Full-time" | "Part-time" | "Contract" | "", ` +
  `"country": string, "currency": string, "salaryPeriod": "Yearly" | "Monthly" | "Weekly" | "Daily" | "Hourly" | "", "commissionOnly": boolean, ` +
  `"minPay": number | null, "maxPay": number | null, "headcount": number | null, ` +
  `"description": string, "screeningQuestions": string[]}`;

const EXTRACT_SYSTEM =
  "You are helping a recruitment agency turn a job brief document (a client's job spec, an email, a rough draft) into a structured job posting. " +
  "Read the document and reply with STRICT JSON only, no markdown: " + EXTRACT_SHAPE + ". " +
  "Rules: use ONLY what the document actually says — never invent a client name, pay figures, location or requirements that aren't there; leave a field '' or null if it isn't given. " +
  "'client' is the hiring company's name if named, otherwise ''. 'location' is the city/area (e.g. 'Lagos, Nigeria'), not the work setup. " +
  "'workSetup' is one of Onsite, Hybrid or Remote ONLY if the document clearly states it, otherwise ''. " +
  "'employmentType' is one of Full-time, Part-time or Contract ONLY if the document clearly states it, otherwise ''. " +
  "'currency' is a 3-letter ISO code (e.g. NGN, USD) if a currency is given or can be inferred from the country, otherwise ''. " +
  "'commissionOnly' is true only if the document says the role is commission-only with no base salary; then leave minPay/maxPay null and salaryPeriod ''. " +
  "Otherwise 'salaryPeriod' is how the pay figures are quoted (Yearly, Monthly, Weekly, Daily or Hourly) if stated or clearly implied, otherwise 'Yearly'. " +
  "'description' is the role description rewritten as clean plain text (no markdown symbols), keeping every responsibility, requirement and detail the document gives — do not summarize away specifics. " +
  "'headcount' is the number of openings for this exact role ONLY if the document states it (e.g. 'hiring 3', '2 openings'), otherwise null — never assume 1. " +
  "'screeningQuestions' is a short list of screening questions ONLY if the document explicitly lists questions to ask candidates, otherwise an empty array.";

// One call to Claude; when it is busy (429 rate limit, 529 overloaded, 5xx) wait and retry twice.
async function askClaude(key: string, body: Record<string, unknown>): Promise<string> {
  const payload = JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001", ...body });
  let r: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: payload,
    });
    if (r.ok || ![429, 500, 502, 503, 529].includes(r.status)) break;
    console.error("claude busy", r.status);
    await new Promise((res) => setTimeout(res, attempt === 0 ? 2000 : 5000));
  }
  const data = await r!.json().catch(() => ({}));
  if (!r!.ok) {
    const msg = String(data?.error?.message || r!.statusText);
    if ([429, 529].includes(r!.status)) throw new Error("Claude is very busy right now. Please try again in a minute.");
    if (/credit balance/i.test(msg)) throw new Error("The Claude account is out of credit. Top up at console.anthropic.com, then try again.");
    throw new Error("AI request failed: " + msg);
  }
  if (data.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off before it finished");
  return (data.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const GEMINI_BUDGET_MS = 40000;

// Gemini, with busy-model retries and fallback models, all within GEMINI_BUDGET_MS.
async function askGemini(key: string, system: string, parts: unknown[], maxOut: number, temperature: number): Promise<string> {
  const deadline = Date.now() + GEMINI_BUDGET_MS;
  const models = [...new Set([Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"])];
  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", temperature, maxOutputTokens: maxOut },
  });
  let lastErr = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 3000) throw new Error("Gemini didn't answer in time");
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(left),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const text = (data.candidates?.[0]?.content?.parts || []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text || "").join("");
        if (text) return text;
        lastErr = "Gemini returned no answer"; break;
      }
      lastErr = "Gemini: " + String(data?.error?.message || r.statusText).slice(0, 200);
      console.error("gemini", model, r.status, lastErr);
      if (r.status === 404) break;
      if (r.status === 429 && /quota/i.test(lastErr)) throw new Error("Gemini's free quota is used up");
      if (![429, 500, 503].includes(r.status)) throw new Error(lastErr);
      await sleep(attempt === 0 ? 1500 : 3000);
    }
  }
  throw new Error(lastErr || "Gemini request failed");
}

type Keys = { gemini?: string; anthropic?: string };

// Tries Gemini, then Claude; returns the first answer.
async function askChain(keys: Keys, system: string, resume: ResumeInput | null, text: string, maxOut: number, temperature: number): Promise<string> {
  const errors: string[] = [];
  if (keys.gemini) {
    const parts: unknown[] = [];
    if (resume?.kind === "pdf") parts.push({ inline_data: { mime_type: "application/pdf", data: resume.data } });
    else if (resume?.kind === "image") parts.push({ inline_data: { mime_type: resume.mime, data: resume.data } });
    parts.push({ text });
    try {
      const out = await askGemini(keys.gemini, system, parts, Math.max(maxOut * 3, 8000), temperature);
      const m = out.match(/\{[\s\S]*\}/);
      JSON.parse(m ? m[0] : out); // unreadable answer: let Claude redo it
      return out;
    }
    catch (e) { errors.push(String((e as Error)?.message || e)); console.error("gemini failed, using claude", errors[errors.length - 1]); }
  }
  if (keys.anthropic) {
    try { return await extractOrDraftWithClaude(keys.anthropic, system, resume, text, maxOut); } catch (e) { errors.push("Claude: " + String((e as Error)?.message || e)); }
  }
  throw new Error(errors.length ? "AI request failed. " + errors.join(" | ") : "AI is not set up yet.");
}

async function extractOrDraftWithClaude(key: string, system: string, resume: ResumeInput | null, text: string, maxOut: number): Promise<string> {
  const content: unknown[] = [];
  if (resume?.kind === "pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: resume.data } });
  else if (resume?.kind === "image" && ["image/jpeg", "image/png", "image/webp"].includes(resume.mime)) content.push({ type: "image", source: { type: "base64", media_type: resume.mime, data: resume.data } });
  else if (resume?.kind === "image") throw new Error("That photo format isn't supported. Try a JPG, PNG or WEBP.");
  content.push({ type: "text", text });
  return await askClaude(key, { max_tokens: Math.max(maxOut * 2, 8000), system, messages: [{ role: "user", content }] });
}

async function handleExtract(input: Record<string, unknown>, keys: Keys) {
  const file = input.file as { name?: string; data?: string } | undefined;
  if (!file?.data) return json({ error: "No file was received" }, 400);
  const bytes = base64ToBytes(file.data);
  const { input: resume, why } = await prepareResume(bytes, file.name || "brief");
  if (!resume) return json({ error: why || "Couldn't read that file" }, 400);

  let text = "";
  try {
    const docText = resume.kind === "text" ? "Job brief document:\n\"\"\"\n" + resume.text + "\n\"\"\"" : "The job brief document is attached.";
    text = await askChain(keys, EXTRACT_SYSTEM, resume.kind === "text" ? null : resume, docText, 4000, 0.2);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 502);
  }
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const out = JSON.parse(m ? m[0] : text);
    const setup = ["Onsite", "Hybrid", "Remote"].includes(out.workSetup) ? out.workSetup : "";
    const employmentType = ["Full-time", "Part-time", "Contract"].includes(out.employmentType) ? out.employmentType : "";
    const commissionOnly = out.commissionOnly === true;
    const salaryPeriod = commissionOnly ? "" : (["Yearly", "Monthly", "Weekly", "Daily", "Hourly"].includes(out.salaryPeriod) ? out.salaryPeriod : "Yearly");
    return json({
      title: clip(out.title, 120),
      client: clip(out.client, 200),
      location: clip(out.location, 200),
      workSetup: setup,
      employmentType,
      country: clip(out.country, 100),
      currency: clip(out.currency, 3).toUpperCase(),
      salaryPeriod,
      commissionOnly,
      minPay: commissionOnly ? null : (Number.isFinite(out.minPay) ? out.minPay : null),
      maxPay: commissionOnly ? null : (Number.isFinite(out.maxPay) ? out.maxPay : null),
      headcount: Number.isFinite(out.headcount) && out.headcount > 0 ? Math.round(out.headcount) : null,
      description: clip(out.description, 15000),
      screeningQuestions: Array.isArray(out.screeningQuestions) ? out.screeningQuestions.slice(0, 12).map((q: unknown) => clip(q, 300)).filter(Boolean) : [],
    });
  } catch {
    return json({ error: "AI returned an unexpected format. Try again." }, 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const keys: Keys = { gemini: Deno.env.get("GEMINI_API_KEY"), anthropic: Deno.env.get("ANTHROPIC_API_KEY") };
  if (!keys.gemini && !keys.anthropic) return json({ error: "AI is not set up yet: add a GEMINI_API_KEY or ANTHROPIC_API_KEY secret to this Supabase project." }, 503);

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  if (input.mode === "extract") return await handleExtract(input, keys);

  const title = clip(input.title, 200).trim();
  const description = clip(input.description, 12000).trim();
  if (!title || description.length < 40) return json({ error: "Add a job title and a job description (at least a few sentences) first." }, 400);

  const commissionOnly = input.commissionOnly === true;
  const salaryPeriod = clip(input.salaryPeriod, 20) || "Yearly";
  const periodLabel: Record<string, string> = { Yearly: "per year", Monthly: "per month", Weekly: "per week", Daily: "per day", Hourly: "per hour" };
  const facts = [
    `Job title: ${title}`,
    `Client (never name them in the ad): ${clip(input.client, 200)}`,
    `Work location / arrangement: ${clip(input.location, 200) || "not given"}`,
    `Work setup: ${clip(input.workSetup, 30) || "not given"}`,
    `Employment type: ${clip(input.employmentType, 30) || "not given"}`,
    `Country we are hiring in: ${clip(input.country, 100) || "not given"}`,
    `Number of openings for this role: ${Number.isFinite(input.headcount) && (input.headcount as number) > 1 ? input.headcount : "not given / a single opening"}`,
    `Salary: ${commissionOnly ? "commission-only, no base salary" : (input.minPay || input.maxPay ? `${input.minPay || "?"} to ${input.maxPay || "?"} ${clip(input.currency, 3)} ${periodLabel[salaryPeriod] || "per year"}` : "not given")}`,
    "",
    "Original job description:",
    description,
  ].join("\n");

  const system = `You are an expert recruitment copywriter for a staffing agency. Rewrite job ads so they rank well in Google for Jobs, LinkedIn and job-board search, and so qualified candidates want to apply.

Rules:
- Use ONLY facts in the input. Never invent benefits, perks, company details, numbers, tools or requirements. Keep every requirement, pay figure and condition (e.g. visa sponsorship, relocation) that is given.
- Never name the client company. Refer to it generically from what the input says (e.g. "our client, a leading fintech").
- Work naturally into the copy (for search relevance, not as a checklist): the work setup (onsite/hybrid/remote) and employment type (full-time/part-time/contract) if given, and — only if there is more than one opening — that there are multiple openings for this role (e.g. "we're hiring 3 X's"). Never invent a headcount if it isn't given.
- If the salary is commission-only, say so plainly rather than implying a base salary. Otherwise quote pay using the period given (yearly/monthly/weekly/daily/hourly), never assume "per year" if another period was given.
- Title: the clearest standard job title candidates actually search for, optionally with one short qualifier (e.g. "(Remote)"). No emojis, no ALL CAPS, max 70 characters.
- Description: plain text (no markdown symbols like # or **). Short opening paragraph that states the role, seniority, location/remote status and country naturally. Then sections with these plain headings on their own line: About the role, What you'll do, What you'll bring, Nice to have (only if given), Pay and details. Use "• " bullets. Put the most searched skills and terms naturally in the text; do not keyword-stuff.
- Meta description: max 155 characters, for search results.
- Keywords: 8 to 12 search terms candidates would use.

Reply with ONLY a JSON object, no other text: {"title": string, "description": string, "meta_description": string, "keywords": string[]}`;

  let text = "";
  try {
    text = await askChain(keys, system, null, facts, 3000, 0.4);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 502);
  }
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const out = JSON.parse(m ? m[0] : text);
    return json({
      title: clip(out.title, 120),
      description: clip(out.description, 15000),
      meta_description: clip(out.meta_description, 200),
      keywords: Array.isArray(out.keywords) ? out.keywords.slice(0, 15).map((k: unknown) => clip(k, 60)) : [],
    });
  } catch {
    return json({ error: "AI returned an unexpected format. Try again." }, 502);
  }
});
