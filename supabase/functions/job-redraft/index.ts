import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { prepareResume, type ResumeInput } from "./resume.ts";

// Two things live here, both invoked from "Post a job":
//   1. Rewrites a job ad for search (Google for Jobs, LinkedIn, job boards) — the
//      "AI redraft for SEO" button (the original behaviour, unchanged below).
//   2. Reads an uploaded job brief (PDF, Word, text, photo) and pulls the job's fields
//      out of it, so a recruiter can drop in a brief instead of retyping it — the
//      "Upload a job brief" file picker. mode: "extract" with a base64 `file`.
// Uses Gemini when the GEMINI_API_KEY secret is set (model from GEMINI_MODEL, default
// gemini-3.8-flash); otherwise Anthropic via ANTHROPIC_API_KEY.

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
  `"country": string, "currency": string, "minPay": number | null, "maxPay": number | null, ` +
  `"description": string, "screeningQuestions": string[]}`;

const EXTRACT_SYSTEM =
  "You are helping a recruitment agency turn a job brief document (a client's job spec, an email, a rough draft) into a structured job posting. " +
  "Read the document and reply with STRICT JSON only, no markdown: " + EXTRACT_SHAPE + ". " +
  "Rules: use ONLY what the document actually says — never invent a client name, pay figures, location or requirements that aren't there; leave a field '' or null if it isn't given. " +
  "'client' is the hiring company's name if named, otherwise ''. 'location' is the city/area (e.g. 'Lagos, Nigeria'), not the work setup. " +
  "'workSetup' is one of Onsite, Hybrid or Remote ONLY if the document clearly states it, otherwise ''. " +
  "'currency' is a 3-letter ISO code (e.g. NGN, USD) if a currency is given or can be inferred from the country, otherwise ''. " +
  "'description' is the role description rewritten as clean plain text (no markdown symbols), keeping every responsibility, requirement and detail the document gives — do not summarize away specifics. " +
  "'screeningQuestions' is a short list of screening questions ONLY if the document explicitly lists questions to ask candidates, otherwise an empty array.";

async function extractWithGemini(key: string, resume: ResumeInput): Promise<string> {
  const parts: unknown[] = [];
  if (resume.kind === "pdf") parts.push({ inline_data: { mime_type: "application/pdf", data: resume.data } });
  else if (resume.kind === "image") parts.push({ inline_data: { mime_type: resume.mime, data: resume.data } });
  else parts.push({ text: "Job brief document:\n\"\"\"\n" + resume.text + "\n\"\"\"" });

  const models = [...new Set([Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"])];
  let lastErr = "", lastStatus = 0;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: EXTRACT_SYSTEM }] },
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 12000 },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const text = (data.candidates?.[0]?.content?.parts || []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text || "").join("");
        if (text) return text;
        lastErr = "AI returned no answer"; break;
      }
      lastStatus = r.status; lastErr = data?.error?.message || r.statusText;
      console.error("gemini extract", model, r.status, String(lastErr).slice(0, 200));
      if (r.status === 404) break;
      if (![429, 500, 503].includes(r.status)) throw new Error("AI request failed: " + lastErr);
      await new Promise((res) => setTimeout(res, attempt === 0 ? 1500 : 3000));
    }
  }
  throw new Error(lastStatus === 503 || lastStatus === 429 ? "Google's AI is very busy right now. Please try again in a minute." : "AI request failed: " + lastErr);
}

async function extractWithClaude(key: string, resume: ResumeInput): Promise<string> {
  const content: unknown[] = [];
  if (resume.kind === "pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: resume.data } });
  else if (resume.kind === "image" && ["image/jpeg", "image/png", "image/webp"].includes(resume.mime)) content.push({ type: "image", source: { type: "base64", media_type: resume.mime, data: resume.data } });
  else if (resume.kind === "image") throw new Error("That photo format isn't supported. Try a JPG, PNG or WEBP.");
  else content.push({ type: "text", text: "Job brief document:\n\"\"\"\n" + resume.text + "\n\"\"\"" });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5", max_tokens: 4000, system: EXTRACT_SYSTEM, messages: [{ role: "user", content }] }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("AI request failed: " + (data?.error?.message || r.statusText));
  return (data.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
}

async function handleExtract(input: Record<string, unknown>, geminiKey?: string, anthropicKey?: string) {
  const file = input.file as { name?: string; data?: string } | undefined;
  if (!file?.data) return json({ error: "No file was received" }, 400);
  const bytes = base64ToBytes(file.data);
  const { input: resume, why } = await prepareResume(bytes, file.name || "brief");
  if (!resume) return json({ error: why || "Couldn't read that file" }, 400);

  let text = "";
  try {
    text = geminiKey ? await extractWithGemini(geminiKey, resume) : await extractWithClaude(anthropicKey!, resume);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 502);
  }
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const out = JSON.parse(m ? m[0] : text);
    const setup = ["Onsite", "Hybrid", "Remote"].includes(out.workSetup) ? out.workSetup : "";
    return json({
      title: clip(out.title, 120),
      client: clip(out.client, 200),
      location: clip(out.location, 200),
      workSetup: setup,
      country: clip(out.country, 100),
      currency: clip(out.currency, 3).toUpperCase(),
      minPay: Number.isFinite(out.minPay) ? out.minPay : null,
      maxPay: Number.isFinite(out.maxPay) ? out.maxPay : null,
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

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!geminiKey && !key) return json({ error: "AI is not set up yet: add a GEMINI_API_KEY secret to this Supabase project." }, 503);

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  if (input.mode === "extract") return await handleExtract(input, geminiKey, key);

  const title = clip(input.title, 200).trim();
  const description = clip(input.description, 12000).trim();
  if (!title || description.length < 40) return json({ error: "Add a job title and a job description (at least a few sentences) first." }, 400);

  const facts = [
    `Job title: ${title}`,
    `Client (never name them in the ad): ${clip(input.client, 200)}`,
    `Work location / arrangement: ${clip(input.location, 200) || "not given"}`,
    `Country we are hiring in: ${clip(input.country, 100) || "not given"}`,
    `Salary: ${input.minPay || input.maxPay ? `${input.minPay || "?"} to ${input.maxPay || "?"} ${clip(input.currency, 3)} per year` : "not given"}`,
    "",
    "Original job description:",
    description,
  ].join("\n");

  const system = `You are an expert recruitment copywriter for a staffing agency. Rewrite job ads so they rank well in Google for Jobs, LinkedIn and job-board search, and so qualified candidates want to apply.

Rules:
- Use ONLY facts in the input. Never invent benefits, perks, company details, numbers, tools or requirements. Keep every requirement, pay figure and condition (e.g. visa sponsorship, relocation) that is given.
- Never name the client company. Refer to it generically from what the input says (e.g. "our client, a leading fintech").
- Title: the clearest standard job title candidates actually search for, optionally with one short qualifier (e.g. "(Remote)"). No emojis, no ALL CAPS, max 70 characters.
- Description: plain text (no markdown symbols like # or **). Short opening paragraph that states the role, seniority, location/remote status and country naturally. Then sections with these plain headings on their own line: About the role, What you'll do, What you'll bring, Nice to have (only if given), Pay and details. Use "• " bullets. Put the most searched skills and terms naturally in the text; do not keyword-stuff.
- Meta description: max 155 characters, for search results.
- Keywords: 8 to 12 search terms candidates would use.

Reply with ONLY a JSON object, no other text: {"title": string, "description": string, "meta_description": string, "keywords": string[]}`;

  let text = "";
  if (geminiKey) {
    // Retry busy models, then fall back to the next one (same list as ai-screen).
    const models = [...new Set([Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"])];
    const payload = JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: facts }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 12000 },
    });
    let lastErr = "", lastStatus = 0;
    outer: for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": geminiKey, "content-type": "application/json" },
          body: payload,
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          text = (data.candidates?.[0]?.content?.parts || []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text || "").join("");
          if (text) break outer;
          lastErr = "AI returned no answer"; break;
        }
        lastStatus = r.status; lastErr = data?.error?.message || r.statusText;
        console.error("gemini", model, r.status, String(lastErr).slice(0, 200));
        if (r.status === 404) break;
        if (![429, 500, 503].includes(r.status)) return json({ error: "AI request failed: " + lastErr }, 502);
        await new Promise((res) => setTimeout(res, attempt === 0 ? 1500 : 3000));
      }
    }
    if (!text) return json({ error: lastStatus === 503 || lastStatus === 429 ? "Google's AI is very busy right now. Please try again in a minute." : "AI request failed: " + lastErr }, 502);
  } else {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5",
        max_tokens: 3000,
        system,
        messages: [{ role: "user", content: facts }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "AI request failed: " + (data?.error?.message || r.statusText) }, 502);
    text = (data.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
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
