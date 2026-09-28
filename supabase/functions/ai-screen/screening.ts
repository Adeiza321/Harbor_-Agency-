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
import { lookupIndustries, industryText } from "./industry.ts";

type Ask = (system: string, text: string, resume: ResumeInput | null, maxTokens: number) => Promise<any>;
type Load = (admin: any, candidate: any) => Promise<{ resume: ResumeInput | null; why?: string }>;

export const VERDICTS = ["Perfect fit", "Possible fit", "Possible reject", "Reject"];
// Nobody is fully rejected before they've answered screening questions for the job: a would-be
// rejection becomes "Possible reject", with follow-up questions drafted to settle it.
export const softenReject = (verdict: string, hasAnswers: boolean) => (verdict === "Reject" && !hasAnswers ? "Possible reject" : verdict);

// Manually reviewed candidates are locked (candidates.ai_locked). The database also
// refuses AI writes to them, but checking here gives the recruiter a clear message.
export const LOCKED_MSG = "This candidate's review is locked because it was manually reviewed. Unlock it before re-running AI.";

// Shared scoring rules: every AI judgement checks the candidate against the job
// description requirement by requirement, instead of giving an overall impression.
export const RUBRIC =
  "HOW TO SCORE — follow these steps strictly. " +
  "1) Read the job description and list EVERY requirement it states. Mark each 'must' (required, 'must have', minimum years, required degree, licence or certification, and the named experience areas the role requires) or 'preferred' (anything described as 'a plus', 'preferred' or 'nice to have'). " +
  "Split combined requirements into separate lines: 'ASC 606, 718 and 842' is three lines, and '8+ years including significant Big 4' is two (the years, and the Big 4). Never let one part being met carry another. " +
  "Screening notes or distinctions in the job description (e.g. which kind of experience does or does not count) are binding: apply them exactly. " +
  "2) For each requirement decide 'met', 'partial' or 'not met'. Only mark 'met' when the CV or the candidate's answers describe actual work performed that shows it: a role, a responsibility, a project, or an answer with specifics. A word that only appears in a skills or keywords list, a headline or a professional summary, without a role that describes the work, is NOT evidence: mark it 'not met' if nothing else supports it, 'partial' at most. " +
  "3) Quantities matter. When the job asks for a number of years, or for 'significant' experience in something (a type of firm, a function), count the dated time the CV actually shows in that thing. Undated or very short exposure is 'partial', not 'met'. Separately, never penalise someone for changing jobs often or for short stays in general; only measure the experience the job asks for. " +
  "4) Score from the checklist, not from overall impression: start at 100; for each must-have 'not met' subtract 10-15; for each must-have 'partial' subtract 5-8; for each preferred item not met subtract 2-3. If a required licence, certification, degree or work authorisation is not met, the score must be 45 or lower and the verdict must be the rejection option. " +
  "5) 'Perfect fit' ONLY when every must-have is 'met'. Any must-have that is 'partial' or 'not met' means 'Possible fit' at best. Scores of 90 or more are for candidates who meet every must-have and most preferred items, and should be rare. " +
  "6) 'gaps' must name every must-have that is 'not met' or 'partial', most important first. List must-have gaps before any preferred gap, and end every gap about a preferred item with ' (nice to have)'. 'strengths' must only list things backed by described work. Be accurate and specific; never pad strengths. " +
  "7) Preferred items are never a reason to reject. A candidate who has no must-have marked 'not met' must NOT get the rejection verdict, however many preferred items they lack; missing preferred items only lower the score slightly. " +
  "8) Industry alignment: compare the candidate's industry experience (from the looked-up employer list when given, otherwise the CV) with the industry the job asks for. It counts exactly as the job description ranks it (must or preferred). An employer marked 'unsure' is unknown industry: never count it as a match. " +
  "9) If the candidate's current or most recent role is outside the field the job needs, say so in 'gaps'. " +
  "10) Location and work setup are a must-have line of their own. Onsite or hybrid: the candidate must be based in or near the job's location, or have said in their answers that they will relocate. Remote: they must be in the hiring country (or the time zone the job asks for). Use the candidate's stated location; if it isn't known, mark the line 'partial', never 'met'. Seniority counts too: a candidate clearly more junior or far more senior than the role is a gap. " +
  "11) 'verdict_reason': 1-2 short sentences explaining the verdict by naming the specific must-have requirements that decided it (e.g. 'Meets every must-have: active CPA, 10 yrs Big 4, SEC reporting, ASC 606/718.' or 'Rejected: no active CPA, which the role requires.'). Never give a preferred item as the reason for a rejection. ";

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

// Parallel titles: other standard job titles this person could credibly be hired into now,
// judged on the whole CV (function, seniority, industry, location). Stored on the candidate so
// a bench check for a new job only looks at people whose titles match it.
export const PARALLEL_RULE =
  "'parallel_titles': 4 to 8 standard job titles (the way employers post them, e.g. 'Technical Accounting Manager', 'SEC Reporting Manager') this person could credibly be hired into NOW, " +
  "based on the work their CV actually shows: same function or a close neighbour, at their real seniority (one level up or down at most). Include their current title. Never list titles the CV doesn't support. ";
export const cleanTitles = (t: unknown) =>
  [...new Set((Array.isArray(t) ? t : []).map((x) => String(x || "").trim().replace(/\s+/g, " ")).filter((x) => x.length > 2 && x.length < 90))].slice(0, 8);

// Title matching: the job's function words must be covered by one of the person's titles.
// Seniority words don't have to match exactly; generic role nouns alone never count as a match.
const TITLE_ABBR: Record<string, string> = { sr: "senior", jr: "junior", mgr: "manager", vp: "vice president", acct: "accounting", eng: "engineer", dev: "developer", ops: "operations", hr: "human resources", fp: "fp&a", svp: "senior vice president", avp: "assistant vice president" };
const LEVEL = new Set(["senior", "junior", "lead", "principal", "head", "associate", "assistant", "staff", "chief", "deputy", "i", "ii", "iii", "iv", "entry", "level", "graduate", "trainee", "intern", "vice", "president", "executive"]);
const ROLE_NOUN = new Set(["manager", "director", "analyst", "specialist", "officer", "consultant", "coordinator", "supervisor", "administrator", "representative", "associate", "partner", "advisor", "adviser", "controller", "accountant", "engineer", "developer"]);
const titleWords = (t: string) => String(t || "").toLowerCase().replace(/[^a-z0-9&+ ]+/g, " ").split(/\s+/).filter(Boolean)
  .flatMap((w) => (TITLE_ABBR[w] || w).split(" ")).filter((w) => !["of", "and", "the", "for", "to", "in", "&"].includes(w));
export function titleScore(jobTitle: string, titles: string[]): number {
  const job = titleWords(jobTitle).filter((w) => !LEVEL.has(w));
  if (!job.length) return 0;
  const domain = job.filter((w) => !ROLE_NOUN.has(w));
  let best = 0;
  for (const t of titles) {
    const tw = new Set(titleWords(t));
    const shared = job.filter((w) => tw.has(w)).length;
    if (domain.length && !domain.some((w) => tw.has(w))) continue; // e.g. only "manager" in common
    best = Math.max(best, shared / job.length);
  }
  return best;
}


const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const clampScore = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export function normalizeVerdict(v: unknown): string {
  const s = String(v || "").toLowerCase();
  if (s.includes("perfect")) return "Perfect fit";
  if (s.includes("possible reject")) return "Possible reject";
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

// Content words of a question, for spotting the same question asked in other words.
const QSTOP = new Set(["what", "your", "have", "does", "with", "that", "this", "about", "would", "could", "please", "describe", "tell", "much", "many", "which", "when", "where", "there", "their", "they", "been", "were", "will", "from", "into", "experience", "years", "role", "work", "worked", "working", "currently", "any", "you", "the", "and", "for", "are", "can", "did", "how", "long", "give", "example", "examples", "share"]);
const qWords = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !QSTOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "")));
export function sameQuestion(a: string, b: string) {
  const x = qWords(a), y = qWords(b);
  if (!x.size || !y.size) return false;
  let shared = 0; x.forEach((w) => { if (y.has(w)) shared++; });
  return shared >= 2 && shared / Math.min(x.size, y.size) >= 0.6;
}

export function dedupeQuestions(proposed: unknown, asked: string[], limit = 3): string[] {
  const seen = new Set(asked.map(norm));
  const topics = new Set(asked.map(topicOf).filter((t) => t >= 0));
  const out: string[] = [];
  for (const q of Array.isArray(proposed) ? proposed : []) {
    const s = String(q || "").trim();
    const n = norm(s);
    const t = topicOf(s);
    if (!s || seen.has(n) || (t >= 0 && topics.has(t))) continue;
    if (asked.some((a) => sameQuestion(s, a)) || out.some((a) => sameQuestion(s, a))) continue; // same question, other words
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
  (job.location ? `\nLocation: ${job.location}` : "") + (job.country ? `\nHiring country: ${job.country}` : "") +
  (job.work_setup ? `\nWork setup: ${job.work_setup}` : "") + (job.employment_type ? `\nEmployment type: ${job.employment_type}` : "");

// What the profile says about the candidate outside the CV (location, notice, pay).
const candidateFacts = (c: any) =>
  `Candidate's stated location: ${c.location || "not given"}. Notice period: ${c.notice && c.notice !== "-" ? c.notice : "not given"}. Salary expectation: ${c.pay && c.pay !== "-" ? c.pay : "not given"}.`;

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
  const industries = await ensureIndustries(admin, candidate, resume);
  const here = answersOn(link, job);
  const elsewhere = links.filter((l) => l.id !== link.id).flatMap((l) => {
    const j = jobOf(l.job_id);
    return answersOn(l, j).map((x) => ({ ...x, where: j ? `${j.role_title} at ${j.client}` : "another role" }));
  });
  const asked = askedQuestions(links, jobOf);

  const jobQs: string[] = (Array.isArray(job.screening_questions) ? job.screening_questions : []).filter(Boolean).map(String);
  const noAnswers = here.length === 0;
  const f = link.ai?.followups;
  const final = f?.state === "answered";
  const keepFollowups = f && (f.state === "sent" || f.state === "answered" || f.manual);
  const mayAsk = !keepFollowups;

  const system =
    "You are a recruitment analyst screening one candidate for one job. You get their CV (attached, or as extracted text) and everything they have answered so far: " +
    "this job's application questions, any follow-up questions, and answers they gave while being screened for other jobs. Use ALL of it — e.g. a salary or notice period they gave for another job still applies. " +
    "Reply with STRICT JSON only: " +
    `{${REQS_SHAPE}, "summary": string, "strengths": string[], "gaps": string[], "score": number (0-100), "verdict": "Perfect fit" | "Possible fit" | "Reject", "verdict_reason": string, "salary_expectation": string, "parallel_titles": string[], "questions": string[]}. ` +
    PARALLEL_RULE +
    RUBRIC +
    "Judge ONLY on: (1) the requirement checklist above, from the CV and anything the answers add; " +
    "(2) salary expectation vs budget — be flexible, only count it against them if clearly and substantially over; (3) availability vs the role's timeline. " +
    "If an answer contradicts the CV, list it in gaps. " +
    "summary: 2-3 sentences a recruiter reads first; mention the most important unmet must-have if there is one. strengths and gaps: at most 6 each, a few words each. requirements: the checklist from step 1-2, evidence in a few words. " +
    "verdict: 'Perfect fit' = every must-have met (step 5); 'Possible fit' = promising but at least one must-have partial or not met, or open questions; 'Reject' = missing a hard requirement or several core requirements, or clearly incompatible. " +
    "salary_expectation: the salary the candidate themselves said they expect, as they stated it (keep amount, currency and period), taken from their answers; '' if they never stated one. " +
    (mayAsk
      ? "questions: up to 3 short follow-up questions (under 25 words each) that would settle the most important open points for THIS job. NEVER repeat or rephrase anything in the 'Already asked' list or in this job's own screening questions, and never ask for something already answered anywhere in the material (e.g. no salary question if they already gave a salary). " +
        (noAnswers
          ? "The candidate has NOT answered any screening questions for this job yet, so they can't be finally rejected: always give up to 3 questions aimed at the must-haves you marked 'not met' or 'partial', so the recruiter can screen them before deciding."
          : "If nothing important is unclear, or the verdict is Reject, return [].")
      : "questions: always [].") +
    (final ? " This is the final screening, after the candidate answered the follow-up questions." : "");

  const fmt = (xs: { q: string; a: string; where?: string }[]) =>
    xs.map((x) => `Q: ${x.q}\nA: ${x.a}` + (x.where ? `\n(answered for ${x.where})` : "")).join("\n\n");
  const content =
    jobText(job) + "\n\n" +
    (resume ? "The candidate's CV is included.\n" : `No readable CV on file. Known skills: ${(candidate.skills || []).join(", ") || "not yet known"}.\n`) +
    candidateFacts(candidate) + "\n" +
    industryText(industries) + "\n" +
    `\nAnswers for this job:\n${here.length ? fmt(here) : "(none yet)"}\n` +
    `\nAnswers given for other jobs:\n${elsewhere.length ? fmt(elsewhere) : "(none)"}\n` +
    `\nThis job's own screening questions (never repeat or rephrase):\n${jobQs.length ? jobQs.map((q) => "- " + q).join("\n") : "(none)"}\n` +
    `\nAlready asked (never ask these again):\n${asked.length ? asked.map((q) => "- " + q).join("\n") : "(nothing yet)"}`;

  const result = await askAI(system, content, resume, 2500);
  const checked = enforceChecklist(result.requirements, clampScore(result.score), normalizeVerdict(result.verdict), "Perfect fit", "Possible fit", "Reject");
  const verdict = softenReject(checked.verdict, !noAnswers);
  const score = checked.score;
  const questions = mayAsk && verdict !== "Reject" ? dedupeQuestions(result.questions, [...asked, ...jobQs]) : [];

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

  // The candidate's main AI score follows their latest screening, so a rescreen shows everywhere.
  const cpatch: Record<string, unknown> = { ai_score: score };
  const titles = cleanTitles(result.parallel_titles);
  if (titles.length) { cpatch.parallel_titles = titles; cpatch.parallel_titles_at = new Date().toISOString(); }
  const salary = String(result.salary_expectation || "").trim();
  if (salary && salary !== "-") cpatch.pay = salary.slice(0, 120);
  await admin.from("candidates").update(cpatch).eq("id", candidate.id);
  return ai;
}

// ---------------------------------------------------------------------------
// Match review: a candidate against a role they are NOT on yet. Uses the resume and
// every answer they have given for any job, returns the checklist, a short summary and
// questions that would confirm the fit. Questions already answered are flagged, never
// silently dropped, so the recruiter can see what's covered.
// The result is saved on the candidate's matches entry for that job (candidates.matches).
// ---------------------------------------------------------------------------
export async function reviewMatch(admin: any, candidateId: string, jobId: string, askAI: Ask, loadResume: Load, opts: { skipLookup?: boolean } = {}) {
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
  // Bench checks review several people at once, so they use employer lookups already on file.
  const industries = opts.skipLookup ? (Array.isArray(candidate.industries) ? candidate.industries : []) : await ensureIndustries(admin, candidate, resume);

  const system =
    "You are a recruitment analyst checking whether a candidate already in the database is a fit for a NEW role they have not been put forward for. " +
    "You get their CV and every answer they have given while being screened for other roles. Reply with STRICT JSON only: " +
    `{${REQS_SHAPE}, "summary": string, "score": number (0-100), "verdict": "Perfect fit" | "Possible fit" | "Reject", "verdict_reason": string, ` +
    `"questions": [{"q": string, "already_answered": boolean, "answer": string}]}. ` +
    RUBRIC +
    "Judge the whole person against the whole role: location and work setup, seniority and years, skills, industry and every stated requirement. Being available is not a reason to call someone a fit. " +
    "summary: 2-3 sentences on how they fit THIS role, naming the most important must-have that is still unproven. " +
    "questions: 3 to 6 short questions (under 30 words each) that would confirm the fit for THIS role, most important first, aimed at must-haves marked 'partial' or 'not met' and at anything this role needs that earlier answers don't cover. " +
    "For each question, if the candidate has ALREADY answered it (or something that settles it) in the answers provided, set already_answered true and put a one-sentence summary of what they said in 'answer'; otherwise already_answered false and answer ''. " +
    "Include salary, start date or work authorisation only if they have not already answered it. " +
    "Never repeat or rephrase any of this job's own screening questions (listed below): they are asked separately.";
  const jobQs: string[] = (Array.isArray(job.screening_questions) ? job.screening_questions : []).filter(Boolean).map(String);
  const content =
    jobText(job) + "\n\n" +
    `This job's own screening questions (never repeat or rephrase):\n${jobQs.length ? jobQs.map((q) => "- " + q).join("\n") : "(none)"}\n\n` +
    (resume ? "The candidate's CV is included.\n" : `No readable CV on file. Known skills: ${(candidate.skills || []).join(", ") || "not yet known"}.\n`) +
    candidateFacts(candidate) + "\n" +
    industryText(industries) + "\n" +
    `\nEverything they have answered so far:\n${answered.length ? answered.map((x) => `Q: ${x.q}\nA: ${x.a}\n(answered for ${x.where})`).join("\n\n") : "(nothing yet)"}`;

  const result = await askAI(system, content, resume, 3000);
  const checked = enforceChecklist(result.requirements, clampScore(result.score), normalizeVerdict(result.verdict), "Perfect fit", "Possible fit", "Reject");
  // Nobody has answered this new job's screening questions yet, so a rejection stays "possible".
  const answeredHere = links.some((l) => l.job_id === job.id && answersOn(l, job).length > 0);
  const review = {
    job_id: job.id,
    role: job.role_title,
    company: job.client,
    fit: checked.score,
    verdict: softenReject(checked.verdict, answeredHere),
    verdict_reason: String(result.verdict_reason || "").slice(0, 400),
    summary: String(result.summary || "").slice(0, 1200),
    requirements: cleanReqs(result.requirements),
    questions: (Array.isArray(result.questions) ? result.questions : []).slice(0, 6).map((x: any) => ({
      q: String(x?.q || "").slice(0, 300),
      already_answered: !!x?.already_answered,
      answer: String(x?.answer || "").slice(0, 400),
    })).filter((x: any) => x.q && !jobQs.some((j) => norm(j) === norm(x.q) || sameQuestion(j, x.q))),
    usedResume: !!resume,
    answersUsed: answered.length,
    reviewedAt: new Date().toISOString(),
  };
  // Replace this job's entry in the candidate's match list (not a locked review field).
  const others = (Array.isArray(candidate.matches) ? candidate.matches : []).filter((m: any) => m?.job_id !== job.id);
  await admin.from("candidates").update({ matches: [...others, review] }).eq("id", candidateId);
  return { review, answered };
}

// Looks up the candidate's employers once (when nothing is on file yet) and saves the list.
// Industries aren't a locked review field: they're facts about employers, so they're filled
// even for manually reviewed candidates.
export async function ensureIndustries(admin: any, candidate: any, resume: ResumeInput | null) {
  if (Array.isArray(candidate.industries) && candidate.industries.length) return candidate.industries;
  if (!resume) return [];
  const { items, error } = await lookupIndustries(resume);
  if (error) console.error("industries", candidate.id, error);
  if (items.length) await admin.from("candidates").update({ industries: items, industries_checked_at: new Date().toISOString() }).eq("id", candidate.id);
  return items;
}

// ---------------------------------------------------------------------------
// Bench check for a job: which people already in Harbor could fit it.
// Busy candidates are never pitched: anyone at Interview or Offer on another role, or already
// Placed/Hired. Of the rest, only people whose parallel titles match the job's title are
// considered, and the closest few get the full AI review above (location, seniority, skills,
// every requirement). Only those reviews decide who shows as a fit.
// ---------------------------------------------------------------------------
export const BUSY_STAGES = ["Interview", "Offer", "Placed"];
const BUSY_STATUSES = ["Interview", "Placed", "Hired"];
export const isBusy = (c: any, links: any[]) =>
  BUSY_STATUSES.includes(c.status) || links.some((l) => l.candidate_response !== "declined" && BUSY_STAGES.includes(l.stage));


// One-off catch-up for people screened before parallel titles existed: one batched call from
// what their profile already holds (title, experience, skills, strengths, looked-up employers).
async function fillMissingTitles(admin: any, cands: any[], askAI: Ask) {
  const missing = cands.filter((c) => !(Array.isArray(c.parallel_titles) && c.parallel_titles.length)).slice(0, 30);
  if (!missing.length) return 0;
  const lines = missing.map((c, i) => `${i + 1}. id=${c.id} | current title: ${c.current_title || "?"} | experience: ${c.experience || "?"} | location: ${c.location || "?"} | skills: ${(c.skills || []).slice(0, 15).join(", ") || "?"} | strengths: ${(c.strengths || []).slice(0, 6).join("; ") || "?"} | employers: ${(Array.isArray(c.industries) ? c.industries : []).slice(0, 5).map((x: any) => x.company + (x.industry ? " (" + x.industry + ")" : "")).join(", ") || "?"}`);
  const system = "You are a recruitment analyst. For each candidate below, list their parallel job titles. Reply with STRICT JSON only: {\"candidates\": [{\"id\": string, \"parallel_titles\": string[]}]}. " + PARALLEL_RULE;
  const out = await askAI(system, lines.join("\n"), null, 3000);
  let n = 0;
  for (const r of Array.isArray(out?.candidates) ? out.candidates : []) {
    const titles = cleanTitles(r?.parallel_titles);
    if (!titles.length || !missing.some((c) => c.id === r.id)) continue;
    await admin.from("candidates").update({ parallel_titles: titles, parallel_titles_at: new Date().toISOString() }).eq("id", r.id);
    const c = cands.find((x) => x.id === r.id); if (c) c.parallel_titles = titles;
    n++;
  }
  return n;
}

export async function benchFits(admin: any, jobId: string, askAI: Ask, loadResume: Load, max = 5) {
  const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).single();
  if (!job) throw new Error("This job no longer exists");
  const { data: cands } = await admin.from("candidates")
    .select("id,name,role_title,current_title,location,status,skills,strengths,experience,industries,matches,parallel_titles,resume_path,cv_path,is_draft,candidate_jobs(job_id,stage,candidate_response)")
    .eq("is_draft", false);
  let busy = 0;
  const free = (cands || []).filter((c: any) => {
    const links = c.candidate_jobs || [];
    if (links.some((l: any) => l.job_id === jobId)) return false;          // already on this job
    if (isBusy(c, links)) { busy++; return false; }                          // in an active process elsewhere
    return !!(c.resume_path || c.cv_path) && c.status !== "Rejected";
  });
  let titled = 0;
  try { titled = await fillMissingTitles(admin, free, askAI); } catch (e) { console.error("parallel titles", String((e as Error)?.message || e)); }
  // Only people whose parallel titles (or their own current title) match this job's title.
  // role_title is the job they were added for, not their own title, so it isn't used.
  const pool = free.map((c: any) => ({ c, score: titleScore(job.role_title, [c.current_title, ...(Array.isArray(c.parallel_titles) ? c.parallel_titles : [])].filter(Boolean)) }))
    .filter((x: any) => x.score >= 0.6).sort((a: any, b: any) => b.score - a.score);

  // Reuse a review of this job from the last 14 days; review the closest others.
  const fresh = (c: any) => (Array.isArray(c.matches) ? c.matches : []).some((m: any) => m?.job_id === jobId && m.reviewedAt && Date.now() - new Date(m.reviewedAt).getTime() < 14 * 864e5);
  const todo = pool.filter((x: any) => !fresh(x.c)).slice(0, max).map((x: any) => x.c);
  const errors: string[] = [];
  let reviewed = 0;
  // Two at a time keeps within Claude's rate limits on a new account.
  for (let i = 0; i < todo.length; i += 2) {
    await Promise.all(todo.slice(i, i + 2).map(async (c: any) => {
      try { await reviewMatch(admin, c.id, jobId, askAI, loadResume, { skipLookup: true }); reviewed++; }
      catch (e) { errors.push(c.name + ": " + String((e as Error)?.message || e).slice(0, 120)); }
    }));
  }
  return { reviewed, reused: pool.filter((x: any) => fresh(x.c)).length, considered: pool.length, free: free.length, busy, titled, errors };
}

// Parallel titles for one candidate from their full CV (allowed on locked candidates: it's
// not part of the locked review).
export async function parallelTitles(admin: any, candidateId: string, askAI: Ask, loadResume: Load) {
  const { data: c } = await admin.from("candidates").select("*").eq("id", candidateId).single();
  if (!c) throw new Error("Candidate not found");
  const { resume } = await loadResume(admin, c);
  const system = "You are a recruitment analyst. Reply with STRICT JSON only: {\"parallel_titles\": string[]}. " + PARALLEL_RULE;
  const text = (resume ? "The candidate's CV is included.\n" : "") + `Current title: ${c.current_title || "?"}. Experience: ${c.experience || "?"}. ` + candidateFacts(c) +
    `\nSkills: ${(c.skills || []).join(", ") || "?"}.\n` + industryText(c.industries);
  const out = await askAI(system, text, resume, 600);
  const titles = cleanTitles(out?.parallel_titles);
  if (!titles.length) throw new Error("The AI didn't return any titles");
  await admin.from("candidates").update({ parallel_titles: titles, parallel_titles_at: new Date().toISOString() }).eq("id", candidateId);
  return titles;
}

// Draft follow-up questions for a card from its current review: aimed at the must-haves that
// aren't met, never repeating the job's own screening questions or anything already asked.
// Only ai.followups is written, so this works on manually reviewed (locked) cards too.
export async function draftFollowups(admin: any, linkId: string, askAI: Ask) {
  const { data: link } = await admin.from("candidate_jobs").select("*").eq("id", linkId).single();
  if (!link) throw new Error("Screening card not found");
  const { data: allLinks } = await admin.from("candidate_jobs").select("*").eq("candidate_id", link.candidate_id);
  const links: any[] = allLinks || [link];
  const { data: jobs } = await admin.from("jobs").select("*").in("id", [...new Set(links.map((l) => l.job_id))]);
  const jobOf = (id: string) => (jobs || []).find((j: any) => j.id === id);
  const job = jobOf(link.job_id);
  if (!job) throw new Error("This job no longer exists");
  const jobQs: string[] = (Array.isArray(job.screening_questions) ? job.screening_questions : []).filter(Boolean).map(String);
  const asked = [...askedQuestions(links, jobOf), ...jobQs];
  const answered = links.flatMap((l) => answersOn(l, jobOf(l.job_id)));
  const open = (link.ai?.requirements || []).filter((r: any) => r.status !== "met").sort((a: any, b: any) => (a.type === "must" ? 0 : 1) - (b.type === "must" ? 0 : 1));
  if (!open.length) throw new Error("Nothing on this card's checklist is unmet, so there's nothing to screen for");
  const system = "You write short candidate screening questions for a recruiter. Reply with STRICT JSON only: {\"questions\": string[]}. " +
    "Up to 3 questions (under 25 words each), most important first, each aimed at one of the open requirements below (must-haves first), asking for specifics (where, how long, what they did). " +
    "NEVER repeat or rephrase any already-asked question, and never ask for something the candidate has already answered.";
  const text = `Job: ${job.role_title} at ${job.client}.\nOpen requirements:\n` + open.map((r: any) => `- [${r.type}] ${r.requirement} (${r.status}${r.evidence ? ": " + r.evidence : ""})`).join("\n") +
    `\n\nAlready asked (never repeat):\n${asked.length ? asked.map((q) => "- " + q).join("\n") : "(nothing yet)"}` +
    `\n\nAlready answered:\n${answered.length ? answered.map((x) => `Q: ${x.q}\nA: ${x.a}`).join("\n") : "(nothing yet)"}`;
  const out = await askAI(system, text, null, 600);
  const questions = dedupeQuestions(out?.questions, asked);
  if (!questions.length) throw new Error("Every question the AI suggested has already been asked. Add one yourself instead.");
  const ai = { ...(link.ai || {}), followups: { state: "draft", questions: questions.map((q) => ({ q })) } };
  await admin.from("candidate_jobs").update({ ai }).eq("id", link.id);
  return ai;
}
