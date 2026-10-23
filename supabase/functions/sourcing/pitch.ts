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
// Admin reviews (edit "why it suits you", drop questions) and sends; a reminder is due after 2
// days with no response and is sent from the lead card. Then it waits for Rec Ops / an Admin to push them
// through or take them off. Each candidate has their own status (lead_offers), so a pitch can go
// with some candidates and not others.

import { askAI } from "./ai.ts";
import { anonSummary, scrub, type Settings } from "./common.ts";
import { button, emailShell, esc, loadBrand, sendBrevo, type Brand } from "./brand.ts";
import { portalBase } from "./queue.ts";

export const REMIND_AFTER_MS = 2 * 864e5;
export const PENDING = ["draft", "notified", "reminded", "no_email", "acknowledged"];
export const OUT = ["withdrawn", "removed"];
// The bar: only someone the employer is unlikely to find better than.
export const MIN_PITCH_FIT = 80;

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// What a candidate is looking for, from their job preferences and profile (for the AI).
export function lookingFor(c: any): string {
  const p = c?.preferences && typeof c.preferences === "object" ? c.preferences : {};
  const pick: Record<string, unknown> = {};
  for (const k of ["roles", "seniority", "employmentTypes", "salary", "currentCity", "currentCountry", "relocate", "preferredCities", "workSetup", "availability"]) {
    const v = (p as any)[k];
    if (v != null && v !== "" && !(Array.isArray(v) && !v.length)) pick[k] = v;
  }
  return [
    Object.keys(pick).length ? "Job preferences: " + JSON.stringify(pick).slice(0, 700) : "Job preferences: not filled in",
    c?.pay && c.pay !== "-" ? "Pay they want: " + clip(c.pay, 80) : "",
    c?.location ? "Lives in: " + clip(c.location, 100) : "",
  ].filter(Boolean).join(" | ");
}

export type Assessed = {
  n: number; fit: number; verdict: string; reason: string; whyRole: string; bullets: string[];
  notMet: string[]; requirements: { item: string; theirs: string; role: string; status: "met" | "discuss" }[]; questions: string[];
};
export type RoleFacts = { summary: string; workSetup: string; employmentType: string; seniority: string };

// One AI question per lead: the role (anonymised) and, for each candidate, the fit, what the
// posting needs that they clearly lack, how the role meets what they want, and questions to ask.
export async function assessForPitch(lead: any, cands: any[]): Promise<{ role: RoleFacts; results: Assessed[] }> {
  const sys = "You are a senior recruiter at an agency deciding which of our candidates to put forward for an employer's job posting. The bar is very high: " +
    "only someone who is a very strong fit and that the employer is unlikely to find better than. Reply with STRICT JSON only: " +
    "{\"role\": {\"summary\": string, \"work_setup\": \"On-site\" | \"Hybrid\" | \"Remote\" | \"\", \"employment_type\": \"Full-time\" | \"Part-time\" | \"Contract\" | \"Temporary\" | \"\", \"seniority\": string}, " +
    "\"results\": [{\"n\": number, \"fit\": number, \"verdict\": \"Perfect fit\" | \"Good fit\" | \"Possible fit\" | \"Not a fit\", \"must_haves_not_met\": string[], \"reason\": string, \"why_role\": string, \"bullets\": string[], " +
    "\"requirements\": [{\"item\": string, \"theirs\": string, \"role\": string, \"status\": \"met\" | \"discuss\"}], \"questions\": string[]}]}. " +
    "role.summary: two short sentences on what the job is, for the candidate. NEVER name the employer, its brands, website or anything that identifies it ('a growing manufacturer', 'a regional bank'). " +
    "fit: a percentage 0-100 for how well their experience fits this posting. verdict: 'Perfect fit' or 'Good fit' only when they're a very strong match on experience, skills, seniority and industry. " +
    "must_haves_not_met: the posting's real requirements (licences, years, specific experience) that their profile clearly does NOT meet; [] when none. Missing information is not 'not met'. " +
    "reason: one short sentence on why they fit the employer. why_role: two short sentences to the candidate ('you') on why this role is a great match for THEM: what it gives them that they're looking for (the work, the step up, the setup, the location, the pay). Warm, specific, honest; never name the employer. " +
    "bullets: 3 selling points for the hiring manager, each under 15 words, anonymous (no names, no employer names). " +
    "requirements: how THIS ROLE meets what the CANDIDATE is looking for, one item each for: 'Role' (the roles they want or their current title vs this job), 'Level', 'Location' (where they live, or cities they'd move to, vs where the job is), " +
    "'Work setup', 'Employment type', 'Pay' (only when both their expectation and the job's pay are known). theirs: what they want, in a few words. role: what this job offers, in a few words. " +
    "status 'met' when the role clearly gives them what they want; 'discuss' when it doesn't clearly, or isn't stated (these are negotiable, so they're talked through, not ruled out). Leave out an item only when neither side is known. " +
    "questions: up to 3 short, friendly questions we should ask the candidate before putting them forward: about 'discuss' items, or anything the employer will want confirmed. Never name the employer. [] when none.";
  const posting = `Job: ${lead.job_title}\nLocation: ${lead.location || "?"} (${lead.country || "?"})${lead.salary ? "\nPay: " + lead.salary : ""}${lead.data?.remote ? "\nRemote" : ""}\nEmployer (never mention it): ${lead.company}\nDescription:\n${String(lead.description || "").slice(0, 4000)}`;
  const list = cands.map((c: any, i: number) => `n=${i} | ${anonSummary(c)} | ${lookingFor(c)}`).join("\n");
  const out = await askAI(sys, posting + "\n\nCandidates:\n" + list, 4000);
  const r = out?.role || {};
  const role: RoleFacts = { summary: scrub(clip(r.summary, 400), []), workSetup: clip(r.work_setup, 20), employmentType: clip(r.employment_type, 20), seniority: clip(r.seniority, 40) };
  const results: Assessed[] = (Array.isArray(out?.results) ? out.results : []).map((x: any) => ({
    n: Number(x?.n), fit: Math.max(0, Math.min(100, Math.round(Number(x?.fit) > 0 && Number(x?.fit) <= 10 ? Number(x.fit) * 10 : Number(x?.fit) || 0))),
    verdict: ["Perfect fit", "Good fit", "Possible fit", "Not a fit"].includes(x?.verdict) ? x.verdict : "Possible fit",
    reason: clip(x?.reason, 300), whyRole: clip(x?.why_role, 400), bullets: (Array.isArray(x?.bullets) ? x.bullets : []).slice(0, 3).map((b: unknown) => clip(b, 140)),
    notMet: (Array.isArray(x?.must_haves_not_met) ? x.must_haves_not_met : []).map((b: unknown) => clip(b, 120)).filter(Boolean),
    requirements: (Array.isArray(x?.requirements) ? x.requirements : []).slice(0, 6).map((q: any) => ({
      item: clip(q?.item, 30), theirs: clip(q?.theirs, 90), role: clip(q?.role, 90), status: q?.status === "met" ? "met" : "discuss" as "met" | "discuss",
    })).filter((q: any) => q.item),
    questions: (Array.isArray(x?.questions) ? x.questions : []).slice(0, 3).map((q: unknown) => clip(q, 240)).filter(Boolean),
  }));
  // The employer's name never reaches the candidate.
  const hide = (t: string) => hideEmployer(t, lead);
  role.summary = hide(role.summary);
  for (const a of results) {
    a.requirements = a.requirements.map((q) => ({ ...q, theirs: hide(q.theirs), role: hide(q.role) }));
    a.questions = a.questions.map(hide);
    a.whyRole = hide(a.whyRole);
  }
  return { role, results };
}
export const strongEnough = (a: Assessed) => ["Perfect fit", "Good fit"].includes(a.verdict) && a.fit >= MIN_PITCH_FIT && !a.notMet.length;

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
async function pitchLink(admin: any, jobId: string, candidateId: string): Promise<string | null> {
  const { data: cur } = await admin.from("candidate_jobs").select("id,stage").eq("job_id", jobId).eq("candidate_id", candidateId).maybeSingle();
  if (cur) {
    if (["Withdrawn", "Rejected"].includes(cur.stage)) await admin.from("candidate_jobs").update({ stage: "In review" }).eq("id", cur.id);
    return cur.id;
  }
  const { data, error } = await admin.from("candidate_jobs").insert({ candidate_id: candidateId, job_id: jobId, stage: "In review", candidate_response: "accepted", keep_other_roles: true }).select("id").single();
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
});

export function noticeEmail(b: Brand, o: { first: string; facts: Facts; whyRole?: string; requirements: any[]; fit: number | null; verdict: string; questions: number; recruiter: string; ack: string; withdraw: string; reminder?: boolean }) {
  const f = o.facts;
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
    (reqRows ? `<div style="font-size:15px;font-weight:600;margin:0 0 4px;">How it matches what you're looking for</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:12px;font-family:Arial,sans-serif;">
<tr><td style="font-size:11px;color:#8A8578;padding:0 8px 4px 0;">&nbsp;</td><td style="font-size:11px;color:#8A8578;padding:0 8px 4px;">You</td><td style="font-size:11px;color:#8A8578;padding:0 8px 4px;">This role</td><td></td></tr>
${reqRows}</table>` : "") +
    (o.fit != null ? p(`<b>Our fit score for you: ${o.fit}%</b>${o.verdict ? " (" + esc(o.verdict) + ")" : ""}. That's how closely your experience matches what the employer needs.`) : "") +
    p(`<b>You don't need to do anything.</b> We'll update you as soon as the employer comes back about your profile. If we have any questions we'll reach out${o.questions ? " (we have " + (o.questions === 1 ? "one quick question" : o.questions + " quick questions") + ", which open when you acknowledge)" : ""}, and if you have any, just reply to this email.`) +
    `<div>${button(b, o.ack, "Acknowledge")}</div>` +
    `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#56605A;">Rather not be put forward for this one? <a href="${esc(o.withdraw)}" style="color:#56605A;">Withdraw my profile</a></p>` +
    p(`<br>${esc(o.recruiter || "The team")}<br><span style="color:#56605A;font-size:13px;">${esc(b.legal || b.name)}</span>`);
  return emailShell(b, o.reminder ? "Reminder: we're putting you forward for " + f.title : "We're putting you forward for " + f.title, body);
}
const noticeText = (facts: Facts, fit: number | null, questions: number, whyRole = "") =>
  `We're putting you forward for ${facts.title}${facts.place ? " (" + facts.place + ")" : ""}. The employer's name stays private for now.` +
  (whyRole ? " " + whyRole : "") +
  (fit != null ? ` Our fit score for you: ${fit}%.` : "") +
  ` You don't need to do anything: we'll update you when the employer comes back about your profile.` +
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
    try { linkId = await pitchLink(admin, await leadRoleJob(admin, lead), c.id); } catch (e) { console.error("pitch role", String((e as Error)?.message || e)); }
    if (linkId) await admin.from("lead_offers").update({ candidate_job_id: linkId }).eq("id", o.id);
  }
  const facts = factsOf(lead);
  const nq = Array.isArray(o.questions) ? o.questions.length : 0;
  const { data: rec } = c.recruiter_id ? await admin.from("profiles").select("full_name,email").eq("id", c.recruiter_id).maybeSingle() : { data: null };
  if (linkId) {
    await admin.from("candidate_job_messages").insert({ link_id: linkId, sender: "recruiter", body: (reminder ? "Reminder: " : "") + noticeText(facts, o.fit, nq, reminder ? "" : o.why_role || ""), staff_id: c.recruiter_id || null });
  }
  const now = new Date().toISOString();
  if (!c.email || c.email_opt_out || !c.portal_token) {
    if (!reminder) await admin.from("lead_offers").update({ status: "no_email", notified_at: now, sent_at: now }).eq("id", o.id);
    return { status: "no_email", sent: false, why: !c.email ? "no email on file" : c.email_opt_out ? "unsubscribed from emails" : "no candidate page" };
  }
  const b = await loadBrand(admin);
  const l = links(c.portal_token, o.token);
  const html = noticeEmail(b, { first: String(c.name || "").split(" ")[0] || "there", facts, whyRole: o.why_role || "", requirements: o.requirements || [], fit: o.fit, verdict: o.verdict || "", questions: nq,
    recruiter: String(rec?.full_name || "").split(" ")[0] || "", ack: l.ack, withdraw: l.withdraw, reminder });
  const subject = (reminder ? "Reminder: we're putting you forward for " : "We're putting you forward for ") + (facts.title || "a role");
  const sent = await sendBrevo(b, { email: c.email, name: c.name }, subject, html, undefined, { replyTo: rec?.email ? { email: rec.email, name: rec.full_name || undefined } : null });
  if (reminder) await admin.from("lead_offers").update({ status: sent ? "reminded" : o.status, reminded_at: now }).eq("id", o.id);
  else await admin.from("lead_offers").update({ status: sent ? "notified" : "no_email", notified_at: now, sent_at: now }).eq("id", o.id);
  await admin.from("candidate_timeline").insert({ candidate_id: c.id, title: (reminder ? "Reminder sent: put forward for " : "Told they're being put forward for ") + facts.title + (sent ? "" : " (email didn't send)"), done: true });
  return { status: sent ? (reminder ? "reminded" : "notified") : "no_email", sent, ...(sent ? {} : { why: "the email didn't send" }) };
}

// Reminders are never sent automatically (every email is reviewed first): the lead card shows
// "Reminder due" once someone has had 2 days without responding. Kept as a no-op for the tick.
export async function stepReminders(_admin: any, _n = 10) { return { reminded: 0 }; }

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
  const html = noticeEmail(b, { first: String(c?.name || "").split(" ")[0] || "there", facts, whyRole: o.why_role || "", requirements: o.requirements || [], fit: o.fit, verdict: o.verdict || "",
    questions: Array.isArray(o.questions) ? o.questions.length : 0, recruiter: String(rec?.full_name || "").split(" ")[0] || "", ack: l.ack, withdraw: l.withdraw, reminder });
  return { ok: true, html, subject: (reminder ? "Reminder: we're putting you forward for " : "We're putting you forward for ") + (facts.title || "a role"),
    to: c?.email || "", canEmail: !!(c?.email && !c.email_opt_out && c.portal_token), replyTo: rec?.email || "" };
}

// Edits before sending: the "why it suits you" text and the questions.
export async function updateOffer(admin: any, offerId: string, patch: { whyRole?: unknown; questions?: unknown }) {
  const { data: o } = await admin.from("lead_offers").select("id,status,answers").eq("id", offerId).maybeSingle();
  if (!o) throw new Error("Not found");
  const upd: Record<string, unknown> = {};
  if (patch.whyRole !== undefined) upd.why_role = String(patch.whyRole || "").trim().slice(0, 600) || null;
  if (Array.isArray(patch.questions)) {
    if (Array.isArray(o.answers) && o.answers.length) throw new Error("They've already answered");
    upd.questions = patch.questions.map((q) => String((q as any)?.q ?? q ?? "").trim().slice(0, 240)).filter(Boolean).slice(0, 5).map((q) => ({ q }));
  }
  if (Object.keys(upd).length) await admin.from("lead_offers").update(upd).eq("id", o.id);
  return { ok: true, message: "Saved" };
}

// Rec Ops / Admin: drop a question we don't need. With none left, someone who has acknowledged is
// ready for the pitch.
export async function removeQuestion(admin: any, me: { id: string; name: string }, offerId: string, index: number) {
  const { data: o } = await admin.from("lead_offers").select("id,status,questions,answers").eq("id", offerId).maybeSingle();
  if (!o) throw new Error("Not found");
  if (Array.isArray(o.answers) && o.answers.length) throw new Error("They've already answered");
  const qs = (Array.isArray(o.questions) ? o.questions : []).filter((_: unknown, i: number) => i !== index);
  const upd: Record<string, unknown> = { questions: qs };
  if (!qs.length && o.status === "acknowledged") Object.assign(upd, { status: "ready", ready_at: new Date().toISOString() });
  await admin.from("lead_offers").update(upd).eq("id", o.id);
  return { ok: true, message: qs.length ? "Question removed" : o.status === "acknowledged" ? "Question removed. They're ready for the pitch" : "Question removed" };
}

// Rec Ops / Admin actions on one candidate of a pitch.
export async function offerAction(admin: any, me: { id: string; name: string }, offerId: string, action: "send" | "push" | "withdraw" | "remove" | "remind") {
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
    return { ok: true, message: r.sent ? "Email sent" : "Couldn't email them: " + (r.why || "no email") + ". Put them through or take them off." };
  }
  if (action === "remind") {
    if (!["notified", "reminded"].includes(o.status)) throw new Error("Only someone still waiting can be reminded");
    const r = await notifyOffer(admin, o.id, true);
    return { ok: true, message: r.sent ? "Reminder sent" : "Couldn't send the reminder: " + (r.why || "no email") };
  }
  if (action === "push") {
    if (OUT.includes(o.status) || o.status === "pitched") throw new Error("They're not waiting");
    await admin.from("lead_offers").update({ status: "ready", ready_at: now, note: "Put through by " + (me.name || "Rec Ops") }).eq("id", o.id);
    await tl("Put through for the pitch for " + role + " without waiting");
    return { ok: true, message: "Ready for the pitch" };
  }
  if (OUT.includes(o.status)) return { ok: true, message: "Already off this pitch" };
  await admin.from("lead_offers").update(action === "withdraw"
    ? { status: "withdrawn", withdrawn_at: now, withdrawn_by: "agency", note: "Withdrawn by " + (me.name || "Rec Ops") }
    : { status: "removed", removed_at: now, removed_by: me.id, note: "Removed by " + (me.name || "Rec Ops") }).eq("id", o.id);
  if (o.candidate_job_id) await admin.from("candidate_jobs").update({ stage: "Withdrawn" }).eq("id", o.candidate_job_id).not("stage", "in", "(Withdrawn,Rejected,Placed)");
  await tl((action === "withdraw" ? "Withdrawn from the pitch for " : "Removed from consideration for ") + role);
  return { ok: true, message: action === "withdraw" ? "Withdrawn from the pitch" : "Removed from consideration" };
}
