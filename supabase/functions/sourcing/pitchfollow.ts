// Follow-ups to a client pitch, sent by hand. Nothing goes out on its own: when one is due, the
// person who sent the pitch and the Admins are told, and the lead card shows "Follow-up N of 3 due".
// They review the drafted email (To, Subject, Body all editable) and press Send.
//
// Timing, in business days (Mon-Fri) after the pitch went out: 2, 5 and 7. A late follow-up pushes
// the next one back so there's always the same gap between them.
//
// Follow-ups stop for good when any of these is true:
//   * the lead moved on (they clicked "We're interested", signed our terms, or someone set the
//     lead to In talks / Won / Lost: anything but Contacted);
//   * they replied: an email reply (seen once client replies are on, Outreach > Setup; it also moves
//     the lead to Replied), a reply through Apollo, or a request to discuss our terms;
//   * the follow-ups were stopped on the lead ("Stop follow-ups");
//   * nobody is left to email (every contact unsubscribed, bounced or was removed);
//   * none of the pitched candidates is still in the running;
//   * all three have been sent.
// Each follow-up replies in the pitch's thread ("Re: <pitch subject>"), one email per contact, with
// the same unsubscribe footer as the pitch, and counts towards the Brevo daily limit for client emails.

import { regionOf, countryCode, type Region } from "./regions.ts";
import { brevoReady, emailHash, provider, sendBrevoOutreach, sendMail } from "./send.ts";
import type { Settings } from "./common.ts";
import { footerHtml, introOf, noteHtml, signHtml } from "./outreach.ts";
import { button, emailShell, loadBrand } from "./brand.ts";
import { greet } from "./contacts.ts";
import { agreementFor } from "./clientflow.ts";
import { finalBody, linkFor, pitchCands, pitchRecipients, portalBase } from "./queue.ts";

export const FOLLOWUP_GAPS = [2, 5, 7];
const DEAD = ["hard_bounce", "blocked", "spam", "invalid_email", "unsubscribed"];

function addBusinessDays(from: Date, n: number) {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) left--;
  }
  return d;
}
const subjectOf = (l: any) => l.pitch_subject || `Candidate for your ${l.job_title} role`;
const reSubject = (s: string) => /^re:/i.test(s.trim()) ? s.trim() : "Re: " + s.trim();
const reqText = (c: { reqMet?: number; reqTotal?: number }) => c.reqMet === c.reqTotal ? `all ${c.reqTotal} requirements` : `${c.reqMet} of the ${c.reqTotal} requirements`;
const firstName = (n: string) => String(n || "").trim().split(/\s+/)[0] || "";

export type FollowupState = {
  step: number;            // the next follow-up (1..3), or 0 when there's none to send
  sent: number;            // how many have gone out
  dueAt: string | null;    // when the next one is due
  due: boolean;            // it's due now
  stopped: string;         // why follow-ups have stopped ("" while they're on)
  paused: boolean;
  pitchSentAt: string | null;
  history: { n: number; at: string; to: string[] }[];
  recipients: { email: string; name: string; first: string; token: string; ref: string }[];
};

// Where a lead is with its follow-ups, from what's been sent and what's happened since.
export async function followupState(admin: any, l: any): Promise<FollowupState> {
  const { data: msgs } = await admin.from("outreach_messages").select("id,to_email,subject,status,provider_ref,sent_at,followup,approved_by")
    .eq("lead_id", l.id).eq("kind", "client").eq("status", "sent").order("sent_at");
  const all = msgs || [];
  // The pitch: the first batch sent (one email per contact, within the hour); later emails such
  // as the contract aren't part of it.
  const plain = all.filter((m: any) => m.followup == null && m.sent_at);
  const t0 = plain[0]?.sent_at ? new Date(plain[0].sent_at).getTime() : 0;
  const pitch = plain.filter((m: any) => new Date(m.sent_at).getTime() - t0 < 3600e3);
  const fus = all.filter((m: any) => m.followup != null);
  const sentSteps: number[] = Array.from(new Set<number>(fus.map((m: any) => Number(m.followup)))).sort((a, b) => a - b);
  const history = sentSteps.map((n) => ({ n, at: fus.filter((m: any) => Number(m.followup) === n).map((m: any) => m.sent_at).sort()[0], to: fus.filter((m: any) => Number(m.followup) === n).map((m: any) => m.to_email) }));
  const sent = sentSteps.length ? Math.max(...sentSteps) : 0;
  const paused = !!l.data?.followups?.paused;
  const base: FollowupState = { step: 0, sent, dueAt: null, due: false, stopped: "", paused, pitchSentAt: pitch[0]?.sent_at || null, history, recipients: [] };
  if (!pitch.length) return { ...base, stopped: "The pitch hasn't been sent yet" };

  // Who's still reachable: a contact on the lead (not unsubscribed or removed), not on the
  // unsubscribe list, and whose pitch didn't bounce or get blocked.
  const live = pitchRecipients(l);
  const refs = pitch.map((m: any) => m.provider_ref).filter(Boolean);
  const { data: evs } = refs.length ? await admin.from("email_events").select("message_id,event").in("message_id", refs).in("event", DEAD) : { data: [] };
  const deadRefs = new Set((evs || []).map((e: any) => e.message_id));
  const recipients: FollowupState["recipients"] = [];
  for (const m of pitch) {
    const r = live.find((x) => x.email.toLowerCase() === String(m.to_email || "").toLowerCase());
    if (!r || deadRefs.has(m.provider_ref)) continue;
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(r.email)).maybeSingle();
    if (sup) continue;
    if (!recipients.some((x) => x.email.toLowerCase() === r.email.toLowerCase())) recipients.push({ email: r.email, name: r.name, first: r.first, token: r.token, ref: m.provider_ref || "" });
  }
  base.recipients = recipients;

  const stop = (why: string) => ({ ...base, stopped: why });
  if (sent >= FOLLOWUP_GAPS.length) return stop("All 3 follow-ups have been sent");
  if (l.interested_at) return stop("They said they're interested");
  if (l.status !== "contacted") return stop("The lead has moved on (" + l.status + ")");
  const ag = await agreementFor(admin, l.company || "");
  if (ag?.signed_at && ag.signed_at > pitch[0].sent_at) return stop("They've signed our terms");
  if (paused) return stop(String(l.data?.followups?.reason || "Follow-ups were stopped"));
  // Any other sign they've responded since the pitch: a reply to us (client_replies, not an
  // automatic one), a reply through Apollo, or asking to discuss our terms.
  const t0s = pitch[0].sent_at;
  const { data: rep } = await admin.from("client_replies").select("id").eq("lead_id", l.id).eq("auto", false).eq("spam", false).gte("received_at", t0s).limit(1);
  if (rep?.length) return stop("They replied");
  const ap = l.data?.apollo;
  if (ap?.event === "reply" && !ap?.reply?.auto) return stop("They replied (Apollo)");
  if ((Array.isArray(l.data?.terms_discussions) ? l.data.terms_discussions : []).some((x: any) => String(x?.at || "") > t0s)) return stop("They asked to discuss our terms");
  if (!recipients.length) return stop("Nobody left to email (unsubscribed, bounced or removed)");
  const pitched: string[] = Array.isArray(l.data?.pitched) ? l.data.pitched.map(String) : [];
  if (pitched.length) {
    const { data: offs } = await admin.from("lead_offers").select("status").eq("lead_id", l.id).in("candidate_id", pitched);
    if ((offs || []).length && !(offs || []).some((o: any) => !["withdrawn", "removed"].includes(o.status))) return stop("None of the pitched candidates is still in the running");
  }

  const step = sent + 1;
  let due = addBusinessDays(new Date(pitch[0].sent_at), FOLLOWUP_GAPS[step - 1]);
  const prevAt = history.find((h) => h.n === sent)?.at;
  if (prevAt) {
    const min = addBusinessDays(new Date(prevAt), FOLLOWUP_GAPS[step - 1] - FOLLOWUP_GAPS[step - 2]);
    if (min > due) due = min;
  }
  return { ...base, step, dueAt: due.toISOString(), due: due.getTime() <= Date.now() };
}

// The drafted follow-up, from what we've verified (never the "to discuss" items). "Hi there," is
// replaced by each contact's first name when it's sent; the last line is the sign-off.
export function followupDraft(l: any, step: number, s: Settings) {
  const n = Array.isArray(l.data?.pitched) ? l.data.pitched.length : 0;
  const viewUrl = l.client_token && n ? `${portalBase()}/?t=s-${encodeURIComponent(l.client_token)}` : "";
  const cands = viewUrl ? pitchCands(l, viewUrl) : [];
  const c1 = cands[0];
  const role = l.job_title || "the role";
  const who = n > 1 ? `${n} candidates` : "a candidate";
  const sign = "Thanks,\n" + (firstName(s.senderName) || "The team");
  let body = "";
  if (step === 1) {
    const meets = n > 1 ? " who match the requirements in your job description" : c1?.reqTotal ? ` who meets ${reqText(c1)} in your job description` : "";
    body = `Hi there,\n\nJust making sure my email reached you. I have ${who} for your ${role} role${meets}.\n\n` +
      `You can view the anonymised resume${n > 1 ? "s" : ""} below. There's no charge to interview, and we only bill if you hire.\n\n` +
      `Happy to set up a quick call if that's easier.\n\n${sign}`;
  } else if (step === 2) {
    // Their selling points from the resume (or else what they meet of the job description).
    const m1 = (Array.isArray(l.matches) ? l.matches : []).find((m: any) => m.candidate_id === String(l.data?.pitched?.[0] || "")) || {};
    const pts: string[] = (Array.isArray(m1.bullets) && m1.bullets.length ? m1.bullets : (c1?.musts || [])).slice(0, 3).map(String);
    body = `Hi there,\n\nA little more on ${n > 1 ? "Candidate 1" : "the candidate"} for your ${role} role:` +
      (pts.length ? "\n" + pts.map((x: string) => "- " + x).join("\n") : "") +
      (c1?.reqTotal ? `\n\nThey meet ${reqText(c1)} in your job description.` : "") + "\n\n" +
      `If the timing isn't right, just reply "not now" and I'll stop following up.\n\n${sign}`;
  } else {
    body = `Hi there,\n\nI haven't heard back, so I'll assume the ${role} role is covered or the timing isn't right. This is my last email about it.\n\n` +
      `If anything changes, you can still view the ${n > 1 ? "candidates" : "candidate"} below, or just reply to this email.\n\n${sign}`;
  }
  return { subject: reSubject(subjectOf(l)), body, viewUrl, viewCount: n };
}

// One contact's copy: HTML in the house design, and the plain-text part with the footer.
function render(b: any, l: any, body: string, subject: string, r: { first: string; token: string }, viewUrl: string, viewCount: number, s: Settings, agencyName: string) {
  const region = (l.region as Region) || regionOf(countryCode(l.country));
  const text = greet(body, { first_name: r.first });
  const { paragraphs, signoff } = introOf(text);
  const agency = s.footerName || agencyName;
  const label = viewCount > 1 ? `View the ${viewCount} candidates` : "View the anonymised resume";
  const html = emailShell(b, subject,
    noteHtml(b, paragraphs) + (viewUrl ? button(b, viewUrl, label) : "") +
    signHtml(signoff || firstName(s.senderName), s.senderTitle, agency), undefined, undefined,
    footerHtml(b, { sender: [s.senderName, s.senderTitle].filter(Boolean).join(", "), agency, address: s.businessAddress,
      why: region !== "US" ? "Why you're getting this: your company advertised this role publicly and we have a matching candidate. We use only your name, role and work email, only for this purpose." : "You are receiving this email because your company advertised this role publicly.",
      unsubUrl: linkFor(r.token, "l", "unsubscribe"), deleteUrl: region !== "US" ? linkFor(r.token, "l", "delete") : "" }));
  const plain = finalBody(text + (viewUrl ? `\n\n${label}: ${viewUrl}` : ""), r.token, "l", region, s, agencyName, "client");
  return { html, plain };
}

// What the lead card's "Review follow-up" shows: where it's at, and the draft (with a preview).
// With subject / body: the preview of the edited version.
export async function followupPreview(admin: any, leadId: string, s: Settings, agencyName: string, edit?: { subject?: string; body?: string }) {
  const { data: l } = await admin.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!l) throw new Error("Lead not found");
  const st = await followupState(admin, l);
  if (!st.step) return { ok: true, state: st };
  const d = followupDraft(l, st.step, s);
  const b = await loadBrand(admin);
  const r0 = st.recipients[0];
  const subject = String(edit?.subject || "").trim() || d.subject, body = String(edit?.body || "").trim() || d.body;
  const { html } = render(b, l, body, subject, { first: r0?.first || "", token: "test-preview" }, d.viewUrl, d.viewCount, s, agencyName);
  return { ok: true, state: st, draft: { subject: d.subject, body: d.body }, html, previewOf: r0 ? r0.name || r0.email : "" };
}

// "Send": the reviewed follow-up to the chosen contacts, one email each, in the pitch's thread.
export async function followupSend(admin: any, me: { id: string }, leadId: string, f: { step?: number; subject?: string; body?: string; to?: string[] }, s: Settings, agencyName: string) {
  const { data: l } = await admin.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!l) throw new Error("Lead not found");
  const st = await followupState(admin, l);
  if (!st.step) throw new Error(st.stopped || "No follow-up to send");
  if (f.step && Number(f.step) !== st.step) throw new Error("This follow-up was already sent. Refresh the lead.");
  const subject = String(f.subject || "").trim().slice(0, 200), body = String(f.body || "").trim().slice(0, 6000);
  if (!subject || !body) throw new Error("Add a subject and a message");
  const want = Array.isArray(f.to) && f.to.length ? new Set(f.to.map((x) => String(x).toLowerCase())) : null;
  const to = st.recipients.filter((r) => !want || want.has(r.email.toLowerCase()));
  if (!to.length) throw new Error("Choose who to send it to");
  const p = provider("client");
  if (p === "none") throw new Error("No sender is set up for client emails yet (Outreach > Setup).");
  // Same daily limit as the pitches when they go through Brevo.
  if (p === "brevo") {
    const since = new Date(); since.setUTCHours(0, 0, 0, 0);
    const { count } = await admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "sent").eq("provider", "brevo").gte("sent_at", since.toISOString());
    const left = Math.max(0, s.clientBrevoPerDay - (count || 0));
    if (left < to.length) throw new Error(`Today's limit of ${s.clientBrevoPerDay} client emails through Brevo is reached${left ? ` (room for ${left} more)` : ""}. Send it tomorrow.`);
  }
  const d = followupDraft(l, st.step, s);
  const b = await loadBrand(admin);
  let sent = 0;
  const errors: string[] = [];
  for (const r of to) {
    const { html, plain } = render(b, l, body, subject, r, d.viewUrl, d.viewCount, s, agencyName);
    const mail = { kind: "client" as const, to: r.email, toName: r.name, firstName: r.first, lastName: String(r.name || "").split(" ").slice(1).join(" "), company: l.company || "",
      subject, body: plain, html, unsubUrl: linkFor(r.token, "l", "unsubscribe"), replyTo: s.replyTo };
    try {
      let prov: string = p, ref = "";
      if (p === "brevo" && brevoReady()) ref = await sendBrevoOutreach(mail, s.senderName, "client-followup", r.ref ? { "In-Reply-To": r.ref, References: r.ref } : {});
      else { const x = await sendMail(mail, s.senderName); prov = x.provider; ref = x.ref; }
      await admin.from("outreach_messages").insert({ kind: "client", lead_id: l.id, to_email: r.email, to_name: r.name || null, subject, body: plain, html,
        status: "sent", provider: prov, provider_ref: ref, sent_at: new Date().toISOString(), approved_by: me.id, followup: st.step });
      sent++;
    } catch (e) { errors.push(r.email + ": " + String((e as Error)?.message || e).slice(0, 160)); }
  }
  if (!sent) throw new Error("It didn't send. " + errors.join("; "));
  return { ok: true, sent, step: st.step, errors };
}

// "They replied" / "Stop follow-ups" (or turn them back on).
export async function followupPause(admin: any, me: { id: string }, leadId: string, paused: boolean, reason?: string) {
  const { data: l } = await admin.from("leads").select("id,data").eq("id", leadId).maybeSingle();
  if (!l) throw new Error("Lead not found");
  const fu = { ...(l.data?.followups || {}), paused, reason: paused ? String(reason || "Follow-ups were stopped").slice(0, 120) : null, by: me.id, at: new Date().toISOString() };
  await admin.from("leads").update({ data: { ...(l.data || {}), followups: fu } }).eq("id", leadId);
  return { ok: true, paused };
}

// Every tick: tell the person who sent the pitch, and the Admins, when a follow-up is due. Once per
// follow-up (push_update dedupes on the key). Nothing is sent.
export async function stepFollowupsDue(admin: any) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: leads } = await admin.from("leads").select("*").eq("status", "contacted").is("interested_at", null).gte("contacted_at", since).limit(100);
  let notified = 0;
  let admins: any[] | null = null;
  for (const l of leads || []) {
    const st = await followupState(admin, l);
    if (!st.step || !st.due) continue;
    const { data: first } = await admin.from("outreach_messages").select("approved_by").eq("lead_id", l.id).eq("kind", "client").eq("status", "sent").is("followup", null).order("sent_at").limit(1).maybeSingle();
    if (!admins) admins = (await admin.from("profiles").select("id").eq("role", "admin").eq("status", "Active")).data || [];
    const users = Array.from(new Set([first?.approved_by, ...admins.map((a: any) => a.id)].filter(Boolean)));
    for (const u of users) {
      await admin.rpc("push_update", { p_user: u, p_kind: "event",
        p_title: `Follow-up ${st.step} of 3 is due: ${l.company} (${l.job_title})`,
        p_body: `No reply yet to the pitch. Review the drafted follow-up on the lead and send it${st.recipients.length > 1 ? ` (${st.recipients.length} contacts)` : ""}.`,
        p_link: { page: "campaigns", lead: l.id }, p_dedupe: `lead-followup:${l.id}:${st.step}` }).then(() => {}, () => {});
    }
    notified++;
  }
  return { notified };
}
