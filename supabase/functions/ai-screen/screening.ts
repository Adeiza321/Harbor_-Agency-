// Per-company screening cards (candidate_jobs.ai).
//
// One card per job the candidate is on. Each screening uses:
//   - the resume (any format, see resume.ts)
//   - this job's application questions and the candidate's answers to them
//   - approved follow-up questions and the candidate's answers (from their candidate page)
//   - everything the candidate has answered for OTHER jobs (salary, notice, skills they described)
// The AI never asks a question that was already asked for any job, or anything already answered.
// A rescreen replaces the previous result. Salary expectation found in answers goes to candidates.pay.

import type { ResumeInput } from "./resume.ts";

type Ask = (system: string, text: string, resume: ResumeInput | null, maxTokens: number) => Promise<any>;
type Load = (admin: any, candidate: any) => Promise<{ resume: ResumeInput | null; why?: string }>;

export const VERDICTS = ["Perfect fit", "Possible fit", "Reject"];

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const clampScore = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export function normalizeVerdict(v: unknown): string {
  const s = String(v || "").toLowerCase();
  if (s.includes("perfect")) return "Perfect fit";
  if (s.includes("reject") || s.includes("not a fit") || s.includes("not fit")) return "Reject";
  return "Possible fit";
}

// Q&A the candidate has given on one job card.
export function answersOn(link: any, job: any): { q: string; a: string; kind: string }[] {
  const out: { q: string; a: string; kind: string }[] = [];
  const qs: string[] = Array.isArray(job?.screening_questions) ? job.screening_questions : [];
  const answers: any[] = Array.isArray(link.screening_answers) ? link.screening_answers : [];
  answers.forEach((a, i) => {
    const q = typeof a === "object" && a ? a.q : qs[i];
    const ans = typeof a === "object" && a ? a.a : a;
    if (q && ans && String(ans).trim()) out.push({ q, a: String(ans).trim(), kind: "application" });
  });
  const f = link.ai?.followups;
  if (f?.state === "answered") {
    for (const x of f.questions || []) if (x?.q && x?.a && String(x.a).trim()) out.push({ q: x.q, a: String(x.a).trim(), kind: "follow-up" });
    if (f.reply && String(f.reply).trim()) out.push({ q: (f.questions || []).map((x: any) => x.q).join(" / ") || "Screening reply", a: String(f.reply).trim(), kind: "follow-up" });
  }
  return out;
}

// Every question ever put to this candidate (application questions of their jobs + sent follow-ups).
export function askedQuestions(links: any[], jobOf: (id: string) => any): string[] {
  const out: string[] = [];
  for (const l of links) {
    const j = jobOf(l.job_id);
    for (const q of j?.screening_questions || []) if (q) out.push(String(q));
    const f = l.ai?.followups;
    if (f && f.state !== "draft") for (const x of f.questions || []) if (x?.q) out.push(String(x.q));
  }
  return out;
}

// Topics that must never be asked twice, however the question is worded.
const TOPICS: RegExp[] = [
  /salar|compensation|remuneration|expected pay|pay expectation|how much .*(earn|paid)|rate per|day rate|hourly rate/,
  /notice period|notice|start date|when .*start|earliest .*(start|join)|available to (start|join)|availability/,
  /relocat/,
  /visa|sponsorship|right to work|work permit/,
  /remote|hybrid|on.?site|office/,
];
const topicOf = (s: string) => TOPICS.findIndex((re) => re.test(norm(s)));

export function dedupeQuestions(proposed: unknown, asked: string[], limit = 3): string[] {
  const seen = new Set(asked.map(norm));
  const topics = new Set(asked.map(topicOf).filter((t) => t >= 0));
  const out: string[] = [];
  for (const q of Array.isArray(proposed) ? proposed : []) {
    const s = String(q || "").trim();
    const n = norm(s);
    const t = topicOf(s);
    if (!s || seen.has(n) || (t >= 0 && topics.has(t))) continue;
    seen.add(n);
    if (t >= 0) topics.add(t);
    out.push(s.slice(0, 300));
    if (out.length >= limit) break;
  }
  return out;
}

const jobText = (job: any) =>
  `Job: ${job.role_title} at ${job.client}.\nDescription:\n${job.description || "(no description given)"}\n` +
  `Salary range: ${job.min_pay || "?"} - ${job.max_pay || "?"} ${job.currency || "NGN"}/year.` +
  (job.location ? `\nLocation: ${job.location}` : "") + (job.country ? `\nHiring country: ${job.country}` : "");

export async function screenLink(admin: any, linkId: string, askAI: Ask, loadResume: Load) {
  const { data: link } = await admin.from("candidate_jobs").select("*").eq("id", linkId).single();
  if (!link) throw new Error("Screening card not found");
  const { data: candidate } = await admin.from("candidates").select("*").eq("id", link.candidate_id).single();
  if (!candidate) throw new Error("Candidate not found");
  const { data: allLinks } = await admin.from("candidate_jobs").select("*").eq("candidate_id", link.candidate_id);
  const links: any[] = allLinks || [link];
  const { data: jobs } = await admin.from("jobs").select("*").in("id", [...new Set(links.map((l) => l.job_id))]);
  const jobOf = (id: string) => (jobs || []).find((j: any) => j.id === id);
  const job = jobOf(link.job_id);
  if (!job) throw new Error("This job no longer exists");

  const { resume } = await loadResume(admin, candidate);
  const here = answersOn(link, job);
  const elsewhere = links.filter((l) => l.id !== link.id).flatMap((l) => {
    const j = jobOf(l.job_id);
    return answersOn(l, j).map((x) => ({ ...x, where: j ? `${j.role_title} at ${j.client}` : "another role" }));
  });
  const asked = askedQuestions(links, jobOf);

  const f = link.ai?.followups;
  const final = f?.state === "answered";
  const keepFollowups = f && (f.state === "sent" || f.state === "answered");
  const mayAsk = !keepFollowups;

  const system =
    "You are a recruitment analyst screening one candidate for one job. You get their CV (attached, or as extracted text) and everything they have answered so far: " +
    "this job's application questions, any follow-up questions, and answers they gave while being screened for other jobs. Use ALL of it — e.g. a salary or notice period they gave for another job still applies. " +
    "Reply with STRICT JSON only: " +
    `{"summary": string, "strengths": string[], "gaps": string[], "score": number (0-100), "verdict": "Perfect fit" | "Possible fit" | "Reject", "salary_expectation": string, "questions": string[]}. ` +
    "Judge ONLY on: (1) skills and experience vs the job's stated requirements, from the CV and anything the answers add — never on how long they stayed in past roles; " +
    "(2) salary expectation vs budget — be flexible, only count it against them if clearly and substantially over; (3) availability vs the role's timeline. " +
    "If an answer contradicts the CV, list it in gaps. " +
    "summary: 2-3 sentences a recruiter reads first. strengths and gaps: at most 4 each, a few words each. " +
    "verdict: 'Perfect fit' = meets essentially all key requirements with no real concerns; 'Possible fit' = promising but partial or with open questions; 'Reject' = clearly missing core requirements or clearly incompatible. " +
    "salary_expectation: the salary the candidate themselves said they expect, as they stated it (keep amount, currency and period), taken from their answers; '' if they never stated one. " +
    (mayAsk
      ? "questions: up to 3 short follow-up questions (under 25 words each) that would settle the most important open points for THIS job. NEVER repeat or rephrase anything in the 'Already asked' list, and never ask for something already answered anywhere in the material (e.g. no salary question if they already gave a salary). If nothing important is unclear, or the verdict is Reject, return []."
      : "questions: always [].") +
    (final ? " This is the final screening, after the candidate answered the follow-up questions." : "");

  const fmt = (xs: { q: string; a: string; where?: string }[]) =>
    xs.map((x) => `Q: ${x.q}\nA: ${x.a}` + (x.where ? `\n(answered for ${x.where})` : "")).join("\n\n");
  const content =
    jobText(job) + "\n\n" +
    (resume ? "The candidate's CV is included.\n" : `No readable CV on file. Known skills: ${(candidate.skills || []).join(", ") || "not yet known"}.\n`) +
    `\nAnswers for this job:\n${here.length ? fmt(here) : "(none yet)"}\n` +
    `\nAnswers given for other jobs:\n${elsewhere.length ? fmt(elsewhere) : "(none)"}\n` +
    `\nAlready asked (never ask these again):\n${asked.length ? asked.map((q) => "- " + q).join("\n") : "(nothing yet)"}`;

  const result = await askAI(system, content, resume, 1200);
  const verdict = normalizeVerdict(result.verdict);
  const score = clampScore(result.score);
  const questions = mayAsk && verdict !== "Reject" ? dedupeQuestions(result.questions, asked) : [];

  const followups = keepFollowups
    ? f
    : questions.length ? { state: "draft", questions: questions.map((q) => ({ q })) } : null;

  const ai = {
    stage: final ? "final" : "first",
    summary: String(result.summary || "").slice(0, 1200),
    strengths: (Array.isArray(result.strengths) ? result.strengths : []).slice(0, 6).map((s: unknown) => String(s).slice(0, 160)),
    gaps: (Array.isArray(result.gaps) ? result.gaps : []).slice(0, 6).map((s: unknown) => String(s).slice(0, 160)),
    score,
    verdict,
    usedResume: !!resume,
    answersUsed: here.length + elsewhere.length,
    updatedAt: new Date().toISOString(),
    followups,
  };
  await admin.from("candidate_jobs").update({ ai, fit: score }).eq("id", link.id);

  const salary = String(result.salary_expectation || "").trim();
  if (salary && salary !== "-") await admin.from("candidates").update({ pay: salary.slice(0, 120) }).eq("id", candidate.id);
  return ai;
}
