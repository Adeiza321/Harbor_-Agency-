// Approving outreach puts it in the send queue with the compliance footer; the queue is sent
// in small batches (scheduled every 10 minutes, or "Send now") within the daily cap.
// First emails to candidates also get Apply / Refer someone buttons (the public apply page) and
// a one-page PDF role summary with just the must-haves (brief.ts): attached when sending through
// Gmail, linked otherwise.

import { footerText, regionOf, countryCode, type Region } from "./regions.ts";
import { emailHash, provider, sendMail, BRIEF_PREFIX, type Attachment } from "./send.ts";
import { sendBlockers, type Settings } from "./common.ts";
import { ensureBrief, type Brief } from "./brief.ts";

export const portalBase = () => (Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com").replace(/\/+$/, "");
export const linkFor = (token: string, kind: "p" | "l", action: "interested" | "unsubscribe" | "delete" | "job") =>
  `${portalBase()}/?u=${token}&k=${kind}&a=${action}`;

export type Extras = { applyUrl?: string; referUrl?: string; briefUrl?: string };

// Apply / refer / PDF lines go just above the sign-off ("Ahmed", or "Best,\nAhmed").
function withActions(text: string, x: Extras) {
  const add = [x.applyUrl && "Apply now: " + x.applyUrl, x.referUrl && "Know someone who'd fit? Refer them: " + x.referUrl, x.briefUrl && BRIEF_PREFIX + x.briefUrl].filter(Boolean);
  if (!add.length) return text;
  const parts = text.split("\n");
  let i = parts.length - 1;
  while (i >= 0 && !parts[i].trim()) i--;
  const short = (l: string) => l.trim().length > 0 && l.trim().length <= 40 && !/https?:/.test(l);
  let sign = i >= 0 && short(parts[i]) ? i : parts.length;
  if (sign > 0 && sign < parts.length && short(parts[sign - 1]) && /,$/.test(parts[sign - 1].trim())) sign--;
  const before = parts.slice(0, sign).join("\n").replace(/\s+$/, ""), after = parts.slice(sign).join("\n").trim();
  return before + "\n\n" + add.join("\n") + (after ? "\n\n" + after : "");
}

export function finalBody(body: string, token: string, kind: "p" | "l", region: Region, s: Settings, agencyName: string, who: "candidate" | "client", extras: Extras = {}) {
  let text = String(body || "").replace(/\{\{INTERESTED_LINK\}\}/g, linkFor(token, kind, "interested"))
    .replace(/\{\{JOB_LINK\}\}/g, linkFor(token, kind, "job")).trim();
  if (who === "candidate") text = withActions(text, extras);
  const sender = [s.senderName, s.senderTitle].filter(Boolean).join(", ");
  return text + "\n" + footerText(region, { senderName: sender, agencyName: s.footerName || agencyName, businessAddress: s.businessAddress,
    unsubUrl: linkFor(token, kind, "unsubscribe"), deleteUrl: linkFor(token, kind, "delete") }, who);
}

// The public apply / refer links for a job (giving it a link code if it never had one) and its
// PDF role summary. Cached per call, since a batch is usually many people for one job.
type JobPack = { applyUrl: string; referUrl: string; brief: Brief | null } | null;
const JOB_COLS = "id,role_title,client,description,location,work_setup,employment_type,min_pay,max_pay,currency,salary_period,commission_only,status,link_slug";
export async function jobPack(admin: any, jobId: string | null, s: Settings, agencyName: string, cache: Map<string, JobPack>): Promise<JobPack> {
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
      if (slug) {
        const base = `${portalBase()}/jobs/${encodeURIComponent(slug)}/?src=outreach`;
        const applyUrl = base + "&go=apply", referUrl = base + "&refer=1";
        const brief = await ensureBrief(admin, job, { agency: s.footerName || agencyName, address: s.businessAddress, includePay: s.includePay, applyUrl, referUrl });
        pack = { applyUrl, referUrl, brief };
      }
    }
  } catch (e) { console.error("job links", jobId, String((e as Error)?.message || e)); }
  cache.set(jobId, pack);
  return pack;
}
const extrasOf = (p: JobPack): Extras => p ? { applyUrl: p.applyUrl, referUrl: p.referUrl, briefUrl: p.brief?.url } : {};

export async function queueProspects(admin: any, ids: string[], approver: string | null, s: Settings, agencyName: string) {
  const missing = sendBlockers(s);
  if (missing.length) throw new Error("Before emailing anyone, add your " + missing.join(" and ") + " in Outreach > Setup (required by anti-spam law).");
  const { data: rows } = await admin.from("prospects").select("*").in("id", ids).in("status", ["found", "approved"]);
  let queued = 0;
  const cache = new Map<string, JobPack>();
  for (const p of rows || []) {
    if (!p.email || !p.body) continue;
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(p.email)).maybeSingle();
    if (sup) { await admin.from("prospects").update({ status: "unsubscribed" }).eq("id", p.id); continue; }
    const region = (p.region as Region) || regionOf(countryCode(p.country));
    const { error } = await admin.from("outreach_messages").insert({
      kind: "candidate", prospect_id: p.id, to_email: p.email, to_name: p.full_name,
      subject: p.subject || "A role that fits your background", body: finalBody(p.body, p.unsub_token, "p", region, s, agencyName, "candidate", extrasOf(await jobPack(admin, p.job_id, s, agencyName, cache))),
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
  for (const l of rows || []) {
    if (!l.contact_email || !l.pitch_body) continue;
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(l.contact_email)).maybeSingle();
    if (sup) { await admin.from("leads").update({ status: "unsubscribed" }).eq("id", l.id); continue; }
    const region = (l.region as Region) || regionOf(countryCode(l.country));
    const { error } = await admin.from("outreach_messages").insert({
      kind: "client", lead_id: l.id, to_email: l.contact_email, to_name: l.contact_name,
      subject: l.pitch_subject || `Candidate for your ${l.job_title} role`, body: finalBody(l.pitch_body, l.unsub_token, "l", region, s, agencyName, "client"),
      approved_by: approver,
    });
    if (error) throw new Error(error.message);
    await admin.from("leads").update({ status: "queued" }).eq("id", l.id);
    queued++;
  }
  return queued;
}

// Send what's waiting, oldest first, within today's cap. Every address is re-checked against
// the unsubscribe list right before sending.
export async function processQueue(admin: any, s: Settings, max = 8) {
  if (provider() === "none") return { sent: 0, waiting: true, message: "No outreach sender connected yet; approved emails are waiting in the queue." };
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", since.toISOString());
  const room = Math.max(0, s.dailyCap - (sentToday || 0));
  if (!room) return { sent: 0, capped: true, message: `Today's limit of ${s.dailyCap} emails is reached; the rest go out tomorrow.` };
  const { data: batch } = await admin.from("outreach_messages").select("*").eq("status", "queued").order("created_at").limit(Math.min(max, room));
  let sent = 0, failed = 0;
  const cache = new Map<string, JobPack>();
  for (const m of batch || []) {
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(m.to_email)).maybeSingle();
    if (sup) { await admin.from("outreach_messages").update({ status: "skipped", error: "Unsubscribed" }).eq("id", m.id); continue; }
    let first = "", last = "", company = "", token = "", body = String(m.body || "");
    let attachment: Attachment | undefined;
    if (m.prospect_id) {
      const { data: p } = await admin.from("prospects").select("first_name,last_name,company,unsub_token,job_id").eq("id", m.prospect_id).maybeSingle();
      first = p?.first_name || ""; last = p?.last_name || ""; company = p?.company || ""; token = p?.unsub_token || "";
      // Gmail can carry the role summary as a real attachment, so the link line comes out.
      if (provider() === "gmail" && body.includes(BRIEF_PREFIX)) {
        const brief = (await jobPack(admin, p?.job_id || null, s, "", cache))?.brief;
        if (brief) { attachment = { name: brief.name, type: "application/pdf", bytes: brief.bytes }; body = body.split("\n").filter((l) => !l.startsWith(BRIEF_PREFIX)).join("\n"); }
      }
    } else if (m.lead_id) {
      const { data: l } = await admin.from("leads").select("contact_first_name,contact_name,company,unsub_token").eq("id", m.lead_id).maybeSingle();
      first = l?.contact_first_name || ""; last = String(l?.contact_name || "").split(" ").slice(1).join(" "); company = l?.company || ""; token = l?.unsub_token || "";
    }
    try {
      const r = await sendMail({ kind: m.kind, to: m.to_email, toName: m.to_name || "", firstName: first, lastName: last, company, subject: m.subject, body,
        unsubUrl: linkFor(token, m.prospect_id ? "p" : "l", "unsubscribe"), attachment }, s.senderName);
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
  return { sent, failed, message: `Sent ${sent}${failed ? `, ${failed} failed` : ""}.` };
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
    const { data: q } = await admin.from("outreach_messages").select("subject,body").eq("prospect_id", id).eq("status", "queued").limit(1).maybeSingle();
    const region = (p.region as Region) || regionOf(countryCode(p.country));
    const pack = await jobPack(admin, p.job_id, s, agencyName, new Map());
    return { to: p.email, toName: p.full_name || "", subject: q?.subject || p.subject || "A role that fits your background",
      body: q?.body || finalBody(p.body, p.unsub_token, "p", region, s, agencyName, "candidate", extrasOf(pack)),
      brief: pack?.brief ? { url: pack.brief.url, name: pack.brief.name } : null };
  }
  const { data: l } = await admin.from("leads").select("*").eq("id", id).maybeSingle();
  if (!l) throw new Error("Not found");
  if (!l.contact_email) throw new Error("No email address for this contact");
  if (["unsubscribed", "lost", "ignored"].includes(l.status)) throw new Error("This contact shouldn't be emailed");
  const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(l.contact_email)).maybeSingle();
  if (sup) { await admin.from("leads").update({ status: "unsubscribed" }).eq("id", l.id); throw new Error("They've unsubscribed, so they can't be emailed"); }
  const { data: q } = await admin.from("outreach_messages").select("subject,body").eq("lead_id", id).eq("status", "queued").limit(1).maybeSingle();
  const region = (l.region as Region) || regionOf(countryCode(l.country));
  return { to: l.contact_email, toName: l.contact_name || "", subject: q?.subject || l.pitch_subject || `Candidate for your ${l.job_title} role`,
    body: q?.body || finalBody(l.pitch_body, l.unsub_token, "l", region, s, agencyName, "client") };
}

export async function markManualSent(admin: any, kind: "p" | "l", id: string) {
  const now = new Date().toISOString();
  const col = kind === "p" ? "prospect_id" : "lead_id";
  // Anything still waiting in the queue for them is marked sent by hand, so it never goes twice.
  await admin.from("outreach_messages").update({ status: "sent", sent_at: now, provider: "manual" }).eq(col, id).eq("status", "queued");
  await admin.from(kind === "p" ? "prospects" : "leads").update({ status: "contacted", contacted_at: now }).eq("id", id);
  return { ok: true };
}
