// Industry experience: every employer on the resume, looked up on the web to confirm what
// the company does. The AI only fills an industry when it is sure it found the right company;
// otherwise the employer is marked "unsure" and no industry is guessed.
//
// Web lookup, tried in order (first configured secret that succeeds wins): Gemini with Google
// Search grounding (GEMINI_API_KEY), then ChatGPT/OpenAI with its web search tool
// (OPENAI_API_KEY), then Claude with the web search tool (ANTHROPIC_API_KEY). OpenAI is tried
// ahead of Claude so agencies can point this at ChatGPT while a Claude subscription is paused —
// set OPENAI_API_KEY and it's used automatically; Claude stays as a fallback if it's also
// configured. If the lookup itself fails, every employer is kept as "unsure" so nothing
// unverified is presented as fact.

import type { ResumeInput } from "./resume.ts";

export type IndustryItem = {
  company: string; title: string; from: string; to: string;
  industry: string; confidence: "confirmed" | "unsure";
  big4_practice: string; source: string; note: string;
};

const PROMPT =
  "List EVERY employer on this candidate's CV (most recent first), then search the web for each company to confirm what it does. " +
  "Reply with STRICT JSON only, no markdown: {\"employers\": [{\"company\": string, \"title\": string, \"from\": string, \"to\": string, " +
  "\"industry\": string, \"confidence\": \"confirmed\" | \"unsure\", \"big4_practice\": string, \"source\": string, \"note\": string}]}. " +
  "Rules: 'company', 'title', 'from' and 'to' come from the CV exactly as written ('' if not given; 'Present' for a current role). " +
  "Set confidence 'confirmed' ONLY when the search found this specific company and it is consistent with the CV (name, location or business); then give its industry as a short label " +
  "(e.g. 'Fintech', 'SaaS / software', 'Banking', 'Asset management', 'Insurance', 'Big 4 / professional services', 'Consulting / staffing', 'Real estate services', " +
  "'Consumer goods', 'Healthcare', 'Health tech', 'Energy', 'Manufacturing', 'Aerospace', 'Government', 'Non-profit') and put the page you relied on in 'source' (a URL). " +
  "If the company can't be found, the name is ambiguous (several companies share it) or the CV gives too little to tell, set confidence 'unsure', industry '' and say why in 'note'. Never guess. " +
  "For consulting or staffing firms where the CV names the client companies, keep the firm's own industry and list the clients in 'note'. " +
  "'big4_practice': only for Deloitte, PwC, EY or KPMG roles, the practice the CV shows, one of 'Audit & Assurance', 'Advisory', 'Capital Markets', 'Financial Services', 'Tax', 'Consulting', 'Other'; '' otherwise.";

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error("Lookup returned something unexpected");
}

const withText = (resume: ResumeInput | null) =>
  resume?.kind === "text" ? `Candidate's CV (text):\n"""\n${resume.text}\n"""\n\n${PROMPT}` : PROMPT;

async function geminiWeb(key: string, model: string, resume: ResumeInput | null): Promise<{ json: any; sources: string[] }> {
  const parts: unknown[] = [];
  if (resume?.kind === "pdf") parts.push({ inline_data: { mime_type: "application/pdf", data: resume.data } });
  if (resume?.kind === "image") parts.push({ inline_data: { mime_type: resume.mime, data: resume.data } });
  parts.push({ text: withText(resume) });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1, maxOutputTokens: 16000 } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Web lookup failed (" + res.status + "): " + String(data?.error?.message || "").slice(0, 200));
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
  const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c: any) => c?.web?.uri).filter(Boolean);
  return { json: parseJson(text), sources };
}

async function openaiWeb(key: string, model: string, resume: ResumeInput | null): Promise<{ json: any; sources: string[] }> {
  const content: unknown[] = [{ type: "input_text", text: withText(resume) }];
  if (resume?.kind === "pdf") content.push({ type: "input_file", filename: "resume.pdf", file_data: `data:application/pdf;base64,${resume.data}` });
  if (resume?.kind === "image") content.push({ type: "input_image", image_url: `data:${resume.mime};base64,${resume.data}` });
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content }],
      tools: [{ type: "web_search_preview" }],
      temperature: 0.1,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Web lookup failed (" + res.status + "): " + String(data?.error?.message || "").slice(0, 200));
  const text = data.output_text || (Array.isArray(data.output) ? data.output
    .filter((o: any) => o.type === "message")
    .flatMap((o: any) => (Array.isArray(o.content) ? o.content : []))
    .filter((c: any) => c.type === "output_text")
    .map((c: any) => c.text || "").join("") : "");
  const sources = Array.isArray(data.output) ? data.output
    .filter((o: any) => o.type === "message")
    .flatMap((o: any) => (Array.isArray(o.content) ? o.content : []))
    .flatMap((c: any) => (Array.isArray(c.annotations) ? c.annotations : []))
    .map((a: any) => a?.url).filter(Boolean) : [];
  return { json: parseJson(text), sources };
}

async function claudeWeb(key: string, resume: ResumeInput | null): Promise<{ json: any; sources: string[] }> {
  const content: unknown[] = [];
  if (resume?.kind === "pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: resume.data } });
  if (resume?.kind === "image" && ["image/jpeg", "image/png", "image/webp"].includes(resume.mime)) content.push({ type: "image", source: { type: "base64", media_type: resume.mime, data: resume.data } });
  content.push({ type: "text", text: withText(resume) });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 6000, messages: [{ role: "user", content }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 12 }] }),
  });
  if (!res.ok) throw new Error("Web lookup failed (" + res.status + "): " + (await res.text()).slice(0, 200));
  const data = await res.json();
  const blocks: any[] = data.content || [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("");
  const sources = blocks.filter((b) => b.type === "web_search_tool_result").flatMap((b) => (Array.isArray(b.content) ? b.content : []).map((r: any) => r?.url)).filter(Boolean);
  return { json: parseJson(text), sources };
}

const clean = (x: any, sources: string[]): IndustryItem => {
  const confirmed = String(x?.confidence || "").toLowerCase() === "confirmed" && String(x?.industry || "").trim() !== "";
  const src = String(x?.source || "").trim();
  return {
    company: String(x?.company || "").slice(0, 120),
    title: String(x?.title || "").slice(0, 120),
    from: String(x?.from || "").slice(0, 30),
    to: String(x?.to || "").slice(0, 30),
    industry: confirmed ? String(x.industry).slice(0, 60) : "",
    confidence: confirmed ? "confirmed" : "unsure",
    big4_practice: String(x?.big4_practice || "").slice(0, 40),
    // A confirmed industry must point at something the search actually returned.
    source: confirmed ? (/^https?:\/\//.test(src) ? src : sources[0] || "") : "",
    note: String(x?.note || "").slice(0, 240),
  };
};

// Looks up every employer; returns the list (never throws for a failed lookup — it returns
// the reason so the caller can tell the recruiter).
export async function lookupIndustries(resume: ResumeInput | null): Promise<{ items: IndustryItem[]; error?: string }> {
  if (!resume) return { items: [], error: "No readable resume on file" };
  const gemini = Deno.env.get("GEMINI_API_KEY");
  const openai = Deno.env.get("OPENAI_API_KEY");
  const anthropic = Deno.env.get("ANTHROPIC_API_KEY");
  let lastErr = "";
  const tries: (() => Promise<{ json: any; sources: string[] }>)[] = [];
  if (gemini) for (const m of [...new Set([Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"])]) tries.push(() => geminiWeb(gemini, m, resume));
  // OpenAI is tried ahead of Claude so setting OPENAI_API_KEY hands this lookup to ChatGPT.
  if (openai) tries.push(() => openaiWeb(openai, Deno.env.get("OPENAI_MODEL") || "gpt-4.1", resume));
  if (anthropic) tries.push(() => claudeWeb(anthropic, resume));
  for (const t of tries) {
    try {
      const { json, sources } = await t();
      const list = Array.isArray(json?.employers) ? json.employers : [];
      const items = list.slice(0, 25).map((x: any) => clean(x, sources)).filter((x: IndustryItem) => x.company);
      if (items.length) return { items };
      lastErr = "No employers found on the resume";
    } catch (e) { lastErr = String((e as Error)?.message || e); console.error("industry lookup", lastErr); }
  }
  return { items: [], error: lastErr || "AI is not configured" };
}

// One line per employer for the screening prompts.
export function industryText(items: any[]): string {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return "Industry experience: not looked up yet.";
  return "Industry experience (companies looked up on the web; 'unsure' = company could not be confirmed, so treat its industry as unknown):\n" +
    list.map((x) => `- ${x.company}${x.title ? " (" + x.title + ")" : ""}${x.from || x.to ? ", " + [x.from, x.to].filter(Boolean).join(" to ") : ""}: ` +
      (x.confidence === "confirmed" ? x.industry : "unsure") + (x.big4_practice ? `; Big 4 practice: ${x.big4_practice}` : "")).join("\n");
}
