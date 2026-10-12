// Learning on the job: lessons from client rejections (public.screening_lessons).
//
// When a client rejects a candidate and the recruiter records why, learnFromRejection() turns the
// client's feedback into lessons (one per reason the client gave): what the client expected that
// this candidate lacked, what to look for in the next candidate, and a question that surfaces it.
//
// Screening then uses the lessons (lessonsFor + lessonsPrompt):
//   - the SAME client (that job, or another of their roles where the lesson is client-wide or the
//     role is similar): a must-have line on the checklist, "Client feedback: ...". A candidate who
//     clearly lacks it is not a strong submission for that client.
//   - SIMILAR roles at OTHER clients (only lessons marked as a general bar for this kind of role):
//     a "Watch-out" line, preferred, never a reason to reject on its own, but checked against the
//     CV and asked about when the CV doesn't settle it.
// Staff can switch a lesson off, edit or delete it under Jobs > "What the AI learned".

import { titleScore } from "./screening.ts";

type Ask = (system: string, text: string, resume: null, maxTokens: number) => Promise<any>;

// Reasons that say nothing about what the client wants in a candidate.
const NO_LESSON = new Set(["other_candidate", "role_closed"]);
const REASON_LABEL: Record<string, string> = {
  experience: "Not enough experience", skill: "Missing a must-have skill", salary: "Salary expectation", location: "Location / work authorisation",
  notice: "Notice period", interview: "Interview performance", other: "Other",
};
const normClient = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clip = (s: unknown, n: number) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

export async function learnFromRejection(admin: any, linkId: string, askAI: Ask, by: string | null = null) {
  const { data: link } = await admin.from("candidate_jobs").select("id,job_id,candidate_id,reject_kind,reject_reason,reject_feedback,ai").eq("id", linkId).maybeSingle();
  if (!link) return { ok: false, skipped: "not found" };
  if (link.reject_kind !== "client" || !link.reject_reason) return { ok: true, skipped: "not a client rejection" };
  if (NO_LESSON.has(link.reject_reason)) return { ok: true, skipped: "reason isn't about the candidate" };
  const feedback = clip(link.reject_feedback, 2000);
  const { data: job } = await admin.from("jobs").select("id,role_title,client,description,location,work_setup,min_pay,max_pay,currency").eq("id", link.job_id).maybeSingle();
  if (!job) return { ok: false, skipped: "job not found" };
  const { data: cand } = await admin.from("candidates").select("name").eq("id", link.candidate_id).maybeSingle();
  const reqs = (link.ai?.requirements || []).map((r: any) => `- [${r.type}] ${r.requirement}: ${r.status}${r.evidence ? " (" + r.evidence + ")" : ""}`).join("\n");

  const system =
    "You help a recruitment agency learn from client feedback so it submits stronger candidates. A client rejected a candidate. " +
    "Turn the rejection into lessons about what the client expects: ONE lesson per distinct reason the client gave (at most 3, most important first). Reply with STRICT JSON only: " +
    "{\"lessons\": [{\"lesson\": string, \"look_for\": string, \"question\": string, \"scope\": \"client\" | \"role\", \"role_titles\": string[]}]}. " +
    "lesson: one sentence, under 30 words, stating the expectation the candidate did not meet, in general terms that apply to future candidates (never the candidate's name). E.g. 'Needs at least 1 year at Senior Manager level, not just a Manager title.' " +
    "look_for: one sentence, under 35 words, on the concrete evidence a screener should see in a CV or answer to be sure the next candidate meets it (dated roles, titles, firm types, specific work). " +
    "question: one screening question under 25 words that would surface it, asking for specifics (where, how long, what they did). " +
    "scope: 'role' when this is a general bar that other employers hiring for the same kind of role would likely also apply (e.g. years at a level, a core technical skill, a licence). 'client' when it reflects this client's own preference or circumstance (their budget, their time zone or location rules, a niche tool they use, culture). " +
    "role_titles: 2-5 standard job titles the lesson applies to (this role and close equivalents at the same seniority). " +
    "If the feedback gives nothing usable about the candidate (e.g. the client hired someone else, or the role was cancelled), reply {\"lessons\": []}. " +
    "Base the lessons ONLY on the client's reason and feedback; the candidate's screening checklist is context, never invent a reason the client didn't give.";
  const text = `Job: ${job.role_title} at ${job.client}.\nDescription:\n${clip(job.description, 4000) || "(none)"}\n` +
    `\nClient's main reason: ${REASON_LABEL[link.reject_reason] || link.reject_reason}` +
    `\nClient's feedback, in full: ${feedback || "(none given)"}` +
    `\n\nOur AI screening checklist for this candidate before submission:\n${reqs || "(none)"}`;
  const out = await askAI(system, text, null, 900);
  const items = (Array.isArray(out?.lessons) ? out.lessons : out?.lesson ? [out] : []).filter((x: any) => clip(x?.lesson, 300)).slice(0, 3);
  // A rejection can teach several things; each is its own lesson (idx 0, 1, 2). Learning the same
  // rejection again refreshes them but keeps each switched on/off as it was; leftovers are switched off.
  const { data: existing } = await admin.from("screening_lessons").select("id,idx").eq("source_link_id", link.id);
  const rows = items.map((x: any, idx: number) => ({
    source_link_id: link.id, idx, job_id: job.id, client: job.client || "", role_title: job.role_title || "",
    role_titles: [...new Set([job.role_title, ...(Array.isArray(x?.role_titles) ? x.role_titles : [])].map((t: unknown) => clip(t, 90)).filter(Boolean))].slice(0, 6),
    scope: x?.scope === "role" ? "role" : "client", reason: link.reject_reason, feedback: feedback || null,
    lesson: clip(x.lesson, 300), look_for: clip(x?.look_for, 400), question: clip(x?.question, 300), candidate_name: cand?.name || null,
    created_by: by, updated_at: new Date().toISOString(),
  }));
  for (const row of rows) {
    const ex = (existing || []).find((e: any) => e.idx === row.idx);
    if (ex) await admin.from("screening_lessons").update(row).eq("id", ex.id);
    else await admin.from("screening_lessons").insert(row);
  }
  const stale = (existing || []).filter((e: any) => e.idx >= rows.length).map((e: any) => e.id);
  if (stale.length) await admin.from("screening_lessons").update({ active: false }).in("id", stale);
  if (!rows.length) return { ok: true, skipped: "no usable lesson in the feedback" };
  return { ok: true, lesson: rows[0], lessons: rows };
}

export type Lesson = { id: string; client: string; role_title: string; role_titles: string[]; scope: string; lesson: string; look_for: string; question: string; job_id: string | null; created_at: string };

// Lessons that matter for this job, split into the same client's and other clients'.
export async function lessonsFor(admin: any, job: any): Promise<{ same: Lesson[]; other: Lesson[] }> {
  const { data } = await admin.from("screening_lessons").select("id,client,role_title,role_titles,scope,lesson,look_for,question,job_id,created_at")
    .eq("active", true).order("created_at", { ascending: false }).limit(300);
  const all: Lesson[] = data || [];
  const client = normClient(job.client);
  const similar = (l: Lesson) => titleScore(job.role_title, [l.role_title, ...(l.role_titles || [])]) >= 0.6;
  const seen = new Set<string>();
  const uniq = (l: Lesson) => { const k = l.lesson.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; };
  const same = all.filter((l) => client && normClient(l.client) === client && (l.job_id === job.id || l.scope === "client" || similar(l))).filter(uniq).slice(0, 8);
  const other = all.filter((l) => normClient(l.client) !== client && l.scope === "role" && similar(l)).filter(uniq).slice(0, 6);
  return { same, other };
}

// The block added to a screening prompt, and the rule for using it.
export function lessonsPrompt(ls: { same: Lesson[]; other: Lesson[] }, job: any) {
  if (!ls.same.length && !ls.other.length) return { text: "", rule: "" };
  const line = (l: Lesson) => `- ${l.lesson}${l.look_for ? " Look for: " + l.look_for : ""}${l.question ? " (a question that surfaces it: " + l.question + ")" : ""}`;
  const text =
    "\nLessons from this agency's past client rejections:\n" +
    (ls.same.length ? `From ${job.client} itself (they rejected a candidate for this):\n${ls.same.map(line).join("\n")}\n` : "") +
    (ls.other.length ? `From other clients hiring similar roles:\n${ls.other.map((l) => line(l) + ` [${l.client}, ${l.role_title}]`).join("\n")}\n` : "");
  const rule =
    " LESSONS FROM CLIENT REJECTIONS: the material lists what clients have rejected candidates for. Use them to submit only strong candidates. " +
    `For each lesson from ${job.client} itself that applies to this role, add a checklist line of its own starting 'Client feedback: ' (type 'must'), judged with exactly the same evidence rules as every other line. ` +
    "For each lesson from other clients that applies to this role, add a checklist line starting 'Watch-out: ' (type 'preferred' unless the job description itself requires it). Never reject on a watch-out alone. " +
    "Skip any lesson that clearly doesn't apply to this role, and never add a line that duplicates one already on the checklist (strengthen the existing line's judgement instead). " +
    "When a 'Client feedback:' or 'Watch-out:' line is 'partial' or 'not met', give it priority in the follow-up questions, asking for the concrete evidence the lesson says to look for. ";
  return { text, rule };
}
