// Learning on the job: lessons from status updates (public.screening_lessons).
//
// Three kinds of status update teach the AI something (lessonKind, mirrored by public.lesson_kind):
//   client_reject   - the client rejected the candidate and the recruiter recorded why
//   internal_reject - our own team rejected them before submission, with a reason
//   progress        - the client moved them to Interview, Offer or Placed
// learnFromOutcome() turns the update into up to 3 lessons: what the role needs (or what the client
// liked), what to look for in the next candidate, and a question that surfaces it.
//
// Every lesson applies ONLY to the job it came from, never to the client's other roles or to other
// clients. Screening uses them (lessonsFor + lessonsPrompt):
//   client_reject   -> "Client feedback: ..." must-have line
//   internal_reject -> "Watch-out: ..." preferred line, never a reason to reject on its own
//   progress        -> "Client liked: ..." bonus line: raises the score when met, never costs points

type Ask = (system: string, text: string, resume: null, maxTokens: number) => Promise<any>;
export type LessonKind = "client_reject" | "internal_reject" | "progress";

const PROGRESS = new Set(["Interview", "Offer", "Placed"]);
// Reasons that say nothing about what the role needs in a candidate.
const NO_LESSON = new Set(["other_candidate", "role_closed"]);
const REASON_LABEL: Record<string, string> = {
  experience: "Not enough experience", skill: "Missing a must-have skill", salary: "Salary expectation", location: "Location / work authorisation",
  notice: "Notice period", interview: "Interview performance", other: "Other",
};
const clip = (s: unknown, n: number) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

export function lessonKind(link: any): LessonKind | null {
  if (link?.stage === "Rejected" && (link.reject_kind === "client" || link.reject_kind === "internal") && link.reject_reason)
    return (link.reject_kind + "_reject") as LessonKind;
  if (PROGRESS.has(link?.stage)) return "progress";
  return null;
}

const SHAPE = "Reply with STRICT JSON only: {\"lessons\": [{\"lesson\": string, \"look_for\": string, \"question\": string}]}, at most 3 lessons, most important first. ";
const FIELDS =
  "look_for: one sentence, under 35 words, on the concrete evidence a screener should see in a CV or answer to be sure the next candidate meets it (dated roles, titles, firm types, specific work). " +
  "question: one screening question under 25 words that would surface it, asking for specifics (where, how long, what they did). " +
  "Lessons are about THIS role only: they will be used to screen the next candidates for this same job. Never use the candidate's name. ";

function prompt(kind: LessonKind, stage: string) {
  if (kind === "client_reject") return "You help a recruitment agency learn from client feedback so it submits stronger candidates. The client rejected a candidate for this role. " +
    "Turn the rejection into lessons about what the client expects: ONE lesson per distinct reason the client gave. " + SHAPE +
    "lesson: one sentence, under 30 words, stating the expectation the candidate did not meet, e.g. 'Needs at least 1 year at Senior Manager level, not just a Manager title.' " + FIELDS +
    "If the feedback gives nothing usable about the candidate (e.g. the client hired someone else, or the role was cancelled), reply {\"lessons\": []}. " +
    "Base the lessons ONLY on the client's reason and feedback; the screening checklist is context, never invent a reason the client didn't give.";
  if (kind === "internal_reject") return "You help a recruitment agency learn from its own screening decisions. Our recruiters rejected a candidate for this role before sending them to the client. " +
    "Turn the team's reason into lessons about what this role needs: ONE lesson per distinct reason. " + SHAPE +
    "lesson: one sentence, under 30 words, stating what the candidate lacked for this role. " + FIELDS +
    "Only when the reason is about the candidate's fit for the role (skills, experience, level, location, pay, notice). If it is about something else (the candidate stopped responding, the role closed, another candidate was chosen), reply {\"lessons\": []}. " +
    "Base the lessons ONLY on the team's reason and notes; never invent a reason they didn't give.";
  return `You help a recruitment agency learn what works for a client. The client moved a candidate we submitted for this role to ${stage}. ` +
    "Work out what this candidate showed that the client most likely valued, so the next candidates for the same role can be checked for it. " + SHAPE +
    "lesson: one sentence, under 30 words, naming a specific, checkable strength, e.g. 'Client moved forward a candidate who led ASC 606 implementations at a public SaaS company.' " + FIELDS +
    "Use ONLY the checklist items marked 'met', the strengths and the summary below; never invent anything. Prefer what goes beyond the bare job requirements (depth, scale, firm type, level). " +
    "If nothing specific stands out, reply {\"lessons\": []}.";
}

export async function learnFromOutcome(admin: any, linkId: string, askAI: Ask, by: string | null = null) {
  const { data: link } = await admin.from("candidate_jobs").select("id,job_id,candidate_id,stage,reject_kind,reject_reason,reject_feedback,ai").eq("id", linkId).maybeSingle();
  if (!link) return { ok: false, skipped: "not found" };
  const kind = lessonKind(link);
  if (!kind) return { ok: true, skipped: "this status update teaches nothing" };
  if (kind !== "progress" && NO_LESSON.has(link.reject_reason)) return { ok: true, skipped: "reason isn't about the candidate" };
  const feedback = kind === "progress" ? "" : clip(link.reject_feedback, 2000);
  const { data: job } = await admin.from("jobs").select("id,role_title,client,description,location,work_setup,min_pay,max_pay,currency").eq("id", link.job_id).maybeSingle();
  if (!job) return { ok: false, skipped: "job not found" };
  const { data: cand } = await admin.from("candidates").select("name").eq("id", link.candidate_id).maybeSingle();
  const reqs = (link.ai?.requirements || []).map((r: any) => `- [${r.type}] ${r.requirement}: ${r.status}${r.evidence ? " (" + r.evidence + ")" : ""}`).join("\n");

  const head = `Job: ${job.role_title} at ${job.client}.\nDescription:\n${clip(job.description, 4000) || "(none)"}\n`;
  const text = kind === "progress"
    ? head + `\nThe client moved this candidate to: ${link.stage}` +
      `\n\nOur AI screening summary:\n${clip(link.ai?.summary, 1200) || "(none)"}` +
      `\nStrengths:\n${(link.ai?.strengths || []).map((s: unknown) => "- " + clip(s, 160)).join("\n") || "(none)"}` +
      `\n\nScreening checklist:\n${reqs || "(none)"}`
    : head + `\n${kind === "client_reject" ? "Client's" : "Our team's"} main reason: ${REASON_LABEL[link.reject_reason] || link.reject_reason}` +
      `\n${kind === "client_reject" ? "Client's feedback" : "Our team's notes"}, in full: ${feedback || "(none given)"}` +
      `\n\nOur AI screening checklist for this candidate:\n${reqs || "(none)"}`;
  const out = await askAI(prompt(kind, link.stage), text, null, 900);
  const items = (Array.isArray(out?.lessons) ? out.lessons : out?.lesson ? [out] : []).filter((x: any) => clip(x?.lesson, 300)).slice(0, 3);
  // Several lessons per update (idx 0, 1, 2). Learning the same card again refreshes them but keeps each
  // switched on/off as it was, unless the card now teaches a different kind; leftovers are switched off.
  const { data: existing } = await admin.from("screening_lessons").select("id,idx,kind").eq("source_link_id", link.id);
  const rows = items.map((x: any, idx: number) => ({
    source_link_id: link.id, idx, kind, job_id: job.id, client: job.client || "", role_title: job.role_title || "",
    role_titles: [clip(job.role_title, 90)].filter(Boolean), scope: "client",
    reason: kind === "progress" ? link.stage : link.reject_reason, feedback: feedback || null,
    lesson: clip(x.lesson, 300), look_for: clip(x?.look_for, 400), question: clip(x?.question, 300), candidate_name: cand?.name || null,
    created_by: by, updated_at: new Date().toISOString(),
  }));
  for (const row of rows) {
    const ex = (existing || []).find((e: any) => e.idx === row.idx);
    if (ex) await admin.from("screening_lessons").update(ex.kind === kind ? row : { ...row, active: true }).eq("id", ex.id);
    else await admin.from("screening_lessons").insert(row);
  }
  const stale = (existing || []).filter((e: any) => e.idx >= rows.length).map((e: any) => e.id);
  if (stale.length) await admin.from("screening_lessons").update({ active: false }).in("id", stale);
  if (!rows.length) return { ok: true, kind, skipped: "nothing usable to learn" };
  return { ok: true, kind, lesson: rows[0], lessons: rows };
}

export type Lesson = { id: string; kind: LessonKind; lesson: string; look_for: string; question: string; job_id: string | null; created_at: string };
export type RoleLessons = { client: Lesson[]; internal: Lesson[]; liked: Lesson[] };
export const NO_LESSONS: RoleLessons = { client: [], internal: [], liked: [] };

// Active lessons for this job only, split by kind.
export async function lessonsFor(admin: any, job: any): Promise<RoleLessons> {
  if (!job?.id) return NO_LESSONS;
  const { data } = await admin.from("screening_lessons").select("id,kind,lesson,look_for,question,job_id,created_at")
    .eq("active", true).eq("job_id", job.id).order("created_at", { ascending: false }).limit(60);
  const seen = new Set<string>();
  const all: Lesson[] = (data || []).filter((l: Lesson) => { const k = l.lesson.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const of = (k: LessonKind) => all.filter((l) => (l.kind || "client_reject") === k).slice(0, 8);
  return { client: of("client_reject"), internal: of("internal_reject"), liked: of("progress") };
}

// The block added to a screening prompt, and the rule for using it.
export function lessonsPrompt(ls: RoleLessons, job: any) {
  if (!ls.client.length && !ls.internal.length && !ls.liked.length) return { text: "", rule: "" };
  const line = (l: Lesson) => `- ${l.lesson}${l.look_for ? " Look for: " + l.look_for : ""}${l.question ? " (a question that surfaces it: " + l.question + ")" : ""}`;
  const text =
    "\nLessons from past candidates for this same role:\n" +
    (ls.client.length ? `From ${job.client}'s rejections:\n${ls.client.map(line).join("\n")}\n` : "") +
    (ls.internal.length ? `From our own team's rejections (before submission):\n${ls.internal.map(line).join("\n")}\n` : "") +
    (ls.liked.length ? `From candidates ${job.client} moved forward (interview, offer or placement):\n${ls.liked.map(line).join("\n")}\n` : "");
  const rule =
    " LESSONS FROM THIS ROLE: the material lists what past candidates for this same job taught us. Use them to submit only strong candidates. " +
    `For each lesson from ${job.client}'s rejections, add a checklist line of its own starting 'Client feedback: ' (type 'must'), judged with exactly the same evidence rules as every other line. ` +
    "For each lesson from our own team's rejections, add a line starting 'Watch-out: ' (type 'preferred' unless the job description itself requires it). Never reject on a watch-out alone. " +
    "For each lesson from candidates the client moved forward, add a line starting 'Client liked: ' (type 'preferred'). It is a bonus only: when 'met' it may add up to 3 points (never above 100); when not met it costs no points, is not listed in gaps and is never a reason to reject. " +
    "Never add a line that duplicates one already on the checklist (strengthen the existing line's judgement instead). " +
    "When a 'Client feedback:' or 'Watch-out:' line is 'partial' or 'not met', give it priority in the follow-up questions, asking for the concrete evidence the lesson says to look for. ";
  return { text, rule };
}
