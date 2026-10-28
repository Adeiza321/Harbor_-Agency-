// Client sourcing, candidate first: the candidate side of a pitch.
//
// A candidate who said Yes once (to future roles / the Active file) isn't asked again. Before an
// employer is pitched, each candidate on the pitch is told (information only):
//   - the role, never the employer: title, place, work setup, employment type, pay if shown, and
//     a two-line summary;
//   - how the role meets what THEY are looking for (role, level, location, work setup, employment
//     type, pay): each "matches" or "to discuss" (the negotiable ones are talked through, not
//     ruled out), and the fit score we gave them;
//   - that they don't need to do anything, we'll update them if the employer likes their profile,
//     we'll ask if we have questions and they can ask theirs;
//   - "Acknowledge" (any questions we have open on their page) and "Withdraw my profile".
// The pitch has its own chat: the candidate is linked to the lead's role (a private client-lead
// role, never on the jobs board, the employer never shown to the candidate) and the notice is the
// first message; their acknowledgement and answers come back to their recruiter there.
// Nothing is emailed automatically: each candidate's email starts as a draft that Rec Ops / an
// Admin reviews (edit "why it suits you", drop questions) and sends; a reminder (the full email again)
// is due 2 days later and a last, short reminder 2 days after that; a reminder is due after 2
// days with no response and is sent from the lead card. Nobody goes into a pitch without clicking
// Acknowledge: Rec Ops / an Admin can call them to ask them to click it, put through someone who
// acknowledged without waiting for their answers, or take them off. Each candidate has their own status (lead_offers), so a pitch can go
// with some candidates and not others.

import { askAI, isAiPaused } from "./ai.ts";
import { prepareResume } from "../ai-screen/resume.ts";
import { jdContacts, type Contact } from "./contacts.ts";
import { anonSummary, scrub, type Settings } from "./common.ts";
import { button, emailShell, esc, loadBrand, sendBrevo, type Brand } from "./brand.ts";
import { portalBase } from "./queue.ts";

export const REMIND_AFTER_MS = 2 * 864e5;
export const PENDING = ["draft", "notified", "reminded", "no_email", "acknowledged"];
export const OUT = ["withdrawn", "removed"];

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
// Cut at a whole word with "…" (evidence quoted from a CV), never mid-word.
const clipW = (v: unknown, n: number) => { const t = String(v ?? "").replace(/\s+/g, " ").trim(); if (t.length <= n) return t; const i = t.lastIndexOf(" ", n); return t.slice(0, i > n / 2 ? i : n).replace(/[\s,;:(\-\u2013]+$/, "") + "\u2026"; };
// Evidence saved before that (cut at exactly 120 characters): shown up to the last whole word.
export const tidyCut = (v: unknown) => { const t = String(v ?? "").trim(); if (t.length < 118 || /[.)!?\u2026]$/.test(t)) return t; const i = t.lastIndexOf(" "); return (i > 60 ? t.slice(0, i) : t).replace(/[\s,;:(\-\u2013]+$/, "") + "\u2026"; };

// What a candidate is looking for, from their job preferences and profile (for the AI).
export function lookingFor(c: any): string {
  const p = c?.preferences && typeof c.preferences === "object" ? c.preferences : {};
  const pick: Record<string, unknown> = {};
  for (const k of ["roles", "seniority", "employmentTypes", "salary", "currentCity", "currentCountry", "relocate", "preferredCities", "workSetup", "availability"]) {
    const v = (p as any)[k];
    if (v != null && v !== "" && !(Array.isArray(v) && !v.length)) pick[k] = v;
  }
  const ws = Array.isArray(c?.work_setup) && c.work_setup.length ? c.work_setup : Array.isArray((p as any).workSetup) ? (p as any).workSetup : [];
  return [
    Object.keys(pick).length ? "Job preferences: " + JSON.stringify(pick).slice(0, 700) : "Job preferences: not filled in",
    "Work setup they'd accept: " + (ws.length ? ws.join(", ") : "not confirmed (ask, under 'Work setup')"),
    c?.pay && c.pay !== "-" ? "Pay they want: " + clip(c.pay, 80) : "",
    c?.location ? "Lives in: " + clip(c.location, 100) : "",
    c?.notice && c.notice !== "-" ? "Notice period: " + clip(c.notice, 60) : "Notice period: not known",
    c?.pay && c.pay !== "-" ? "" : "Pay they want: not known",
  ].filter(Boolean).join(" | ");
}

export type JdItem = { item: string; required: boolean };
// How one candidate stands on one item from the job description, from the evidence: met (their work
// history shows it), partial (it's listed or very likely from their roles but not described: we ask
// them to confirm, and it doesn't count against them), not_shown (the CV doesn't say; we ask them),
// not_met (the CV clearly shows they don't have it), and confirmed (they told us yes).
export type JdCheck = JdItem & { status: "met" | "partial" | "not_met" | "not_shown" | "confirmed"; evidence: string; info?: boolean };
// Most questions in one pitch email: yes/no confirmations first, then what they're looking for.
export const MAX_PITCH_QUESTIONS = 6;
export type Assessed = {
  n: number; fit: number; verdict: string; reason: string; whyRole: string; bullets: string[]; musts: { item: string; evidence: string; bonus?: boolean }[];
  notMet: string[]; requirements: { item: string; theirs: string; role: string; status: "met" | "discuss" }[]; questions: { q: string; field?: string }[];
  jd: JdCheck[]; confirm: { item: string; q: string }[]; out: string;
  exEmployer?: boolean;   // their CV shows they've worked at this company (any of its names)
};
// noAgencies: the description's words when it says the employer won't take agency candidates or
// pay for unsolicited CVs; '' otherwise.
export type RoleFacts = { summary: string; industry: string; workSetup: string; employmentType: string; seniority: string; hmTitles: string[]; noAgencies: string };

// Too much the CV doesn't show to put someone forward, even after asking.
export const MAX_TO_CONFIRM = 3;

// The candidate's CV for the AI: the stored file (PDF as a document, photos as an image, Word and
// text files as text), the same way screening reads it.
// What the candidate has already told us on other roles (application questions, follow-ups and
// earlier pitch questions), so the pitch email never asks them something they've answered.
async function earlierAnswers(admin: any, candidateId: string): Promise<string> {
  const { data: links } = await admin.from("candidate_jobs").select("screening_answers,ai,jobs(screening_questions)").eq("candidate_id", candidateId).limit(30);
  const lines: string[] = [];
  for (const l of links || []) {
    const qs: string[] = Array.isArray((l as any).jobs?.screening_questions) ? (l as any).jobs.screening_questions : [];
    (Array.isArray(l.screening_answers) ? l.screening_answers : []).forEach((a: any, i: number) => {
      const q = a && typeof a === "object" ? a.q : qs[i], ans = a && typeof a === "object" ? a.a : a;
      if (q && ans && String(ans).trim()) lines.push(`Q: ${clip(q, 200)}\nA: ${clip(ans, 400)}`);
    });
    for (const x of l.ai?.followups?.questions || []) if (x?.q && x?.a && String(x.a).trim()) lines.push(`Q: ${clip(x.q, 200)}\nA: ${clip(x.a, 400)}`);
  }
  return [...new Set(lines)].slice(0, 25).join("\n");
}

async function cvContent(admin: any, c: any): Promise<{ blocks: any[]; text: string; why?: string }> {
  const path = c.resume_path || c.cv_path;
  if (!path) return { blocks: [], text: "", why: "No CV on file" };
  const { data: file, error } = await admin.storage.from(c.resume_path ? "resumes" : "cvs").download(path);
  if (error || !file) return { blocks: [], text: "", why: "Couldn't read their CV" };
  const r = await prepareResume(new Uint8Array(await file.arrayBuffer()), (c.resume_path && c.resume_name) || path);
  const input = r.input;
  if (!input) return { blocks: [], text: "", why: r.why || "Couldn't read their CV" };
  if (input.kind === "pdf") return { blocks: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.data } }], text: "" };
  if (input.kind === "image" && ["image/jpeg", "image/png", "image/webp"].includes(input.mime)) return { blocks: [{ type: "image", source: { type: "base64", media_type: input.mime, data: input.data } }], text: "" };
  if (input.kind === "text") return { blocks: [], text: "Candidate's CV (text from their file):\n\"\"\"\n" + input.text.slice(0, 30000) + "\n\"\"\"\n\n" };
  return { blocks: [], text: "", why: "Their CV is a photo format the AI can't read (upload it as PDF)" };
}

// Step 1, once per lead: what the job description asks for, exactly as written (nothing assumed),
// split into required and nice to have, plus the role facts and the titles the hiring manager
// likely has (for finding them on Apollo).
export async function readJobDescription(lead: any): Promise<{ role: RoleFacts; items: JdItem[]; contacts: Contact[] }> {
  const sys = "You read an employer's job description and pull out exactly what it asks of candidates. Reply with STRICT JSON only: " +
    "{\"role\": {\"summary\": string, \"industry\": string, \"work_setup\": \"On-site\" | \"Hybrid\" | \"Remote\" | \"\", \"employment_type\": \"Full-time\" | \"Part-time\" | \"Contract\" | \"Temporary\" | \"\", \"seniority\": string}, " +
    "\"requirements\": [{\"item\": string, \"required\": boolean}], \"hiring_manager_titles\": string[], \"contacts\": [{\"name\": string, \"title\": string, \"email\": string}], " +
    "\"agency_policy\": {\"no_agencies\": boolean, \"quote\": string}}. " +
    "agency_policy: no_agencies true ONLY when the description says the employer won't work with recruitment agencies, recruiters or third parties, won't accept or pay for unsolicited CVs/resumes, or is 'principals only' " +
    "(e.g. 'No agencies', 'We do not accept unsolicited resumes', 'Recruiters need not apply', 'not responsible for any fees from unsolicited submissions'); quote = those words (under 15 words). " +
    "Otherwise no_agencies false and quote ''. A description that merely mentions recruiters or agencies in the duties is NOT no_agencies. " +
    "requirements: every qualification, requirement, skill, licence, certification, degree, years of experience, industry experience, tool, system, language or work authorisation the description asks candidates to have, " +
    "wherever it appears (headings like Requirements, Qualifications, What you'll bring, Must have, About you, Skills, Experience, Preferred, Nice to have, Bonus, or any sentence that reads like one). " +
    "Write each one as the description puts it, under 12 words, one per item (keep 'or' alternatives together, e.g. 'CPA or CMA'). " +
    "NEVER add anything the description doesn't say and never infer requirements from the job title or what is usual for the role. " +
    "Leave out duties (what the person will do), benefits, and personal traits a CV can't show (e.g. 'team player', 'detail-oriented', 'strong communication skills', 'self-starter'). " +
    "required=false when the description says preferred, ideally, a plus, a bonus, nice to have, desirable or similar; otherwise true. Up to 15 items; [] if the description lists none. " +
    "role.summary: two short sentences on what the job is, for the candidate. NEVER name the employer, its brands, website or anything that identifies it ('a growing manufacturer'). " +
    "role.industry: the employer's industry in a few words (from the industry given, or the employer and description). " +
    "hiring_manager_titles: 3 to 6 job titles the person this role reports to would have (e.g. for a Senior Accountant: 'Controller', 'Finance Manager', 'Head of Finance', 'CFO'); if the description says who it reports to, put that first. " +
    "contacts: anyone the description gives an email address for (e.g. 'send your CV to Jane Doe, HR Manager, jane@acme.com', or 'careers@acme.com'), with the email exactly as written; [] if none.";
  const posting = `Job: ${lead.job_title}${lead.data?.industry ? "\nEmployer industry: " + lead.data.industry : ""}\nLocation: ${lead.location || "?"} (${lead.country || "?"})${lead.salary ? "\nPay: " + lead.salary : ""}${lead.data?.remote ? "\nRemote" : ""}\nEmployer (never mention it): ${lead.company}\nDescription:\n${String(lead.description || "").slice(0, 6000)}`;
  const out = await askAI(sys, posting, 2500);
  const r = out?.role || {};
  const role: RoleFacts = {
    summary: hideEmployer(scrub(clip(r.summary, 400), []), lead), industry: hideEmployer(clip(r.industry, 80), lead), workSetup: clip(r.work_setup, 20),
    employmentType: clip(r.employment_type, 20), seniority: clip(r.seniority, 40),
    hmTitles: (Array.isArray(out?.hiring_manager_titles) ? out.hiring_manager_titles : []).map((t: unknown) => clip(t, 60)).filter(Boolean).slice(0, 6),
    noAgencies: out?.agency_policy?.no_agencies === true ? (clip(out.agency_policy.quote, 120) || "yes") : "",
  };
  const seen = new Set<string>();
  const items: JdItem[] = (Array.isArray(out?.requirements) ? out.requirements : []).map((x: any) => ({ item: hideEmployer(clip(x?.item, 100), lead), required: x?.required !== false }))
    .filter((x: JdItem) => x.item && !seen.has(x.item.toLowerCase()) && seen.add(x.item.toLowerCase())).slice(0, 15);
  return { role, items, contacts: jdContacts(String(lead.description || ""), out?.contacts) };
}

// Step 2, per candidate, reading their CV: each item met / not met / not shown, plus how the role
// meets what THEY want, and the questions to ask them first (a yes/no question for each required
// item their CV doesn't show). The decision itself is made here, not by the AI: anything required
// they don't have takes them out; required items decide the fit; nice-to-haves they meet are a bonus.
async function checkCandidate(admin: any, lead: any, role: RoleFacts, items: JdItem[], c: any, n: number): Promise<Assessed> {
  const base: Assessed = { n, fit: 0, verdict: "Not a fit", reason: "", whyRole: "", bullets: [], musts: [], notMet: [], requirements: [], questions: [], jd: [], confirm: [], out: "" };
  const cv = await cvContent(admin, c);
  if (cv.why) return { ...base, out: cv.why };
  const earlier = await earlierAnswers(admin, c.id).catch(() => "");
  const sys = "You are a senior recruiter checking one candidate against an employer's job description, strictly from the evidence. Their CV is attached; a profile summary and what they're looking for follow. " +
    "Reply with STRICT JSON only: {\"checks\": [{\"n\": number, \"status\": \"met\" | \"partial\" | \"not_met\" | \"not_shown\", \"evidence\": string}], \"confirm\": [{\"n\": number, \"q\": string}], " +
    "\"industry\": {\"status\": \"met\" | \"not_met\" | \"not_shown\", \"evidence\": string}, \"worked_at_employer\": boolean, " +
    "\"reason\": string, \"why_role\": string, \"bullets\": string[], \"requirements\": [{\"item\": string, \"theirs\": string, \"role\": string, \"status\": \"met\" | \"discuss\"}], \"questions\": [{\"q\": string, \"field\": \"pay\" | \"work_setup\" | \"location\" | \"employment_type\" | \"notice\" | \"other\"}]}. " +
    "worked_at_employer: true when their CV or profile shows they work or have EVER worked at the employer named below for this check, under any of its names " +
    "(a former name, its parent company, a subsidiary or a brand it trades as), as an employee, contractor or intern; false otherwise. Only what the CV shows: never guess from industry or location. " +
    "industry: whether they have worked in the employer's industry (given below) or a closely related one: 'met' with evidence (e.g. '5 years in manufacturing'), 'not_met' when their CV shows only other industries, 'not_shown' when unclear. This is information only. " +
    "checks: one for EVERY numbered requirement, from the evidence. 'met' only when their work history clearly shows it (described work, a qualification, the years); equivalent wording counts (e.g. 'ACA chartered accountant' for 'professional accounting qualification', 6 years for '5+ years'). " +
    "'partial' when they very likely have it but the CV doesn't describe it: it's only in a skills list, implied by a job title or by the roles they've held, or mentioned without any detail (e.g. 'Payroll' in skills but no payroll work described). evidence for partial: what the CV does show, e.g. 'Payroll listed in skills'. " +
    "'not_met' only when the CV clearly shows they don't have it (e.g. 3 years in total where 5+ are required, a different licence where only one specific licence is accepted). " +
    "'not_shown' when the CV simply doesn't say and nothing suggests it. Never mark 'met' from a job title alone. evidence: a few words from the CV for a hiring manager, anonymous (no names of people or employers), e.g. 'Licensed CPA since 2016', '7 years in manufacturing'; for not_shown ''. " +
    "Their earlier answers to our questions (if given below) count as evidence like the CV: a requirement they already answered is met or not_met from that answer, and NEVER asked again. " +
    "confirm: for each REQUIRED requirement that is 'partial' or 'not_shown', one short friendly yes/no question to the candidate ('you'), e.g. 'Do you have hands-on experience with NetSuite?'; for a partial one, mention what we can see, e.g. 'Your CV lists payroll in your skills: have you run payroll hands-on?'. " +
    "reason: one short sentence on why they fit the employer. why_role: two short sentences to the candidate ('you') on why this role is a great match for THEM (the work, the step up, the setup, the location, the pay). Warm, specific, honest. " +
    "bullets: 3 selling points for the hiring manager, each under 15 words, anonymous. " +
    "requirements: how THIS ROLE meets what the CANDIDATE is looking for, one item each for: 'Role', 'Level', 'Location', 'Work setup', 'Employment type', 'Pay'. theirs: what they want ('Not known' when we don't know); role: what this job offers ('Not stated' when the posting doesn't say); " +
    "status 'met' when the role clearly gives them what they want, 'discuss' when it doesn't clearly, or either side isn't known (negotiable, talked through). " +
    "questions: short, friendly questions to settle what's still unknown or doesn't match, at most 4, most important first: " +
    "pay (ask what salary they're looking for whenever their pay isn't known or the role's pay isn't stated, field 'pay'); work setup (when theirs isn't confirmed or doesn't match the role's, e.g. 'The role is on-site in <city>. Would that work for you, or would you need hybrid?', field 'work_setup'); " +
    "location (when they don't live near the job: commute or relocation, field 'location'); employment type (when it doesn't match or isn't known, field 'employment_type'); notice period (when not known, field 'notice'). " +
    "Never about the job description's requirements (those are in confirm), never repeating a confirm question, and never anything their earlier answers already settle. [] when nothing is unknown. NEVER name the employer anywhere.";
  const list = items.map((x, i) => `${i + 1}. ${x.item} (${x.required ? "required" : "nice to have"})`).join("\n");
  const text = `${cv.text}Employer (only for the worked_at_employer check; never mention it anywhere else): ${lead.company}${lead.company_domain ? " (" + lead.company_domain + ")" : ""}\n\nJob: ${lead.job_title}\nLocation: ${lead.location || "?"} (${lead.country || "?"})${lead.salary ? "\nPay: " + lead.salary : ""}${role.workSetup ? "\nWork setup: " + role.workSetup : ""}${role.employmentType ? "\nEmployment type: " + role.employmentType : ""}\nWhat the job is: ${role.summary}\n\n` +
    `Employer's industry: ${role.industry || "unknown"}\n\nRequirements from the job description:\n${list}\n\nCandidate profile: ${anonSummary(c)}\n${lookingFor(c)}` +
    (earlier ? `\n\nTheir earlier answers to our questions (never ask these again):\n${earlier}` : "");
  const out = await askAI(sys, cv.blocks.length ? [...cv.blocks, { type: "text", text }] : text, 3000);
  const byN = new Map<number, any>();
  for (const x of Array.isArray(out?.checks) ? out.checks : []) byN.set(Number(x?.n), x);
  const jd: JdCheck[] = items.map((it, i) => {
    const x = byN.get(i + 1);
    const status = ["met", "partial", "not_met", "not_shown"].includes(x?.status) ? x.status : "not_shown";
    return { ...it, status, evidence: ["met", "partial"].includes(status) ? scrub(clipW(x?.evidence, 120), [c]) : "" };
  });
  // Industry: always noted, never deciding (unless the job description itself asks for it, when it's
  // one of the requirements above).
  const ind = out?.industry || {};
  if (role.industry) jd.push({ item: "Industry: " + role.industry, required: false, info: true, status: ["met", "not_met"].includes(ind.status) ? ind.status : "not_shown", evidence: ind.status === "met" ? scrub(clipW(ind.evidence, 120), [c]) : "" } as JdCheck);
  const asks = new Map<number, string>();
  for (const q of Array.isArray(out?.confirm) ? out.confirm : []) asks.set(Number(q?.n), hideEmployer(clip(q?.q, 200), lead));
  const req = jd.filter((x) => x.required);
  // Partial counts as met (they very likely have it); it's still asked, to confirm.
  const met = req.filter((x) => x.status === "met" || x.status === "partial");
  const notMet = req.filter((x) => x.status === "not_met").map((x) => x.item);
  const notShown = req.filter((x) => x.status === "not_shown");
  const toAsk = req.filter((x) => x.status === "not_shown" || x.status === "partial");
  const confirm = toAsk.map((x) => ({ item: x.item, q: asks.get(items.indexOf(items.find((y) => y.item === x.item)!) + 1) || (x.status === "partial" ? `Can you confirm you have hands-on experience with: ${x.item}?` : `Do you have this: ${x.item}?`) }));
  const a: Assessed = {
    ...base, jd, notMet, confirm,
    fit: req.length ? Math.round(100 * met.length / req.length) : 0,
    verdict: notMet.length ? "Not a fit" : !notShown.length ? "Perfect fit" : "Good fit",
    reason: hideEmployer(scrub(clip(out?.reason, 300), [c]), lead), whyRole: hideEmployer(clip(out?.why_role, 400), lead),
    bullets: (Array.isArray(out?.bullets) ? out.bullets : []).slice(0, 3).map((b: unknown) => scrub(clip(b, 140), [c])),
    musts: [...met.map((x) => ({ item: x.item, evidence: x.evidence })), ...jd.filter((x) => !x.required && !x.info && x.status === "met").map((x) => ({ item: x.item, evidence: x.evidence, bonus: true })),
      // Industry experience shows to the client too, unless the job description already asked for it.
      ...jd.filter((x) => x.info && x.status === "met" && !items.some((y) => /industry|sector/i.test(y.item))).map((x) => ({ item: "Industry experience", evidence: x.evidence, bonus: true }))],
    requirements: (Array.isArray(out?.requirements) ? out.requirements : []).slice(0, 6).map((q: any) => ({
      item: clip(q?.item, 30), theirs: hideEmployer(clip(q?.theirs, 90), lead), role: hideEmployer(clip(q?.role, 90), lead), status: q?.status === "met" ? "met" : "discuss" as "met" | "discuss",
    })).filter((q: any) => q.item),
    // Never the same thing twice: a question that overlaps a yes/no confirm question is dropped.
    questions: (Array.isArray(out?.questions) ? out.questions : []).slice(0, 4)
      .map((q: any) => ({ q: hideEmployer(clip(typeof q === "string" ? q : q?.q, 240), lead), field: ["pay", "work_setup", "location", "employment_type", "notice"].includes(q?.field) ? q.field : undefined }))
      .filter((q: any) => q.q && !confirm.some((cq) => overlap(q.q, cq.item) >= 2)),
  };
  a.exEmployer = out?.worked_at_employer === true;
  a.out = a.exEmployer ? "Has worked at this company before (their CV shows it)"
    : notMet.length ? "Doesn't meet: " + notMet.join("; ")
    : notShown.length > MAX_TO_CONFIRM ? `Their CV doesn't show ${notShown.length} of the ${req.length} requirements`
    : met.length < notShown.length ? "Their CV shows too few of the requirements" : "";
  return a;
}

// How many meaningful words two texts share (to spot a repeated question).
function overlap(a: string, b: string) {
  const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !["experience", "with", "your", "have", "about", "tell", "hands"].includes(w)));
  const wb = words(b);
  return [...words(a)].filter((w) => wb.has(w)).length;
}

// Every candidate against the job description (one CV read each).
// The role's work setup as one of remote / hybrid / onsite ('' when unknown).
export function roleSetup(role: { workSetup?: string } | null, lead: any): string {
  const w = String(role?.workSetup || "").toLowerCase().replace(/[-\s]/g, "");
  if (["remote", "hybrid", "onsite"].includes(w)) return w;
  return lead?.data?.remote ? "remote" : "";
}
// Would they take a role with this setup? Judged sensibly, only on what they confirmed: unknown
// preferences or an unknown setup never rule anyone out (the pitch email asks instead). Someone who
// takes on-site work takes hybrid too; anyone can be offered a remote role.
export function setupOk(ws: unknown, setup: string): boolean {
  const list = Array.isArray(ws) ? ws.map(String) : [];
  if (!list.length || !setup || setup === "remote") return true;
  return list.includes(setup) || (setup === "hybrid" && list.includes("onsite"));
}
const SETUP_LABEL: Record<string, string> = { remote: "remote", hybrid: "hybrid", onsite: "on-site" };
export const setupMismatch = (ws: string[], setup: string) => `Work setup: they'd accept ${ws.map((x) => SETUP_LABEL[x] || x).join(" or ")}, and this role is ${SETUP_LABEL[setup] || setup}`;

export async function assessForPitch(admin: any, lead: any, cands: any[]): Promise<{ role: RoleFacts; items: JdItem[]; contacts: Contact[]; results: Assessed[] }> {
  const { role, items, contacts } = await readJobDescription(lead);
  // No agencies, or nothing to screen against: no CV is read.
  if (role.noAgencies || !items.some((x) => x.required)) return { role, items, contacts, results: [] };
  const results: Assessed[] = [];
  // Anyone whose confirmed work setup rules this role out is left out before their CV is read.
  const setup = roleSetup(role, lead);
  const wsOf = (c: any) => (Array.isArray(c?.work_setup) && c.work_setup.length ? c.work_setup : Array.isArray(c?.preferences?.workSetup) ? c.preferences.workSetup : []);
  for (let i = 0; i < cands.length; i += 3) {
    const part = await Promise.all(cands.slice(i, i + 3).map((c, k) => !setupOk(wsOf(c), setup)
      ? Promise.resolve({ n: i + k, fit: 0, verdict: "Not a fit", reason: "", whyRole: "", bullets: [], musts: [], notMet: [], requirements: [], questions: [], jd: [], confirm: [], out: setupMismatch(wsOf(c), setup) } as Assessed)
      : checkCandidate(admin, lead, role, items, c, i + k).catch((e) => {
      if (isAiPaused(e)) throw e;
      return { n: i + k, fit: 0, verdict: "Not a fit", reason: "", whyRole: "", bullets: [], musts: [], notMet: [], requirements: [], questions: [], jd: [], confirm: [], out: "The check failed: " + String((e as Error)?.message || e).slice(0, 120) } as Assessed;
    })));
    results.push(...part);
  }
  return { role, items, contacts, results };
}
export const strongEnough = (a: Assessed) => !a.out && a.jd.length > 0 && !a.notMet.length;

export function hideEmployer(t: string, lead: any): string {
  let s = String(t || "");
  const dom = String(lead?.company_domain || "");
  for (const pat of [lead?.company, dom, dom.split(".")[0]]) {
    const p = String(pat || "").trim();
    if (p.length >= 3) s = s.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "the company");
  }
  return s.replace(/https?:\/\/\S+|www\.\S+/gi, "").trim();
}

// The lead's private role (a client-lead job: Rec Ops / Admins only, never on the jobs board), and
// the candidate's link to it: the pitch's chat thread and their place in the pipeline.
export async function leadRoleJob(admin: any, lead: any): Promise<string> {
  if (lead.converted_job_id) {
    const { data: j } = await admin.from("jobs").select("id,status,lead_role").eq("id", lead.converted_job_id).maybeSingle();
    if (j && j.status !== "Closed") {
      if (!j.lead_role || j.status === "Draft") await admin.from("jobs").update({ lead_role: true, status: j.status === "Draft" ? "Open" : j.status }).eq("id", j.id);
      return j.id;
    }
  }
  const { data: j, error } = await admin.from("jobs").insert({
    role_title: lead.job_title || "Role", client: lead.company || "Client", location: lead.location || null,
    country: lead.country && String(lead.country).length === 2 ? lead.country : null, description: lead.description || null, status: "Open", lead_role: true,
  }).select("id").single();
  if (error) throw new Error("Couldn't set up the lead's role: " + error.message);
  await admin.from("leads").update({ converted_job_id: j.id }).eq("id", lead.id);
  lead.converted_job_id = j.id;
  return j.id;
}
// The role card on the candidate's profile for a pitched role IS the pitch screening: its fit,
// verdict and requirement checklist (from the job description, read against their CV). Because the
// card arrives already screened, the automatic AI screening doesn't run again and never drafts a
// second round of questions: everything we need to ask is in the one pitch email.
const CARD_VERDICT: Record<string, string> = { "Perfect fit": "Perfect fit", "Good fit": "Good fit", "Not a fit": "Reject" };
export function pitchCard(o: any) {
  const checks: any[] = Array.isArray(o?.jd_check) ? o.jd_check : [];
  const requirements = checks.slice(0, 25).map((c: any) => ({
    requirement: clip(c?.item, 160), type: c?.required !== false && !c?.info ? "must" : "preferred",
    status: ["met", "confirmed"].includes(c?.status) ? "met" : c?.status === "not_met" ? "not met" : "partial",
    evidence: clip(c?.evidence || (c?.status === "not_shown" ? "Not on their CV: asked in the pitch email" : ""), 240),
  })).filter((r: any) => r.requirement);
  const toConfirm = checks.filter((c: any) => c?.required !== false && !c?.info && c?.status === "not_shown").map((c: any) => "To confirm: " + clip(c.item, 140));
  const notMet = checks.filter((c: any) => c?.required !== false && !c?.info && c?.status === "not_met").map((c: any) => clip(c.item, 160));
  return {
    stage: "first", source: "pitch",
    summary: clip([o?.reason, toConfirm.length ? `Screened against the employer's job description; ${toConfirm.length === 1 ? "one requirement is" : toConfirm.length + " requirements are"} asked in the pitch email.` : "Screened against the employer's job description."].filter(Boolean).join(" "), 1200),
    strengths: (Array.isArray(o?.bullets) ? o.bullets : []).slice(0, 6).map((b: unknown) => clip(b, 160)),
    gaps: [...notMet, ...toConfirm].slice(0, 6),
    score: o?.fit ?? 0, verdict: CARD_VERDICT[o?.verdict] || "Possible fit", verdict_reason: clip(o?.reason, 400),
    requirements, usedResume: true, answersUsed: 0, updatedAt: new Date().toISOString(), followups: null,
  };
}
// The pitch email's questions, saved on the card as Q&A pairs (answers filled in when they reply).
export const pitchPairs = (o: any) => (Array.isArray(o?.questions) ? o.questions : [])
  .map((q: any, i: number) => ({ q: clip(typeof q === "string" ? q : q?.q, 300), a: String((Array.isArray(o?.answers) ? o.answers[i] : "") || "") })).filter((x: any) => x.q);

async function pitchLink(admin: any, jobId: string, candidateId: string, o: any = null): Promise<string | null> {
  const { data: cur } = await admin.from("candidate_jobs").select("id,stage,ai,screening_answers").eq("job_id", jobId).eq("candidate_id", candidateId).maybeSingle();
  if (cur) {
    const patch: Record<string, unknown> = {};
    if (["Withdrawn", "Rejected"].includes(cur.stage)) patch.stage = "In review";
    if (o && !cur.ai?.stage) { patch.ai = { ...pitchCard(o), ...(cur.ai?.auto ? { auto: cur.ai.auto } : {}) }; patch.fit = o.fit ?? null; }
    if (o && !(Array.isArray(cur.screening_answers) && cur.screening_answers.length)) patch.screening_answers = pitchPairs(o);
    if (Object.keys(patch).length) await admin.from("candidate_jobs").update(patch).eq("id", cur.id);
    return cur.id;
  }
  const { data, error } = await admin.from("candidate_jobs").insert({ candidate_id: candidateId, job_id: jobId, stage: "In review", candidate_response: "accepted", keep_other_roles: true,
    ...(o ? { ai: pitchCard(o), fit: o.fit ?? null, screening_answers: pitchPairs(o) } : {}) }).select("id").single();
  if (error) { console.error("pitch link", error.message); return null; }
  return data.id;
}

// ---- The candidate's email -----------------------------------------------------------------------
type Facts = { title: string; place: string; setup: string; type: string; pay: string; summary: string };
export function factsOf(lead: any): Facts {
  const r = lead.data?.role || {};
  return { title: lead.job_title || "the role", place: [lead.location, lead.data?.remote ? "Remote" : ""].filter(Boolean).join(" · "),
    setup: r.workSetup || (lead.data?.remote ? "Remote" : ""), type: r.employmentType || "", pay: lead.salary || "", summary: r.summary || "" };
}
const links = (portalToken: string, offerToken: string) => ({
  ack: `${portalBase()}/?c=${encodeURIComponent(portalToken)}&offer=${encodeURIComponent(offerToken)}&r=ack`,
  withdraw: `${portalBase()}/?c=${encodeURIComponent(portalToken)}&offer=${encodeURIComponent(offerToken)}&r=withdraw`,
  page: `${portalBase()}/?c=${encodeURIComponent(portalToken)}`,
});

// The job-description check in short, for emails and pages: required items met (or confirmed),
// still to confirm, not met, nice-to-haves met, and the industry note.
export function jdSummary(jd: unknown) {
  const list: any[] = Array.isArray(jd) ? jd : [];
  const req = list.filter((x) => x && x.required !== false && !x.info);
  const ok = req.filter((x) => x.status === "met" || x.status === "confirmed" || x.status === "partial");
  return {
    total: req.length, met: ok, toConfirm: req.filter((x) => x.status === "not_shown"), notMet: req.filter((x) => x.status === "not_met"),
    partial: req.filter((x) => x.status === "partial"),
    bonus: list.filter((x) => x && x.required === false && !x.info && x.status === "met"),
    industry: list.find((x) => x && x.info) || null,
  };
}

export function noticeEmail(b: Brand, o: { first: string; facts: Facts; whyRole?: string; requirements: any[]; jd?: unknown; fit: number | null; verdict: string; questions: number; recruiter: string; ack: string; withdraw: string; reminder?: boolean }) {
  const f = o.facts;
  // What the employer's job description asks for, and how they match it (from their CV).
  const js = jdSummary(o.jd);
  const jdRow = (mark: string, color: string, item: string, note: string) => `<tr><td style="vertical-align:top;padding:4px 8px 4px 0;color:${color};font-weight:700;font-size:14px;">${mark}</td><td style="padding:4px 0;font-size:14px;line-height:1.5;">${esc(item)}${note ? `<span style="color:#56605A;"> · ${esc(tidyCut(note))}</span>` : ""}</td></tr>`;
  const jdHtml = js.total ? `<div style="font-size:15px;font-weight:600;margin:0 0 4px;">What the employer asks for, and how you match</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;font-family:Arial,sans-serif;">
${js.met.filter((x: any) => x.status !== "partial").map((x: any) => jdRow("&#10003;", "#1F6F54", x.item, x.status === "confirmed" ? "you confirmed this" : x.evidence || "")).join("")}
${js.partial.map((x: any) => jdRow("?", "#9A6B00", x.item, (x.evidence ? x.evidence + ": " : "") + "we'll ask you to confirm")).join("")}
${js.toConfirm.map((x: any) => jdRow("?", "#9A6B00", x.item, "not on your CV, we'll ask you to confirm")).join("")}
${js.bonus.map((x: any) => jdRow("+", "#1F6F54", "Nice to have: " + x.item, x.evidence || "")).join("")}
${js.industry && js.industry.status === "met" ? jdRow("+", "#1F6F54", js.industry.item, js.industry.evidence || "") : ""}
</table>` : "";
  const row = (k: string, v: string) => v ? `<tr><td style="padding:3px 12px 3px 0;color:#56605A;font-size:13px;white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="padding:3px 0;font-size:14px;">${esc(v)}</td></tr>` : "";
  const reqRows = (o.requirements || []).map((q: any) => `<tr>
<td style="padding:8px 8px 8px 0;border-top:1px solid #EEE9DF;font-size:13px;font-weight:600;vertical-align:top;">${esc(q.item)}</td>
<td style="padding:8px;border-top:1px solid #EEE9DF;font-size:13px;color:#56605A;vertical-align:top;">${esc(q.theirs || "-")}</td>
<td style="padding:8px;border-top:1px solid #EEE9DF;font-size:13px;vertical-align:top;">${esc(q.role || "-")}</td>
<td style="padding:8px 0 8px 8px;border-top:1px solid #EEE9DF;font-size:12px;white-space:nowrap;vertical-align:top;font-weight:600;color:${q.status === "met" ? "#1F6F54" : "#9A6B00"};">${q.status === "met" ? "&#10003; Matches" : "To discuss"}</td></tr>`).join("");
  const p = (t: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${t}</p>`;
  const body =
    p(`Hi ${esc(o.first)},`) +
    (o.reminder ? p(`A quick reminder about the role below: we're getting ready to put you forward, so a quick acknowledgement helps us move faster.`) : p(`Good news: we're putting you forward for a role that matches what you're looking for. The employer's name stays private for now.`)) +
    `<div style="background:#F6F3EC;border-radius:12px;padding:14px 16px;margin:4px 0 16px;">
<div style="font-size:18px;font-weight:600;margin-bottom:6px;">${esc(f.title)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">${row("Where", f.place)}${row("Work setup", f.setup)}${row("Type", f.type)}${row("Pay", f.pay)}</table>
${f.summary ? `<div style="font-size:14px;line-height:1.55;margin-top:8px;color:#14201B;">${esc(f.summary)}</div>` : ""}
</div>` +
    (o.whyRole ? `<div style="font-size:15px;font-weight:600;margin:0 0 4px;">Why we think it suits you</div>` + p(esc(o.whyRole)) : "") +
    jdHtml +
    (reqRows ? `<div style="font-size:15px;font-weight:600;margin:0 0 4px;">How it matches what you're looking for</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:12px;font-family:Arial,sans-serif;">
<tr><td style="font-size:11px;color:#8A8578;padding:0 8px 4px 0;">&nbsp;</td><td style="font-size:11px;color:#8A8578;padding:0 8px 4px;">You</td><td style="font-size:11px;color:#8A8578;padding:0 8px 4px;">This role</td><td></td></tr>
${reqRows}</table>` : "") +
    (o.fit != null ? p(`<b>Our fit score for you: ${o.fit}%</b>${o.verdict ? " (" + esc(o.verdict) + ")" : ""}. ` +
      (js.total ? `Your CV shows ${js.met.length - js.partial.length} of the ${js.total} requirements in the employer's job description${js.toConfirm.length + js.partial.length ? `; we'll ask you to confirm the other ${js.toConfirm.length + js.partial.length === 1 ? "one" : js.toConfirm.length + js.partial.length}` : ""}.` : `That's how closely your experience matches what the employer needs.`)) : "") +
    p(`<b>Please click Acknowledge so we can put you forward.</b> We can't share your profile with the employer until you do.${o.questions ? " We have " + (o.questions === 1 ? "one quick question" : o.questions + " quick questions") + " for you, which open when you acknowledge." : ""} We'll update you as soon as the employer comes back about your profile, and if you have any questions, just reply to this email.`) +
    `<div>${button(b, o.ack, "Acknowledge")}</div>` +
    `<p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#56605A;">By acknowledging, you agree to us representing you to this employer, for this role and any other role with them, and sharing your profile with them.</p>` +
    `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#56605A;">Rather not be put forward for this one? <a href="${esc(o.withdraw)}" style="color:#56605A;">Withdraw my profile</a></p>` +
    p(`<br>${esc(o.recruiter || "The team")}<br><span style="color:#56605A;font-size:13px;">${esc(b.legal || b.name)}</span>`);
  return emailShell(b, o.reminder ? "Reminder: we're putting you forward for " + f.title : "We're putting you forward for " + f.title, body);
}
// Two reminders: the first is the full email again ("A quick reminder about the role below"); the
// second and last is this one: short, no role details. Acknowledge or withdraw; no answer within
// NO_REPLY_DAYS means they're taken off the role and "Open to new roles" is turned off (they can
// turn it back on from their candidate page, shown in the email).
export const NO_REPLY_DAYS = 3;
const replyBy = (from = new Date()) => new Date(from.getTime() + NO_REPLY_DAYS * 864e5).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
export const lastReminderSubject = (title: string) => "Action required: please acknowledge or withdraw for " + (title || "a role");
export function lastReminderEmail(b: Brand, o: { first: string; facts: Facts; recruiter: string; ack: string; withdraw: string; page: string; by?: string }) {
  const f = o.facts;
  const p = (t: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${t}</p>`;
  const by = o.by || replyBy();
  // What their candidate page shows: the "Open to new roles" switch, off and then on.
  const sw = (on: boolean) => `<td style="vertical-align:middle;padding-left:12px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:46px;height:26px;border-radius:13px;background:${on ? b.color : "#D9D4C8"};"><tr>${on ? `<td style="width:20px;"></td>` : ""}<td style="padding:3px;"><div style="width:20px;height:20px;border-radius:10px;background:#FFFFFF;"></div></td>${on ? "" : `<td style="width:20px;"></td>`}</tr></table></td>`;
  const card = (on: boolean) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid #E6E1D6;border-radius:12px;background:#FFFFFF;"><tr><td style="padding:12px 14px;font-family:Arial,sans-serif;"><div style="font-size:14px;font-weight:700;color:#14201B;">Open to new roles</div><div style="font-size:12px;line-height:1.5;color:#56605A;margin-top:2px;">${on ? "We'll put your profile forward, anonymously, for roles that fit you." : "We won't put you forward for new roles, unless you turn this back on."}</div></td>${sw(on)}<td style="width:12px;"></td></tr></table>`;
  // Stacked (off, then on), so it reads the same on a phone.
  const example = `<div style="max-width:380px;margin:6px 0 14px;">
<div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;color:#8A8578;margin:0 0 6px;">IF IT'S OFF</div>${card(false)}
<div style="font-family:Arial,sans-serif;font-size:12px;color:${b.color};font-weight:700;margin:8px 0;">&darr; Tap the switch so it turns green</div>${card(true)}
</div>`;
  const body = p(`Hi ${esc(o.first)},`) +
    p(`We don't want to fill your inbox, so <b>this is the last email we'll send you about this role</b>:`) +
    `<div style="background:#F6F3EC;border-radius:12px;padding:12px 16px;margin:0 0 16px;font-size:16px;font-weight:600;">${esc(f.title)}${f.place ? `<span style="font-weight:400;color:#56605A;font-size:14px;"> &middot; ${esc(f.place)}</span>` : ""}</div>` +
    p(`<b>Action required:</b> please click <b>Acknowledge</b> so we can put your profile forward, or <b>Withdraw my profile</b> if you'd rather not be put forward for this one.`) +
    `<div>${button(b, o.ack, "Acknowledge")} &nbsp;<a href="${esc(o.withdraw)}" style="display:inline-block;margin-top:18px;padding:11px 20px;border:1px solid #D9D4C8;color:#14201B;text-decoration:none;border-radius:10px;font-family:Arial,sans-serif;font-size:14px;font-weight:600;white-space:nowrap;">Withdraw my profile</a></div>` +
    `<p style="margin:10px 0 18px;font-size:13px;line-height:1.6;color:#56605A;">By acknowledging, you agree to us representing you to this employer, for this role and any other role with them, and sharing your profile with them.</p>` +
    p(`If we don't hear from you by <b>${esc(by)}</b>, we'll assume you don't want your profile put forward. We'll take you off this role and stop emailing you about roles you're a good fit for.`) +
    p(`Changed your mind later? That's easy: open your candidate page and turn on <b>Open to new roles</b>.`) +
    example +
    `<div>${button(b, o.page, "Open my candidate page")}</div>` +
    p(`<br>${esc(o.recruiter || "The team")}<br><span style="color:#56605A;font-size:13px;">${esc(b.legal || b.name)}</span>`);
  return emailShell(b, "Action required: acknowledge or withdraw for " + f.title, body);
}
const lastReminderText = (facts: Facts) => `Last reminder about ${facts.title}: please click Acknowledge so we can put you forward, or withdraw your profile. If we don't hear from you within ${NO_REPLY_DAYS} days, we'll take you off this role and turn off "Open to new roles" (you can turn it back on from your candidate page any time).`;
const noticeText = (facts: Facts, fit: number | null, questions: number, whyRole = "") =>
  `We're putting you forward for ${facts.title}${facts.place ? " (" + facts.place + ")" : ""}. The employer's name stays private for now.` +
  (whyRole ? " " + whyRole : "") +
  (fit != null ? ` Our fit score for you: ${fit}%.` : "") +
  ` Please click Acknowledge so we can put you forward: we can't share your profile with the employer until you do.` +
  (questions ? ` We have ${questions === 1 ? "a quick question" : questions + " quick questions"} for you, which open when you acknowledge.` : "") +
  ` If you'd rather not be put forward for this one, you can withdraw your profile.`;

// Tells one candidate (the first time, or a reminder). Returns the status they're in afterwards.
export async function notifyOffer(admin: any, offerId: string, reminder = false): Promise<{ status: string; sent: boolean; why?: string }> {
  const { data: o } = await admin.from("lead_offers").select("*").eq("id", offerId).maybeSingle();
  if (!o) return { status: "gone", sent: false, why: "not found" };
  const { data: lead } = await admin.from("leads").select("*").eq("id", o.lead_id).maybeSingle();
  const { data: c } = await admin.from("candidates").select("id,name,email,email_opt_out,portal_token,recruiter_id").eq("id", o.candidate_id).maybeSingle();
  if (!lead || !c) return { status: o.status, sent: false, why: "lead or candidate gone" };
  // Their own chat for this pitch, with the notice as its first message.
  let linkId = o.candidate_job_id;
  if (!linkId) {
    try { linkId = await pitchLink(admin, await leadRoleJob(admin, lead), c.id, o); } catch (e) { console.error("pitch role", String((e as Error)?.message || e)); }
    if (linkId) await admin.from("lead_offers").update({ candidate_job_id: linkId }).eq("id", o.id);
  }
  const facts = factsOf(lead);
  const nq = Array.isArray(o.questions) ? o.questions.length : 0;
  // Reminder 1 (full email again) while they're "notified"; reminder 2 (the last one) once reminded.
  const last = reminder && o.status === "reminded";
  const { data: rec } = c.recruiter_id ? await admin.from("profiles").select("full_name,email").eq("id", c.recruiter_id).maybeSingle() : { data: null };
  if (linkId) {
    await admin.from("candidate_job_messages").insert({ link_id: linkId, sender: "recruiter", body: last ? lastReminderText(facts) : (reminder ? "Reminder: " : "") + noticeText(facts, o.fit, nq, reminder ? "" : o.why_role || ""), staff_id: c.recruiter_id || null });
  }
  const now = new Date().toISOString();
  if (!c.email || c.email_opt_out || !c.portal_token) {
    if (!reminder) await admin.from("lead_offers").update({ status: "no_email", notified_at: now, sent_at: now }).eq("id", o.id);
    return { status: "no_email", sent: false, why: !c.email ? "no email on file" : c.email_opt_out ? "unsubscribed from emails" : "no candidate page" };
  }
  const b = await loadBrand(admin);
  const l = links(c.portal_token, o.token);
  const recFirst = String(rec?.full_name || "").split(" ")[0] || "", first = String(c.name || "").split(" ")[0] || "there";
  const html = last ? lastReminderEmail(b, { first, facts, recruiter: recFirst, ack: l.ack, withdraw: l.withdraw, page: l.page })
    : noticeEmail(b, { first, facts, whyRole: o.why_role || "", requirements: o.requirements || [], jd: o.jd_check, fit: o.fit, verdict: o.verdict || "", questions: nq, recruiter: recFirst, ack: l.ack, withdraw: l.withdraw, reminder });
  const subject = last ? lastReminderSubject(facts.title) : (reminder ? "Reminder: we're putting you forward for " : "We're putting you forward for ") + (facts.title || "a role");
  const sent = await sendBrevo(b, { email: c.email, name: c.name }, subject, html, undefined, { replyTo: rec?.email ? { email: rec.email, name: rec.full_name || undefined } : null });
  if (last) { if (sent) await admin.from("lead_offers").update({ final_reminder_at: now }).eq("id", o.id); }
  else if (reminder) await admin.from("lead_offers").update({ status: sent ? "reminded" : o.status, reminded_at: now }).eq("id", o.id);
  else await admin.from("lead_offers").update({ status: sent ? "notified" : "no_email", notified_at: now, sent_at: now }).eq("id", o.id);
  await admin.from("candidate_timeline").insert({ candidate_id: c.id, title: (last ? "Last reminder sent: put forward for " : reminder ? "Reminder sent: put forward for " : "Told they're being put forward for ") + facts.title + (sent ? "" : " (email didn't send)"), done: true });
  return { status: sent ? (reminder ? "reminded" : "notified") : "no_email", sent, ...(sent ? {} : { why: "the email didn't send" }) };
}

// Reminders are never sent automatically (every email is reviewed first): the lead card shows
// "Reminder due" once someone has had 2 days without responding. Kept as a no-op for the tick.
// No answer NO_REPLY_DAYS after the last reminder (as that email says): taken off the role and
// "Open to new roles" turned off, as if they'd switched it off themselves (we ask again in a year).
export async function stepReminders(admin: any, n = 20) {
  const cutoff = new Date(Date.now() - NO_REPLY_DAYS * 864e5).toISOString();
  const { data: rows } = await admin.from("lead_offers").select("id,candidate_id,lead_id,candidate_job_id").eq("status", "reminded").is("acknowledged_at", null)
    .not("final_reminder_at", "is", null).lt("final_reminder_at", cutoff).limit(n);
  let closed = 0;
  for (const o of rows || []) {
    const now = new Date().toISOString();
    const { data: done } = await admin.from("lead_offers").update({ status: "withdrawn", withdrawn_at: now, withdrawn_by: "no_response", note: "No response to the last reminder" })
      .eq("id", o.id).eq("status", "reminded").is("acknowledged_at", null).select("id");
    if (!done || !done.length) continue;
    if (o.candidate_job_id) await admin.from("candidate_jobs").update({ stage: "Withdrawn" }).eq("id", o.candidate_job_id).not("stage", "in", "(Withdrawn,Rejected,Placed)");
    await admin.from("candidates").update({ open_to_roles: false, open_paused_until: new Date(Date.now() + 365 * 864e5).toISOString(), open_changed_at: now }).eq("id", o.candidate_id).eq("open_to_roles", true);
    const { data: lead } = await admin.from("leads").select("job_title").eq("id", o.lead_id).maybeSingle();
    await admin.from("candidate_timeline").insert({ candidate_id: o.candidate_id, title: `No response to the last reminder about ${lead?.job_title || "a role"}: taken off it, and "Open to new roles" turned off`, done: true });
    closed++;
  }
  return { reminded: 0, closed };
}

// The email a candidate would get, for review before sending (same as the real one).
export async function previewOffer(admin: any, offerId: string, reminder = false) {
  const { data: o } = await admin.from("lead_offers").select("*").eq("id", offerId).maybeSingle();
  if (!o) throw new Error("Not found");
  const { data: lead } = await admin.from("leads").select("*").eq("id", o.lead_id).maybeSingle();
  const { data: c } = await admin.from("candidates").select("name,email,email_opt_out,portal_token,recruiter_id").eq("id", o.candidate_id).maybeSingle();
  const { data: rec } = c?.recruiter_id ? await admin.from("profiles").select("full_name,email").eq("id", c.recruiter_id).maybeSingle() : { data: null };
  const b = await loadBrand(admin);
  const facts = factsOf(lead || {});
  const l = links(c?.portal_token || "preview", o.token);
  const first = String(c?.name || "").split(" ")[0] || "there", recFirst = String(rec?.full_name || "").split(" ")[0] || "";
  const last = reminder && o.status === "reminded";
  const html = last ? lastReminderEmail(b, { first, facts, recruiter: recFirst, ack: l.ack, withdraw: l.withdraw, page: l.page })
    : noticeEmail(b, { first, facts, whyRole: o.why_role || "", requirements: o.requirements || [], jd: o.jd_check, fit: o.fit, verdict: o.verdict || "",
      questions: Array.isArray(o.questions) ? o.questions.length : 0, recruiter: recFirst, ack: l.ack, withdraw: l.withdraw, reminder });
  return { ok: true, html, last, subject: last ? lastReminderSubject(facts.title) : (reminder ? "Reminder: we're putting you forward for " : "We're putting you forward for ") + (facts.title || "a role"),
    to: c?.email || "", canEmail: !!(c?.email && !c.email_opt_out && c.portal_token), replyTo: rec?.email || "" };
}

// Edits before sending: the "why it suits you" text and the questions.
export async function updateOffer(admin: any, offerId: string, patch: { whyRole?: unknown; questions?: unknown }) {
  const { data: o } = await admin.from("lead_offers").select("id,status,answers,questions").eq("id", offerId).maybeSingle();
  if (!o) throw new Error("Not found");
  const upd: Record<string, unknown> = {};
  if (patch.whyRole !== undefined) upd.why_role = String(patch.whyRole || "").trim().slice(0, 600) || null;
  if (Array.isArray(patch.questions)) {
    if (Array.isArray(o.answers) && o.answers.length) throw new Error("They've already answered");
    // Edited text keeps its place: a question that confirms a job-description requirement stays a
    // yes/no confirmation (matched by its text, or by its position when none were added or removed).
    const before: any[] = Array.isArray(o.questions) ? o.questions : [];
    upd.questions = patch.questions.map((q, i) => ({ text: String((q as any)?.q ?? q ?? "").trim().slice(0, 240), was: before.find((b) => (b?.q ?? b) === String((q as any)?.q ?? q ?? "").trim()) || ((patch.questions as unknown[]).length === before.length ? before[i] : null) }))
      .map((x, i) => ({ ...x, yesno: !!(patch.questions as any[])[i]?.yesno }))
      .filter((x) => x.text).slice(0, MAX_QUESTIONS).map((x) => (x.was && typeof x.was === "object" && x.was.confirm ? { q: x.text, confirm: x.was.confirm } : { q: x.text, ...(x.yesno ? { yesno: true } : {}), ...(x.was && typeof x.was === "object" && x.was.field ? { field: x.was.field } : {}) }));
  }
  if (Object.keys(upd).length) await admin.from("lead_offers").update(upd).eq("id", o.id);
  return { ok: true, message: "Saved" };
}

// The role card on their profile lists the pitch questions (unanswered until they reply): kept in
// step when a question is added or removed.
async function syncCardQuestions(admin: any, linkId: string | null, questions: any[]) {
  if (!linkId) return;
  await admin.from("candidate_jobs").update({ screening_answers: pitchPairs({ questions }) }).eq("id", linkId);
}

// Rec Ops / Admin: a question the AI missed, added before the candidate answers. A yes/no
// question shows Yes / No buttons on their page. Once they've answered (or are already through to
// the pitch), ask in their chat instead.
export const MAX_QUESTIONS = 6;
export async function addQuestion(admin: any, offerId: string, q: unknown, yesno: boolean) {
  const text = String(q || "").trim().slice(0, 240);
  if (text.length < 5) throw new Error("Write the question first");
  const { data: o } = await admin.from("lead_offers").select("id,status,questions,answers,candidate_job_id").eq("id", offerId).maybeSingle();
  if (!o) throw new Error("Not found");
  if (Array.isArray(o.answers) && o.answers.length) throw new Error("They've already answered. Ask in their chat instead");
  if (!["draft", "notified", "reminded", "no_email", "acknowledged"].includes(o.status)) throw new Error("They're already through to the pitch. Ask in their chat instead");
  const qs: any[] = Array.isArray(o.questions) ? o.questions : [];
  if (qs.length >= MAX_QUESTIONS) throw new Error(`Up to ${MAX_QUESTIONS} questions`);
  const next = [...qs, yesno ? { q: text, yesno: true } : { q: text }];
  await admin.from("lead_offers").update({ questions: next }).eq("id", o.id);
  await syncCardQuestions(admin, o.candidate_job_id, next);
  return { ok: true, message: o.status === "draft" ? "Question added" : "Question added. They'll see it when they acknowledge" };
}

// Rec Ops / Admin: drop a question we don't need. With none left, someone who has acknowledged is
// ready for the pitch.
export async function removeQuestion(admin: any, me: { id: string; name: string }, offerId: string, index: number) {
  const { data: o } = await admin.from("lead_offers").select("id,status,questions,answers,candidate_job_id").eq("id", offerId).maybeSingle();
  if (!o) throw new Error("Not found");
  if (Array.isArray(o.answers) && o.answers.length) throw new Error("They've already answered");
  const qs = (Array.isArray(o.questions) ? o.questions : []).filter((_: unknown, i: number) => i !== index);
  const upd: Record<string, unknown> = { questions: qs };
  if (!qs.length && o.status === "acknowledged") Object.assign(upd, { status: "ready", ready_at: new Date().toISOString() });
  await admin.from("lead_offers").update(upd).eq("id", o.id);
  await syncCardQuestions(admin, o.candidate_job_id, qs);
  return { ok: true, message: qs.length ? "Question removed" : o.status === "acknowledged" ? "Question removed. They're ready for the pitch" : "Question removed" };
}

// Rec Ops / Admin actions on one candidate of a pitch.
export async function offerAction(admin: any, me: { id: string; name: string }, offerId: string, action: "send" | "push" | "withdraw" | "remove" | "remind" | "restore") {
  const { data: o } = await admin.from("lead_offers").select("*").eq("id", offerId).maybeSingle();
  if (!o) throw new Error("Not found");
  const { data: lead } = await admin.from("leads").select("job_title").eq("id", o.lead_id).maybeSingle();
  const role = lead?.job_title || "a role";
  const now = new Date().toISOString();
  const tl = (title: string) => admin.from("candidate_timeline").insert({ candidate_id: o.candidate_id, title: title + (me.name ? " · by " + me.name : ""), done: true });
  if (action === "send") {
    if (o.status !== "draft") throw new Error("This email has already gone");
    const r = await notifyOffer(admin, o.id);
    if (r.sent) await tl("Pitch email reviewed and sent for " + role);
    return { ok: true, message: r.sent ? "Email sent" : "Couldn't email them: " + (r.why || "no email") + ". Add their email so they can acknowledge, or take them off." };
  }
  if (action === "remind") {
    if (o.status === "reminded" && o.final_reminder_at) throw new Error("They've already had the last reminder. We don't send another");
    if (!["notified", "reminded"].includes(o.status)) throw new Error("Only someone still waiting can be reminded");
    const lastOne = o.status === "reminded";
    const r = await notifyOffer(admin, o.id, true);
    return { ok: true, message: r.sent ? (lastOne ? "Last reminder sent" : "Reminder sent") : "Couldn't send the reminder: " + (r.why || "no email") };
  }
  // Only after they've clicked Acknowledge (e.g. without waiting for their answers): nobody goes
  // into a pitch without acknowledging. A call is to get them to click it, not a stand-in for it.
  if (action === "push") {
    if (OUT.includes(o.status) || ["pitched", "ready"].includes(o.status)) throw new Error("They're not waiting");
    if (!o.acknowledged_at) throw new Error("They have to click Acknowledge in the email first. Call them and ask them to click it, or send a reminder");
    await admin.from("lead_offers").update({ status: "ready", ready_at: now, note: "Put through by " + (me.name || "Rec Ops") }).eq("id", o.id);
    await tl("Put through for the pitch for " + role + " without waiting for their answers");
    return { ok: true, message: "Ready for the pitch" };
  }
  // Put back someone we took off (by mistake): where they were before, on the lead's role again.
  // Someone who withdrew themselves isn't put back: that was their choice.
  if (action === "restore") {
    if (!OUT.includes(o.status)) throw new Error("They're still being considered");
    if (o.status === "withdrawn" && o.withdrawn_by === "candidate") throw new Error("They withdrew themselves, so they can't be put back from here. Message them first");
    const nq = Array.isArray(o.questions) ? o.questions.length : 0;
    const answered = Array.isArray(o.answers) && o.answers.length > 0;
    const back = o.acknowledged_at ? (answered || !nq ? "ready" : "acknowledged") : o.notified_at ? "notified" : "draft";
    await admin.from("lead_offers").update({ status: back, removed_at: null, removed_by: null, withdrawn_at: null, withdrawn_by: null, note: "Put back by " + (me.name || "Rec Ops"), ...(back === "ready" && !o.ready_at ? { ready_at: now } : {}) }).eq("id", o.id);
    if (o.candidate_job_id) await admin.from("candidate_jobs").update({ stage: "In review" }).eq("id", o.candidate_job_id).eq("stage", "Withdrawn");
    // A lead let go because everyone was off it is back to asking its candidates.
    await admin.from("leads").update({ status: "awaiting", notes: null }).eq("id", o.lead_id).eq("status", "ignored");
    await tl("Put back into consideration for " + role);
    return { ok: true, message: "Put back into consideration" };
  }
  if (OUT.includes(o.status)) return { ok: true, message: "Already off this pitch" };
  await admin.from("lead_offers").update(action === "withdraw"
    ? { status: "withdrawn", withdrawn_at: now, withdrawn_by: "agency", note: "Withdrawn by " + (me.name || "Rec Ops") }
    : { status: "removed", removed_at: now, removed_by: me.id, note: "Removed by " + (me.name || "Rec Ops") }).eq("id", o.id);
  if (o.candidate_job_id) await admin.from("candidate_jobs").update({ stage: "Withdrawn" }).eq("id", o.candidate_job_id).not("stage", "in", "(Withdrawn,Rejected,Placed)");
  await tl((action === "withdraw" ? "Withdrawn from the pitch for " : "Removed from consideration for ") + role);
  return { ok: true, message: action === "withdraw" ? "Withdrawn from the pitch" : "Removed from consideration" };
}
