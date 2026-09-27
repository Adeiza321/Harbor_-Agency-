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

// Manually reviewed candidates are locked (candidates.ai_locked). The database also
// refuses AI writes to them, but checking here gives the recruiter a clear message.
export const LOCKED_MSG = "This candidate's review is locked because it was manually reviewed. Unlock it before re-running AI.";

// Shared scoring rules: every AI judgement checks the candidate against the job
// description requirement by requirement, instead of giving an overall impression.
export const RUBRIC =
  "HOW TO SCORE — follow these steps strictly. " +
  "1) Read the job description and list EVERY requirement it states. Mark each 'must' (required, 'must have', minimum years, required degree, licence or certification, and the named experience areas the role requires) or 'preferred' (anything described as 'a plus', 'preferred' or 'nice to have'). " +
  "2) For each requirement decide 'met', 'partial' or 'not met'. Only mark 'met' when the CV or the candidate's answers describe actual work performed that shows it: a role, a responsibility, a project, or an answer with specifics. A word that only appears in a skills or keywords list, a headline or a summary, without described work, is NOT evidence: mark it 'partial' at most. " +
  "3) Quantities matter. When the job asks for a number of years, or for 'significant' experience in something (a type of firm, a function), count the dated time the CV actually shows in that thing. Undated or very short exposure is 'partial', not 'met'. Separately, never penalise someone for changing jobs often or for short stays in general; only measure the experience the job asks for. " +
  "4) Score from the checklist, not from overall impression: start at 100; for each must-have 'not met' subtract 10-15; for each must-have 'partial' subtract 5-8; for each preferred item not met subtract 2-3. If a required licence, certification, degree or work authorisation is not met, the score must be 45 or lower and the verdict must be the rejection option. " +
  "5) 'Perfect fit' ONLY when every must-have is 'met'. Any must-have that is 'partial' or 'not met' means 'Possible fit' at best. Scores of 90 or more are for candidates who meet every must-have and most preferred items, and should be rare. " +
  "6) 'gaps' must name every must-have that is 'not met' or 'partial', most important first. List must-have gaps before any preferred gap, and end every gap about a preferred item with ' (nice to have)'. 'strengths' must only list things backed by described work. Be accurate and specific; never pad strengths. " +
  "7) Preferred items are never a reason to reject. A candidate who has no must-have marked 'not met' must NOT get the rejection verdict, however many preferred items they lack; missing preferred items only lower the score slightly. " +
  "8) 'verdict_reason': 1-2 short sentences explaining the verdict by naming the specific must-have requirements that decided it (e.g. 'Meets every must-have: active CPA, 10 yrs Big 4, SEC reporting, ASC 606/718.' or 'Rejected: no active CPA, which the role requires.'). Never give a preferred item as the reason for a rejection. ";

// Hard guard on the model's own checklist: a verdict or score can't claim more
// than the requirements it marked support.
export function enforceChecklist(reqs: unknown, score: number, verdict: string, perfect: string, possible: string, reject = "") {
  const list = Array.isArray(reqs) ? reqs : [];
  const must = list.filter((r: any) => String(r?.type || "").toLowerCase() === "must");
  const notMet = must.filter((r: any) => String(r?.status || "").toLowerCase() === "not met").length;
  const partial = must.filter((r: any) => String(r?.status || "").toLowerCase() === "partial").length;
  let s = score, v = verdict;
  if (notMet) s = Math.min(s, 75);
  else if (partial) s = Math.min(s, 85);
  if ((notMet || partial) && v === perfect) v = possible;
  // Preferred items can never reject a candidate: with every must-have at least
  // partly met, a rejection becomes "possible fit" and the score keeps a floor.
  if (reject && must.length && !notMet && v === reject) { v = possible; s = Math.max(s, 60); }
  return { score: s, verdict: v, notMet, partial };
}
export const cleanReqs = (reqs: unknown) => (Array.isArray(reqs) ? reqs : []).slice(0, 25).map((r: any) => ({
  requirement: String(r?.requirement || "").slice(0, 160),
  type: String(r?.type || "").toLowerCase() === "must" ? "must" : "preferred",
  status: ["met", "partial", "not met"].includes(String(r?.status || "").toLowerCase()) ? String(r.status).toLowerCase() : "partial",
  evidence: String(r?.evidence || "").slice(0, 240),
}));
const REQS_SHAPE = `"requirements": [{"requirement": string, "type": "must" | "preferred", "status": "met" | "partial" | "not met", "evidence": string}]`;
export { REQS_SHAPE };


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
  if (candidate.ai_locked) throw new Error(LOCKED_MSG);
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
  const keepFollowups = f && (f.state === "sent" || f.state === "answered" || f.manual);
  const mayAsk = !keepFollowups;

  const system =
    "You are a recruitment analyst screening one candidate for one job. You get their CV (attached, or as extracted text) and everything they have answered so far: " +
    "this job's application questions, any follow-up questions, and answers they gave while being screened for other jobs. Use ALL of it — e.g. a salary or notice period they gave for another job still applies. " +
    "Reply with STRICT JSON only: " +
    `{${REQS_SHAPE}, "summary": string, "strengths": string[], "gaps": string[], "score": number (0-100), "verdict": "Perfect fit" | "Possible fit" | "Reject", "verdict_reason": string, "salary_expectation": string, "questions": string[]}. ` +
    RUBRIC +
    "Judge ONLY on: (1) the requirement checklist above, from the CV and anything the answers add; " +
    "(2) salary expectation vs budget — be flexible, only count it against them if clearly and substantially over; (3) availability vs the role's timeline. " +
    "If an answer contradicts the CV, list it in gaps. " +
    "summary: 2-3 sentences a recruiter reads first; mention the most important unmet must-have if there is one. strengths and gaps: at most 6 each, a few words each. requirements: the checklist from step 1-2, evidence in a few words. " +
    "verdict: 'Perfect fit' = every must-have met (step 5); 'Possible fit' = promising but at least one must-have partial or not met, or open questions; 'Reject' = missing a hard requirement or several core requirements, or clearly incompatible. " +
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

  const result = await askAI(system, content, resume, 2500);
  const checked = enforceChecklist(result.requirements, clampScore(result.score), normalizeVerdict(result.verdict), "Perfect fit", "Possible fit", "Reject");
  const verdict = checked.verdict;
  const score = checked.score;
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
    verdict_reason: String(result.verdict_reason || "").slice(0, 400),
    requirements: cleanReqs(result.requirements),
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

// ---------------------------------------------------------------------------
// Match review: a candidate against a role they are NOT on yet. Uses the resume and
// every answer they have given for any job, returns the checklist, a short summary and
// questions that would confirm the fit. Questions already answered are flagged, never
// silently dropped, so the recruiter can see what's covered.
// The result is saved on the candidate's matches entry for that job (candidates.matches).
// ---------------------------------------------------------------------------
export async function reviewMatch(admin: any, candidateId: string, jobId: string, askAI: Ask, loadResume: Load) {
  const { data: candidate } = await admin.from("candidates").select("*").eq("id", candidateId).single();
  if (!candidate) throw new Error("Candidate not found");
  const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).single();
  if (!job) throw new Error("This job no longer exists");
  const { data: allLinks } = await admin.from("candidate_jobs").select("*").eq("candidate_id", candidateId);
  const links: any[] = allLinks || [];
  const { data: jobs } = links.length ? await admin.from("jobs").select("*").in("id", [...new Set(links.map((l) => l.job_id))]) : { data: [] };
  const jobOf = (id: string) => (jobs || []).find((j: any) => j.id === id);
  const answered = links.flatMap((l) => {
    const j = jobOf(l.job_id);
    return answersOn(l, j).map((x) => ({ ...x, where: j ? `${j.role_title} at ${j.client}` : "another role" }));
  });
  const { resume } = await loadResume(admin, candidate);

  const system =
    "You are a recruitment analyst checking whether a candidate already in the database is a fit for a NEW role they have not been put forward for. " +
    "You get their CV and every answer they have given while being screened for other roles. Reply with STRICT JSON only: " +
    `{${REQS_SHAPE}, "summary": string, "score": number (0-100), "verdict": "Perfect fit" | "Possible fit" | "Reject", "verdict_reason": string, ` +
    `"questions": [{"q": string, "already_answered": boolean, "answer": string}]}. ` +
    RUBRIC +
    "summary: 2-3 sentences on how they fit THIS role, naming the most important must-have that is still unproven. " +
    "questions: 3 to 6 short questions (under 30 words each) that would confirm the fit for THIS role, most important first, aimed at must-haves marked 'partial' or 'not met' and at anything this role needs that earlier answers don't cover. " +
    "For each question, if the candidate has ALREADY answered it (or something that settles it) in the answers provided, set already_answered true and put a one-sentence summary of what they said in 'answer'; otherwise already_answered false and answer ''. " +
    "Include salary, start date or work authorisation only if they have not already answered it.";
  const content =
    jobText(job) + "\n\n" +
    (resume ? "The candidate's CV is included.\n" : `No readable CV on file. Known skills: ${(candidate.skills || []).join(", ") || "not yet known"}.\n`) +
    `\nEverything they have answered so far:\n${answered.length ? answered.map((x) => `Q: ${x.q}\nA: ${x.a}\n(answered for ${x.where})`).join("\n\n") : "(nothing yet)"}`;

  const result = await askAI(system, content, resume, 3000);
  const checked = enforceChecklist(result.requirements, clampScore(result.score), normalizeVerdict(result.verdict), "Perfect fit", "Possible fit", "Reject");
  const review = {
    job_id: job.id,
    role: job.role_title,
    company: job.client,
    fit: checked.score,
    verdict: checked.verdict,
    verdict_reason: String(result.verdict_reason || "").slice(0, 400),
    summary: String(result.summary || "").slice(0, 1200),
    requirements: cleanReqs(result.requirements),
    questions: (Array.isArray(result.questions) ? result.questions : []).slice(0, 6).map((x: any) => ({
      q: String(x?.q || "").slice(0, 300),
      already_answered: !!x?.already_answered,
      answer: String(x?.answer || "").slice(0, 400),
    })).filter((x: any) => x.q),
    usedResume: !!resume,
    answersUsed: answered.length,
    reviewedAt: new Date().toISOString(),
  };
  // Replace this job's entry in the candidate's match list (not a locked review field).
  const others = (Array.isArray(candidate.matches) ? candidate.matches : []).filter((m: any) => m?.job_id !== job.id);
  await admin.from("candidates").update({ matches: [...others, review] }).eq("id", candidateId);
  return { review, answered };
}
