// The Candidates page's AI filter: "accountants in Lagos with IFRS, added this month, fit 70+"
// becomes the page's own filters. The page sends what it can filter on (statuses, countries, jobs,
// recruiters on the list); the model picks from those, so nothing is invented, and the page applies
// the result itself. Nothing is read from the database here.

export type FilterContext = { statuses: string[]; countries: string[]; jobs: { id: string; label: string }[]; recruiters: string[]; sources: string[] };
export type CandidateFilter = { status: string | null; countries: string[]; jobIds: string[]; recruiters: string[]; sources: string[]; minAi: number; addedDays: number | null; keywords: string[]; summary: string };

const clean = (v: unknown, n = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const list = (v: unknown, max: number) => (Array.isArray(v) ? v : []).map((x) => clean(x, 120)).filter(Boolean).slice(0, max);

export function filterContext(raw: any): FilterContext {
  return {
    statuses: list(raw?.statuses, 20), countries: list(raw?.countries, 120), recruiters: list(raw?.recruiters, 80), sources: list(raw?.sources, 40),
    jobs: (Array.isArray(raw?.jobs) ? raw.jobs : []).slice(0, 150).map((j: any) => ({ id: clean(j?.id, 60), label: clean(j?.label, 140) })).filter((j: any) => j.id),
  };
}

export async function candidateFilter(key: string, model: string, text: string, ctx: FilterContext, today: string) {
  const system = `You turn a recruiter's description of the candidates they want into filters for a candidate list. Reply with JSON only, no prose:
{"status": one of the statuses or null, "countries": [...], "jobIds": [...], "recruiters": [...], "sources": [...], "minAi": 0-100, "addedDays": number or null, "keywords": [...], "summary": "..."}
Rules:
- Pick values ONLY from the lists given; leave a field empty when the description doesn't ask for it.
- status: the pipeline status they asked for ("in interview" → "Interview", "with the client" → "With client", "available"/"not on a role" → "Active file"). null if none.
- countries: a city or region counts as its country ("Lagos" → "Nigeria", "Riyadh" → "Saudi Arabia", "Texas" → "United States").
- jobIds: only when they name a role or client that matches a job on the list.
- minAi: "strong"/"good fit" → 70, "great"/"top" → 80, a number they give; else 0.
- addedDays: "this week" → 7, "this month" → 31, "today" → 1, "last 3 months" → 92; else null. Today is ${today}.
- keywords: skills, titles, qualifications or other words to look for in the candidate's profile (title, skills, experience, location), each 1-3 words, as written ("IFRS", "ACCA", "nurse", "Power BI"). Not the country, status or job already captured above.
- summary: one short line saying what you filtered on, e.g. "Accountants in Nigeria with IFRS, added this month".`;
  const user = `Description: ${clean(text, 500)}

Statuses: ${ctx.statuses.join(" | ")}
Countries on the list: ${ctx.countries.join(" | ") || "(none)"}
Jobs (id | role · client): ${ctx.jobs.map((j) => j.id + " | " + j.label).join("\n") || "(none)"}
Recruiters: ${ctx.recruiters.join(" | ") || "(none)"}
Sources: ${ctx.sources.join(" | ") || "(none)"}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 500, system, messages: [{ role: "user", content: user }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 400 && /credit/i.test(JSON.stringify(j)) ? "The AI is paused (out of credit)" : "The AI couldn't read that right now. Try again.");
  const out = String((j?.content || []).map((b: any) => b?.text || "").join("")).trim();
  let p: any = {};
  try { p = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)); } catch { throw new Error("The AI couldn't read that. Try saying it another way."); }
  const pick = (vals: unknown, allowed: string[], max: number) => list(vals, max).filter((v) => allowed.includes(v));
  const filter: CandidateFilter = {
    status: ctx.statuses.includes(clean(p.status, 40)) ? clean(p.status, 40) : null,
    countries: pick(p.countries, ctx.countries, 20),
    jobIds: pick(p.jobIds, ctx.jobs.map((x) => x.id), 20),
    recruiters: pick(p.recruiters, ctx.recruiters, 20),
    sources: pick(p.sources, ctx.sources, 10),
    minAi: Math.max(0, Math.min(100, Math.round(Number(p.minAi) || 0))),
    addedDays: Number(p.addedDays) > 0 ? Math.min(3660, Math.round(Number(p.addedDays))) : null,
    keywords: list(p.keywords, 8).map((k) => k.slice(0, 40)),
    summary: clean(p.summary, 160),
  };
  return { filter, usage: { input: Number(j?.usage?.input_tokens) || 0, output: Number(j?.usage?.output_tokens) || 0 } };
}
