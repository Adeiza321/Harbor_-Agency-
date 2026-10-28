// Approving outreach puts it in the send queue with the compliance footer; the queue is sent
// in small batches (scheduled every 10 minutes, or "Send now") within the daily cap.
// First emails to candidates are built by outreach.ts: the short personal note, a role overview,
// the must-haves, and "I'm interested" / "Refer someone" buttons to the public job page.

import { footerText, regionOf, countryCode, type Region } from "./regions.ts";
import { brevoReady, emailHash, provider, sendBrevoOutreach, sendMail } from "./send.ts";
import { sendBlockers, type Settings } from "./common.ts";
import { candidateEmail, clientEmail, termsUrl, introOf, mustHavesFor, payText, sourceShort, sourceText, templateEmail } from "./outreach.ts";
import { isTemplateBody, templateParts } from "./template.ts";
import { esc, loadBrand, sendBrevo, type Brand } from "./brand.ts";
import { greet, liveContacts } from "./contacts.ts";
import { jdSummary, tidyCut } from "./pitch.ts";

// Everyone a client pitch goes to, each with their own email: the lead's contacts, or (older leads)
// its single contact. Each has their own links (the lead's token ~ theirs).
export function pitchRecipients(l: any): { email: string; name: string; first: string; token: string; role: string }[] {
  const list = liveContacts(l);
  if (list.length) return list.map((c) => ({ email: c.email, name: c.name || "", first: c.first_name || "", token: `${l.unsub_token}~${c.token}`, role: c.title || c.role || "" }));
  return l.contact_email ? [{ email: l.contact_email, name: l.contact_name || "", first: l.contact_first_name || "", token: l.unsub_token, role: l.contact_role || "" }] : [];
}

// "City, Country" without repeating a country the location already names (same as the app's jobPlace).
const COUNTRY_ALIASES: Record<string, string[]> = { "United States": ["usa", "us", "u.s.", "united states of america"], "United Kingdom": ["uk", "u.k.", "england", "scotland", "wales", "great britain"], "United Arab Emirates": ["uae"] };
function jobPlace(location?: string | null, country?: string | null) {
  const loc = String(location || "").trim(), c = String(country || "").trim();
  if (!c) return loc;
  if (/^remote\b.*worldwide/i.test(c)) return !loc ? c : /remote|worldwide|anywhere/i.test(loc) ? loc : loc + " \u00b7 Remote";
  if (!loc) return c;
  const low = loc.toLowerCase(), names = [c].concat(COUNTRY_ALIASES[c] || []).map((n) => n.toLowerCase());
  if (names.some((n) => new RegExp("(^|[\\s,(/-])" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[\\s,)/-])").test(low))) return loc;
  return loc + ", " + c;
}

export const portalBase = () => (Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com").replace(/\/+$/, "");
export const linkFor = (token: string, kind: "p" | "l", action: "interested" | "unsubscribe" | "delete" | "job") =>
  `${portalBase()}/?u=${token}&k=${kind}&a=${action}`;

// The pitch to a hiring manager in the house design (HTML), from the lead's drafted text.
// The candidates in a pitch, in order: what each meets of the posting (or their selling points).
export function pitchCands(l: any, viewUrl: string) {
  const ids: string[] = Array.isArray(l.data?.pitched) ? l.data.pitched.map(String) : [];
  const ms: any[] = Array.isArray(l.matches) ? l.matches : [];
  return ids.map((id, i) => {
    const m = ms.find((x) => x.candidate_id === id) || {};
    const musts = (Array.isArray(m.musts) && m.musts.length ? m.musts.map((x: any) => (x.bonus ? "Nice to have: " : "") + x.item + (x.evidence ? ": " + tidyCut(x.evidence) : "")) : (m.bullets || [])).slice(0, 8);
    return { n: i + 1, verdict: m.verdict || "", fit: m.fit ?? null, musts, url: viewUrl ? viewUrl + "&c=" + (i + 1) : "", ...pitchFacts(m) };
  });
}
// Why the score is what it is, for the client: how many of their job description's requirements the
// candidate meets (and any still to confirm), and how the role fits what the candidate wants
// (only what we've checked matches, never the candidate's own figures). Items still "to discuss"
// stay between us and the candidate: the client never sees them.
export function pitchFacts(m: any) {
  const js = jdSummary(m?.jd);
  const wants: { item: string; ok: boolean }[] = (Array.isArray(m?.requirements) ? m.requirements : []).filter((q: any) => q?.item && q.status === "met").map((q: any) => ({ item: String(q.item), ok: true }));
  return { reqTotal: js.total, reqMet: js.met.length, toConfirm: js.toConfirm.map((x: any) => String(x.item)), wants };
}

export function leadHtml(l: any, token: string, region: Region, s: Settings, agencyName: string, b: Brand) {
  const n = Array.isArray(l.data?.pitched) ? l.data.pitched.length : 0;
  const viewUrl = l.client_token && n ? `${portalBase()}/?t=s-${encodeURIComponent(l.client_token)}` : "";
  return clientEmail(b, { body: l.pitch_body, interestedUrl: linkFor(token, "l", "interested"), region, subject: l.pitch_subject || `Candidate for your ${l.job_title} role`,
    viewUrl, viewCount: n, cands: viewUrl ? pitchCands(l, viewUrl) : undefined,
    senderName: s.senderName, senderTitle: s.senderTitle, agency: s.footerName || agencyName, address: s.businessAddress,
    unsubUrl: linkFor(token, "l", "unsubscribe"), deleteUrl: linkFor(token, "l", "delete") });
}

// A client-lead pitch as plain text: the pitch, then the link to the candidates' blind resumes.
export function leadText(l: any) {
  const n = Array.isArray(l.data?.pitched) ? l.data.pitched.length : 0;
  if (!l.client_token || !n) return String(l.pitch_body || "");
  const viewUrl = `${portalBase()}/?t=s-${encodeURIComponent(l.client_token)}`;
  return String(l.pitch_body || "") + "\n\n" + pitchCands(l, viewUrl).map((c) => `Candidate ${c.n}${c.verdict ? " (" + c.verdict + ")" : ""}` +
    (c.reqTotal ? `\nMeets ${c.reqMet} of ${c.reqTotal} requirements in your job description${c.fit != null ? " (fit " + c.fit + "%)" : ""}` : "") +
    `\n${c.musts.map((x: string) => "- " + x).join("\n")}` +
    (c.toConfirm.length ? `\nStill to confirm: ${c.toConfirm.join("; ")}` : "") +
    (c.wants.length ? `\nWhat they're looking for: ${c.wants.map((w) => w.item + " \u2713").join(", ")}` : "") +
    `\nView the anonymised resume: ${c.url}`).join("\n\n") +
    "\n\nWe don't charge to arrange interviews. We only bill a fee when you hire our candidate." +
    `\nOur candidates are introduced under our Terms of Business, which apply once you unlock a full resume: ${termsUrl(viewUrl)}`;
}

// Plain-text version of a client pitch, with the footer underneath (sent alongside the HTML).
export function finalBody(body: string, token: string, kind: "p" | "l", region: Region, s: Settings, agencyName: string, who: "candidate" | "client") {
  const text = String(body || "").replace(/\{\{INTERESTED_LINK\}\}/g, linkFor(token, kind, "interested"))
    .replace(/\{\{JOB_LINK\}\}/g, linkFor(token, kind, "job")).trim();
  const sender = [s.senderName, s.senderTitle].filter(Boolean).join(", ");
  return text + "\n" + footerText(region, { senderName: sender, agencyName: s.footerName || agencyName, businessAddress: s.businessAddress,
    unsubUrl: linkFor(token, kind, "unsubscribe"), deleteUrl: linkFor(token, kind, "delete") }, who);
}

// The job behind a prospect's email: its public page (giving it a link code if it never had
// one) and its must-haves. Cached per call, since a batch is usually many people for one job.
type JobPack = { job: any; page: string; mustHaves: { summary: string; items: string[] } | null } | null;
const JOB_COLS = "id,role_title,client,description,location,country,work_setup,employment_type,min_pay,max_pay,currency,salary_period,commission_only,status,link_slug,outreach_brief";
export async function jobPack(admin: any, jobId: string | null, cache: Map<string, JobPack>): Promise<JobPack> {
  if (!jobId) return null;
  if (cache.has(jobId)) return cache.get(jobId)!;
  let pack: JobPack = null;
  try {
    const { data: job } = await admin.from("jobs").select(JOB_COLS).eq("id", jobId).maybeSingle();
    if (job && job.status !== "Closed") {
      let slug = String(job.link_slug || "");
      if (!slug) {
        slug = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("");
        const { error } = await admin.from("jobs").update({ link_slug: slug }).eq("id", job.id).is("link_slug", null);
        if (error) slug = "";
      }
      if (slug) pack = { job, page: `${portalBase()}/jobs/${encodeURIComponent(slug)}/`, mustHaves: await mustHavesFor(admin, job) };
    }
  } catch (e) { console.error("job links", jobId, String((e as Error)?.message || e)); }
  cache.set(jobId, pack);
  return pack;
}

// The finished first email to one prospect: plain text and HTML.
export async function composeProspect(admin: any, p: any, s: Settings, agencyName: string, cache: Map<string, JobPack>, brand?: Brand) {
  const pack = await jobPack(admin, p.job_id, cache);
  const region = (p.region as Region) || regionOf(countryCode(p.country));
  const b = brand || await loadBrand(admin);
  const job = pack?.job || {};
  const remote = /remote/i.test(job.work_setup || "");
  const q = (extra: string) => pack ? `${pack.page}?src=outreach&${extra}` : linkFor(p.unsub_token, "p", "interested");
  // Written from the job's outreach template: the agency's own words, as written.
  if (isTemplateBody(p.body)) {
    const tp = templateParts(p.body);
    return templateEmail({ brand: b, region, text: tp.text, signoff: tp.signoff, subject: p.subject || job.role_title || "",
      senderName: s.senderName, senderTitle: s.senderTitle, agency: s.footerName || agencyName, address: s.businessAddress,
      applyUrl: q("go=apply&pt=" + encodeURIComponent(p.unsub_token || "")), referUrl: q("refer=1&pt=" + encodeURIComponent(p.unsub_token || "")),
      unsubUrl: linkFor(p.unsub_token, "p", "unsubscribe"), deleteUrl: linkFor(p.unsub_token, "p", "delete"), source: sourceShort(p) });
  }
  const { paragraphs, signoff } = introOf(String(p.body || "").replace(/\{\{INTERESTED_LINK\}\}/g, ""));
  return candidateEmail({
    brand: b, region, paragraphs, signoff,
    senderName: s.senderName, senderTitle: s.senderTitle, agency: s.footerName || agencyName, address: s.businessAddress,
    role: { title: job.role_title || p.subject || "", location: jobPlace(job.location, job.country) || (remote ? "Remote" : ""),
      workSetup: job.work_setup || "", employmentType: job.employment_type || "", pay: payText(job, s.includePay) },
    summary: pack?.mustHaves?.summary || "", mustHaves: pack?.mustHaves?.items || [],
    applyUrl: q("go=apply&pt=" + encodeURIComponent(p.unsub_token || "")), referUrl: q("refer=1&pt=" + encodeURIComponent(p.unsub_token || "")),
    unsubUrl: linkFor(p.unsub_token, "p", "unsubscribe"), deleteUrl: linkFor(p.unsub_token, "p", "delete"),
    source: sourceShort(p),   // the same wording template emails use
  });
}

// A copy of a prospect's first email, sent through Brevo to a staff member's own address, so
// they can see exactly how it looks. Nothing is queued or marked as sent.
export async function sendTest(admin: any, prospectId: string, to: string, s: Settings, agencyName: string) {
  const { data: p } = await admin.from("prospects").select("*").eq("id", prospectId).maybeSingle();
  if (!p) throw new Error("Not found");
  if (!p.body) throw new Error("This person has no drafted email yet");
  const b = await loadBrand(admin);
  const mail = await composeProspect(admin, { ...p, unsub_token: "test-preview" }, s, agencyName, new Map(), b);
  const ok = await sendBrevo(b, { email: to }, "[TEST] " + (p.subject || "A role that fits your background"), mail.html);
  if (!ok) throw new Error("Brevo didn't accept the test email");
  return { ok: true, to };
}

// The email exactly as the person would get it (design, apply button, footer), for the preview on
// their card. Nothing is sent.
export async function previewProspect(admin: any, prospectId: string, s: Settings, agencyName: string) {
  const { data: p } = await admin.from("prospects").select("*").eq("id", prospectId).maybeSingle();
  if (!p) throw new Error("Not found");
  if (!p.body) throw new Error("This person has no drafted email yet");
  const b = await loadBrand(admin);
  const mail = await composeProspect(admin, { ...p, unsub_token: "test-preview" }, s, agencyName, new Map(), b);
  return { ok: true, subject: p.subject || "", to: p.email || "", html: mail.html };
}

// The same for a client pitch: plain text with the footer, as the hiring manager would get it.
export async function sendLeadTest(admin: any, leadId: string, to: string, s: Settings, agencyName: string) {
  const { data: l } = await admin.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!l) throw new Error("Not found");
  if (!l.pitch_body) throw new Error("This lead has no drafted email yet");
  const b = await loadBrand(admin);
  const region = (l.region as Region) || regionOf(countryCode(l.country));
  const to_ = pitchRecipients(l);
  const r0 = to_[0];
  const who = to_.length ? `This would go as ${to_.length === 1 ? "one email" : to_.length + " separate emails"}: ${to_.map((r) => `${esc(r.name || r.email)} &lt;${esc(r.email)}&gt;${r.role ? " (" + esc(r.role) + ")" : ""}`).join(", ")}. This copy is ${esc(r0.name || r0.email)}'s.` : "No contact yet: add one on the lead before it can be sent.";
  const html = leadHtml(r0 ? { ...l, pitch_body: greet(l.pitch_body, { first_name: r0.first }) } : l, "test-preview", region, s, agencyName, b).replace(/(<body[^>]*>)/i, `$1<div style="font-family:Arial,sans-serif;font-size:13px;background:#FFF6E0;color:#6B4E00;padding:10px 14px;">${who}</div>`);
  const ok = await sendBrevo(b, { email: to }, "[TEST] " + (l.pitch_subject || `Candidate for your ${l.job_title} role`), html);
  if (!ok) throw new Error("Brevo didn't accept the test email");
  return { ok: true, to };
}

// "Check spam score": the pitch exactly as the client would get it (same Brevo sender, subject,
// design, plain-text part and unsubscribe header), sent to a mail-tester.com address, which scores
// how likely it is to land in spam and says why. Its links are test links: nothing on the lead
// changes, no one is unsubscribed, and it doesn't count towards the daily limits.
export async function sendLeadSpamCheck(admin: any, leadId: string, to: string, s: Settings, agencyName: string) {
  if (!brevoReady()) throw new Error("Brevo isn't set up for sending yet (BREVO_API_KEY and BREVO_SENDER_EMAIL)");
  const { data: l } = await admin.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!l) throw new Error("Not found");
  if (!l.pitch_body) throw new Error("This lead has no drafted email yet");
  const b = await loadBrand(admin);
  const region = (l.region as Region) || regionOf(countryCode(l.country));
  const r0 = pitchRecipients(l)[0];
  const lr = r0 ? { ...l, pitch_body: greet(l.pitch_body, { first_name: r0.first }) } : l;
  const token = "test-preview";
  await sendBrevoOutreach({
    kind: "client", to, toName: "", firstName: r0?.first || "", lastName: "", company: l.company || "",
    subject: l.pitch_subject || `Candidate for your ${l.job_title} role`,
    body: finalBody(leadText(lr), token, "l", region, s, agencyName, "client"), html: leadHtml(lr, token, region, s, agencyName, b),
    unsubUrl: linkFor(token, "l", "unsubscribe"), replyTo: s.replyTo,
  }, s.senderName, "spam-check");
  return { ok: true, to };
}

// Why someone can't be emailed yet (or "" when they can): their location to confirm first, an
// Apollo person not through the must-have check yet, or one waiting on a full-profile check.
export function holdReason(p: any): string {
  if (!["found", "approved"].includes(p?.status)) return "";
  if (p.data?.location_hold && !p.data?.location_ok) return "location";
  if (p.source === "apollo" && !p.data?.musts_v) return "must-have check";
  if (p.data?.profile_hold) return "full-profile check";
  return "";
}

export async function queueProspects(admin: any, ids: string[], approver: string | null, s: Settings, agencyName: string) {
  const missing = sendBlockers(s);
  if (missing.length) throw new Error("Before emailing anyone, add your " + missing.join(" and ") + " in Outreach > Setup (required by anti-spam law).");
  const { data: rows } = await admin.from("prospects").select("*").in("id", ids).in("status", ["found", "approved"]);
  let queued = 0;
  const cache = new Map<string, JobPack>();
  const brand = await loadBrand(admin);
  for (const p of rows || []) {
    if (!p.email || !p.body) continue;
    if (holdReason(p)) continue;   // location to confirm first ("Location OK"), or a must-have check still to come
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(p.email)).maybeSingle();
    if (sup) { await admin.from("prospects").update({ status: "unsubscribed" }).eq("id", p.id); continue; }
    const mail = await composeProspect(admin, p, s, agencyName, cache, brand);
    const { error } = await admin.from("outreach_messages").insert({
      kind: "candidate", prospect_id: p.id, to_email: p.email, to_name: p.full_name,
      subject: p.subject || "A role that fits your background", body: mail.text, html: mail.html,
      approved_by: approver,
    });
    if (error) throw new Error(error.message);
    await admin.from("prospects").update({ status: "queued" }).eq("id", p.id);
    queued++;
  }
  return queued;
}

export async function queueLeads(admin: any, ids: string[], approver: string | null, s: Settings, agencyName: string) {
  const missing = sendBlockers(s);
  if (missing.length) throw new Error("Before emailing anyone, add your " + missing.join(" and ") + " in Outreach > Setup (required by anti-spam law).");
  const { data: rows } = await admin.from("leads").select("*").in("id", ids).in("status", ["new", "approved"]);
  let queued = 0;
  const brand = await loadBrand(admin);
  for (const l of rows || []) {
    const recipients = pitchRecipients(l);
    if (!recipients.length || !l.pitch_body) continue;
    const region = (l.region as Region) || regionOf(countryCode(l.country));
    // One email per contact, each greeted by name with their own unsubscribe link.
    let n = 0;
    for (const r of recipients) {
      const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(r.email)).maybeSingle();
      if (sup) continue;
      const lr = { ...l, pitch_body: greet(l.pitch_body, { first_name: r.first }) };
      const { error } = await admin.from("outreach_messages").insert({
        kind: "client", lead_id: l.id, to_email: r.email, to_name: r.name || null,
        subject: l.pitch_subject || `Candidate for your ${l.job_title} role`, body: finalBody(leadText(lr), r.token, "l", region, s, agencyName, "client"),
        html: leadHtml(lr, r.token, region, s, agencyName, brand), approved_by: approver,
      });
      if (error) throw new Error(error.message);
      n++;
    }
    if (!n) { await admin.from("leads").update({ status: "unsubscribed" }).eq("id", l.id); continue; }
    await admin.from("leads").update({ status: "queued" }).eq("id", l.id);
    // Candidate first: the candidates in it are now with the client (Submitted on the lead's role).
    const pitched: string[] = Array.isArray(l.data?.pitched) ? l.data.pitched.map(String) : [];
    if (pitched.length) {
      const { data: offs } = await admin.from("lead_offers").select("id,candidate_job_id").eq("lead_id", l.id).in("candidate_id", pitched).in("status", ["ready", "pitched"]);
      for (const o of offs || []) {
        await admin.from("lead_offers").update({ status: "pitched", pitched_at: new Date().toISOString() }).eq("id", o.id);
        if (o.candidate_job_id) await admin.from("candidate_jobs").update({ stage: "Submitted" }).eq("id", o.candidate_job_id).in("stage", ["Sourced", "In review", "Screening"]);
      }
    }
    queued++;
  }
  return queued;
}

// Send what's waiting, oldest first, within today's cap. Every address is re-checked against
// the unsubscribe list right before sending.
export async function processQueue(admin: any, s: Settings, max = 8, leadId?: string) {
  // Each kind waits for its own sender (client pitches need their own Apollo sequence).
  const ready = (["candidate", "client"] as const).filter((k) => provider(k) !== "none");
  if (!ready.length) return { sent: 0, waiting: true, message: "No outreach sender connected yet; approved emails are waiting in the queue." };
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", since.toISOString());
  const room = Math.max(0, s.dailyCap - (sentToday || 0));
  if (!room) return { sent: 0, capped: true, message: `Today's limit of ${s.dailyCap} emails is reached; the rest go out tomorrow.` };
  let bq = admin.from("outreach_messages").select("*").eq("status", "queued").in("kind", ready);
  if (leadId) bq = bq.eq("lead_id", leadId);
  const { data: batch } = await bq.order("created_at").limit(Math.min(max, room));
  let sent = 0, failed = 0, overBrevo = 0;
  // Client pitches through Brevo share the candidate emails' account: a small daily cap of their own.
  let brevoLeft = Infinity;
  if (provider("client") === "brevo") {
    const { count } = await admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "sent").eq("provider", "brevo").gte("sent_at", since.toISOString());
    brevoLeft = Math.max(0, s.clientBrevoPerDay - (count || 0));
  }
  for (const m of batch || []) {
    if (m.kind === "client" && provider("client") === "brevo") { if (brevoLeft <= 0) { overBrevo++; continue; } brevoLeft--; }
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(m.to_email)).maybeSingle();
    if (sup) { await admin.from("outreach_messages").update({ status: "skipped", error: "Unsubscribed" }).eq("id", m.id); continue; }
    let first = "", last = "", company = "", token = "";
    if (m.prospect_id) {
      const { data: p } = await admin.from("prospects").select("first_name,last_name,company,unsub_token,status,jobs(status)").eq("id", m.prospect_id).maybeSingle();
      // Last guard: nothing goes out for a role that has closed (closing also cancels the queue).
      if (p?.status === "archived" || (p as any)?.jobs?.status === "Closed") { await admin.from("outreach_messages").update({ status: "skipped", error: "Role closed" }).eq("id", m.id); continue; }
      first = p?.first_name || ""; last = p?.last_name || ""; company = p?.company || ""; token = p?.unsub_token || "";
    } else if (m.lead_id) {
      const { data: l } = await admin.from("leads").select("contact_first_name,contact_name,contact_email,contact_role,company,unsub_token,data").eq("id", m.lead_id).maybeSingle();
      // This email's own contact (each contact gets their own email and links).
      const r = l ? pitchRecipients(l).find((x) => x.email.toLowerCase() === String(m.to_email || "").toLowerCase()) : null;
      first = r?.first || ""; last = String(r?.name || "").split(" ").slice(1).join(" "); company = l?.company || ""; token = r?.token || l?.unsub_token || "";
    }
    try {
      const r = await sendMail({ kind: m.kind, to: m.to_email, toName: m.to_name || "", firstName: first, lastName: last, company, subject: m.subject, body: m.body, html: m.html || undefined,
        unsubUrl: linkFor(token, m.prospect_id ? "p" : "l", "unsubscribe"), replyTo: m.kind === "client" ? s.replyTo : "" }, s.senderName);
      const now = new Date().toISOString();
      await admin.from("outreach_messages").update({ status: "sent", provider: r.provider, provider_ref: r.ref, sent_at: now, error: null }).eq("id", m.id);
      if (m.prospect_id) await admin.from("prospects").update({ status: "contacted", contacted_at: now }).eq("id", m.prospect_id).eq("status", "queued");
      if (m.lead_id) await admin.from("leads").update({ status: "contacted", contacted_at: now }).eq("id", m.lead_id).eq("status", "queued");
      sent++;
    } catch (e) {
      failed++;
      await admin.from("outreach_messages").update({ status: "failed", error: String((e as Error)?.message || e).slice(0, 300) }).eq("id", m.id);
    }
  }
  return { sent, failed, held: overBrevo, message: `Sent ${sent}${failed ? `, ${failed} failed` : ""}.` +
    (overBrevo ? ` ${overBrevo} wait${overBrevo === 1 ? "s" : ""} for tomorrow: today's limit of ${s.clientBrevoPerDay} client pitches through Brevo is reached.` : "") };
}

// "Send it myself": until an outreach sender (Instantly/Gmail) is connected, a recruiter can send
// an approved email by hand from their own mailbox. Pronext gives them the finished email (links,
// sender details, unsubscribe and privacy notice included), then records it as sent when they say so.
export async function manualCompose(admin: any, kind: "p" | "l", id: string, s: Settings, agencyName: string) {
  const missing = sendBlockers(s);
  if (missing.length) throw new Error("Before emailing anyone, add your " + missing.join(" and ") + " in Outreach > Setup (required by anti-spam law).");
  if (kind === "p") {
    const { data: p } = await admin.from("prospects").select("*").eq("id", id).maybeSingle();
    if (!p) throw new Error("Not found");
    if (!p.email) throw new Error("No email address for this person");
    if (["unsubscribed", "rejected", "not_interested", "bounced"].includes(p.status)) throw new Error("This person shouldn't be emailed");
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(p.email)).maybeSingle();
    if (sup) { await admin.from("prospects").update({ status: "unsubscribed" }).eq("id", p.id); throw new Error("They've unsubscribed, so they can't be emailed"); }
    const { data: q } = await admin.from("outreach_messages").select("subject,body,html").eq("prospect_id", id).eq("status", "queued").limit(1).maybeSingle();
    const mail = q?.html ? { text: q.body, html: q.html } : await composeProspect(admin, p, s, agencyName, new Map());
    return { to: p.email, toName: p.full_name || "", subject: q?.subject || p.subject || "A role that fits your background", body: mail.text, html: mail.html };
  }
  const { data: l } = await admin.from("leads").select("*").eq("id", id).maybeSingle();
  if (!l) throw new Error("Not found");
  const recipients = pitchRecipients(l);
  if (!recipients.length) throw new Error("No contact with an email address on this lead yet");
  if (["unsubscribed", "lost", "ignored"].includes(l.status)) throw new Error("This contact shouldn't be emailed");
  const region = (l.region as Region) || regionOf(countryCode(l.country));
  const { data: queued } = await admin.from("outreach_messages").select("to_email,subject,body,html").eq("lead_id", id).eq("status", "queued");
  // One email per contact.
  const emails: any[] = [];
  for (const r of recipients) {
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(r.email)).maybeSingle();
    if (sup) continue;
    const q = (queued || []).find((x: any) => String(x.to_email).toLowerCase() === r.email.toLowerCase());
    const lr = { ...l, pitch_body: greet(l.pitch_body, { first_name: r.first }) };
    emails.push({ to: r.email, toName: r.name, role: r.role, subject: q?.subject || l.pitch_subject || `Candidate for your ${l.job_title} role`,
      body: q?.body || finalBody(leadText(lr), r.token, "l", region, s, agencyName, "client"), html: q?.html || undefined });
  }
  if (!emails.length) { await admin.from("leads").update({ status: "unsubscribed" }).eq("id", l.id); throw new Error("Everyone on this lead has unsubscribed"); }
  return { ...emails[0], emails };
}

export async function markManualSent(admin: any, kind: "p" | "l", id: string) {
  const now = new Date().toISOString();
  const col = kind === "p" ? "prospect_id" : "lead_id";
  // Anything still waiting in the queue for them is marked sent by hand, so it never goes twice.
  await admin.from("outreach_messages").update({ status: "sent", sent_at: now, provider: "manual" }).eq(col, id).eq("status", "queued");
  await admin.from(kind === "p" ? "prospects" : "leads").update({ status: "contacted", contacted_at: now }).eq("id", id);
  return { ok: true };
}
