// One memory of everything a candidate has ever told us, so no form asks them the same thing twice.
//
//   answerMemory     every answer they've given: the job questions on each application, follow-up
//                    questions from their candidate page (or typed in by a recruiter from a call),
//                    and their "Help us match you" answers
//   prefillAnswers   for a list of questions about to be shown, the earlier answer that already
//                    answers each one (or "" when it's new). Shown pre-filled; they can change it.
//   prefsPrefill     the "Help us match you" form filled in, as far as the CV, the profile and their
//                    earlier answers show. Only fields with clear evidence; the rest stay blank.
// Nothing here is saved as the candidate's answer: they see it, check it and send it themselves.

import { answersOn } from "./screening.ts";
import type { ResumeInput } from "./resume.ts";

type Ask = (system: string, text: string, resume: ResumeInput | null, maxTokens: number) => Promise<any>;
export type Memory = { q: string; a: string; where: string };

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function prefsLines(p: any): Memory[] {
  if (!p || typeof p !== "object") return [];
  const out: Memory[] = [];
  const add = (q: string, a: unknown) => { const s = Array.isArray(a) ? a.filter(Boolean).join(", ") : String(a ?? "").trim(); if (s) out.push({ q, a: s, where: "your job preferences" }); };
  add("Roles you're looking for", p.roles);
  add("Level", p.seniority);
  add("Type of work", p.employmentTypes);
  const s = p.salary || {};
  if (Number(s.min) > 0) add("Salary you're looking for", `${s.currency || ""} ${Number(s.min).toLocaleString("en-US")}${Number(s.max) > Number(s.min) ? " – " + Number(s.max).toLocaleString("en-US") : ""} per ${s.period || "year"}`);
  add("Where you're based", [p.currentCity, p.currentCountry].filter(Boolean).join(", "));
  add("Would you relocate within your country", p.relocate);
  add("Remote, hybrid or on-site", p.workSetup);
  if (typeof p.citizen === "boolean") add("Citizen or permanent resident of " + (p.currentCountry || "your country"), p.citizen ? "Yes" : "No");
  add("Visa", p.visaType);
  add("Visa expiry", p.visaExpiry);
  add("Need sponsorship to change employer", p.sponsorship);
  add("Languages", (p.languages || []).map((l: any) => l && l.language ? l.language + (l.level ? " (" + l.level + ")" : "") : "").filter(Boolean));
  add("When you could start", p.availability);
  add("Industries", p.industries);
  return out;
}

export async function answerMemory(admin: any, candidateId: string, exceptLinkId?: string): Promise<Memory[]> {
  const { data: cand } = await admin.from("candidates").select("preferences").eq("id", candidateId).maybeSingle();
  const { data: links } = await admin.from("candidate_jobs").select("id,job_id,screening_answers,ai").eq("candidate_id", candidateId);
  const ids = [...new Set((links || []).map((l: any) => l.job_id))];
  const { data: jobs } = ids.length ? await admin.from("jobs").select("id,role_title,client,screening_questions").in("id", ids) : { data: [] };
  const out: Memory[] = [];
  for (const l of links || []) {
    if (l.id === exceptLinkId) continue;
    const j = (jobs || []).find((x: any) => x.id === l.job_id);
    for (const x of answersOn(l, j)) out.push({ q: x.q, a: x.a, where: j ? j.role_title + (j.client ? ", " + j.client : "") : "an earlier application" });
  }
  out.push(...prefsLines(cand?.preferences));
  return out;
}

// For each question: the earlier answer that already answers it ("" if none) and where it came from.
export async function prefillAnswers(askAI: Ask, memory: Memory[], questions: string[]): Promise<{ a: string; from: string }[]> {
  const res = questions.map(() => ({ a: "", from: "" }));
  if (!memory.length || !questions.length) return res;
  // Same question, word for word (ignoring case and punctuation): the latest answer.
  questions.forEach((q, i) => { const hit = [...memory].reverse().find((m) => norm(m.q) === norm(q)); if (hit) res[i] = { a: hit.a, from: hit.where }; });
  const open = questions.map((q, i) => ({ q, i })).filter((x) => !res[x.i].a);
  if (!open.length) return res;
  const system = "You help a recruitment agency avoid asking a candidate the same thing twice. You get the candidate's earlier answers and some new questions. " +
    "For each new question, if an earlier answer clearly answers it (the same topic, even if worded differently, e.g. 'expected salary' and 'desired total compensation'), " +
    "give that answer, worded to fit the new question but adding NOTHING the candidate didn't say. If the earlier answers only partly answer it, or don't answer it, give an empty string. " +
    "Reply with STRICT JSON only: {\"answers\": [{\"n\": number, \"answer\": string, \"from\": number}]} where n is the new question's number and from is the number of the earlier answer used (or -1).";
  const text = "Earlier answers:\n" + memory.map((m, k) => `${k}. Q: ${m.q}\n   A: ${m.a}`).join("\n") +
    "\n\nNew questions:\n" + open.map((x, k) => `${k}. ${x.q}`).join("\n");
  try {
    const out = await askAI(system, text, null, 1500);
    for (const r of Array.isArray(out?.answers) ? out.answers : []) {
      const o = open[Number(r?.n)]; const a = String(r?.answer || "").trim().slice(0, 3000);
      if (!o || !a) continue;
      const m = memory[Number(r?.from)];
      res[o.i] = { a, from: m ? m.where : "your earlier answers" };
    }
  } catch (e) { console.error("prefill answers", String((e as Error)?.message || e)); }
  return res;
}

// The "Help us match you" answers we can already see. options: the form's own choices (sent by the
// page), so every value the AI gives is one the form can show.
export type PrefOptions = { seniority: string[]; employmentTypes: string[]; availability: string[]; workSetup: string[]; relocate: string[]; sponsorship: string[]; industries: string[]; languages: string[]; langLevels: string[] };
export async function prefsPrefill(askAI: Ask, material: string, o: PrefOptions, resume: ResumeInput | null) {
  const system = "You fill in a candidate's job-preference form for a recruitment agency, from their CV, profile and earlier answers. " +
    "Only fill a field when the material clearly shows it; otherwise leave it out. Never guess salary, citizenship, visa or sponsorship: only use what the candidate said. " +
    "Use ONLY these values where a list is given.\n" +
    `seniority (one of): ${o.seniority.join(" | ")}\n` +
    `employmentTypes (any of): ${o.employmentTypes.join(" | ")}\n` +
    `availability (one of): ${o.availability.join(" | ")}\n` +
    `workSetup (any of): ${o.workSetup.join(" | ")}\n` +
    `relocate (one of, only if they said): ${o.relocate.join(" | ")}\n` +
    `sponsorship (one of, only if they said): ${o.sponsorship.join(" | ")}\n` +
    `industries (any of, from the employers they worked for): ${o.industries.join(" | ")}\n` +
    `languages[].language (any of): ${o.languages.join(" | ")}; languages[].level (one of): ${o.langLevels.join(" | ")}\n` +
    "Reply with STRICT JSON only, leaving out anything unknown: {\"roles\": string[] (up to 5 job titles they want, from what they applied for and their current/recent titles), " +
    "\"seniority\": string, \"employmentTypes\": string[], \"salary\": {\"min\": number, \"max\": number|null, \"currency\": string (ISO code), \"period\": \"year\"|\"month\"|\"hour\"}, " +
    "\"currentCity\": string, \"currentCountry\": string (English country name), \"relocate\": string, \"workSetup\": string[], \"citizen\": boolean, \"visaType\": string, " +
    "\"sponsorship\": string, \"languages\": [{\"language\": string, \"level\": string}], \"availability\": string, \"industries\": string[]}";
  const out = await askAI(system, material.slice(0, 14000), resume, 1200);
  if (!out || typeof out !== "object") return null;
  const pick = (v: unknown, list: string[]) => { const s = String(v ?? "").trim(); return list.find((x) => x.toLowerCase() === s.toLowerCase()) || ""; };
  const many = (v: unknown, list: string[]) => [...new Set((Array.isArray(v) ? v : []).map((x) => pick(x, list)).filter(Boolean))];
  const p: any = {};
  const roles = (Array.isArray(out.roles) ? out.roles : []).map((r: unknown) => String(r || "").trim().slice(0, 80)).filter(Boolean).slice(0, 5);
  if (roles.length) p.roles = roles;
  if (pick(out.seniority, o.seniority)) p.seniority = pick(out.seniority, o.seniority);
  if (many(out.employmentTypes, o.employmentTypes).length) p.employmentTypes = many(out.employmentTypes, o.employmentTypes);
  const s = out.salary || {};
  if (Number(s.min) > 0 && /^[A-Z]{3}$/.test(String(s.currency || ""))) p.salary = { min: Math.round(Number(s.min)), max: Number(s.max) > Number(s.min) ? Math.round(Number(s.max)) : null, currency: String(s.currency), period: ["year", "month", "hour"].includes(s.period) ? s.period : "year" };
  if (out.currentCity) p.currentCity = String(out.currentCity).slice(0, 80);
  if (out.currentCountry) p.currentCountry = String(out.currentCountry).slice(0, 80);
  if (pick(out.relocate, o.relocate)) p.relocate = pick(out.relocate, o.relocate);
  if (many(out.workSetup, o.workSetup).length) p.workSetup = many(out.workSetup, o.workSetup);
  if (typeof out.citizen === "boolean") p.citizen = out.citizen;
  if (out.visaType && out.citizen === false) p.visaType = String(out.visaType).slice(0, 80);
  if (pick(out.sponsorship, o.sponsorship) && out.citizen === false) p.sponsorship = pick(out.sponsorship, o.sponsorship);
  const langs = (Array.isArray(out.languages) ? out.languages : []).map((l: any) => ({ language: pick(l?.language, o.languages), level: pick(l?.level, o.langLevels) })).filter((l: any) => l.language);
  if (langs.length) p.languages = langs.slice(0, 8);
  if (pick(out.availability, o.availability)) p.availability = pick(out.availability, o.availability);
  if (many(out.industries, o.industries).length) p.industries = many(out.industries, o.industries);
  return p;
}
