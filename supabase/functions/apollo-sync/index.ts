import { createClient } from "npm:@supabase/supabase-js@2";

// Apollo -> ProNext: replies, unsubscribes and bounces on the emails ProNext sent through Apollo
// sequences, so a reply never sits unseen in Apollo.
//   POST { action: "sync" } + x-harbor-ops     every 15 minutes (pg_cron, harbor-apollo-sync)
//   POST { action: "sync" } signed in (staff)  the "Check Apollo for replies" button
//   POST { action: "tracking", days, refresh? } (admins)  Email tracking > Apollo (from the saved snapshot, see buildSnapshot): every email in ProNext's
//                                                sequences, live from Apollo: scheduled (and when),
//                                                sent, opened, clicked, replied, bounced, not sent (why),
//                                                each email's step, each sequence's steps, and where
//                                                each person is in the sequence (active/paused/finished)
//   POST { action: "preview", contactId } (admins) the email ProNext gave Apollo for that person
//
// Reads Apollo's "search for outreach emails" (no credits) for ProNext's sequences over the last
// 30 days: emails with a reply (any reply class), unsubscribed, or bounced. Each event is applied
// once (public.apollo_events), to the prospect or lead that email went to:
//   reply: wants to talk / asked a question / referred someone  -> prospect "interested", lead "replied"
//          not interested / wrong person or left                 -> prospect "not_interested", lead "lost"
//          unsubscribe                                           -> "unsubscribed" + do-not-email list
//          out of office / other                                 -> noted only
//   unsubscribed -> "unsubscribed" + do-not-email list;   bounced -> prospect "bounced" (lead: noted)
// Status only moves while the person is still at the emailed stage, so a recruiter's later
// decision (converted, rejected, meeting...) is never overwritten. Unsubscribes always apply.
// The reply itself (text, subject, sender) is read from the email's activities in Apollo and kept on
// the prospect/lead (data.apollo.reply), so it shows on the Outreach card. Automatic replies (out of
// office, "company in liquidation, email X instead") are often misclassed by Apollo as a referral or
// a question: they're marked auto and never move anyone to Interested/Replied. For a real referral,
// any email addresses in the reply (not the sender's or ours) are listed as referred.
// Each sync also fills in the text for up to 15 recent replies that don't have it yet (and undoes an
// Interested/Replied that an automatic reply caused, while nobody has changed it since).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-harbor-ops",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "https://api.apollo.io/api/v1";
// Apollo limits how many requests an account makes per minute, hour and day. When it says "too
// many" even after waiting, every scheduled run pauses for a while instead of hammering it (which
// kept the limit hit all night), and the manual button explains it in plain words.
class RateLimited extends Error {}
const RATE_MSG = "Apollo is limiting how often ProNext can check it right now. It catches up by itself within the hour, so there's nothing to do.";
const PAUSE_KEY = "apollo_sync_pause";
const PAUSE_MIN = 45;

const REPLY_CLASSES = ["willing_to_meet", "follow_up_question", "person_referral", "out_of_office",
  "already_left_company_or_not_right_person", "not_interested", "unsubscribe", "none_of_the_above"];
const POSITIVE = new Set(["willing_to_meet", "follow_up_question", "person_referral"]);
const NEGATIVE = new Set(["not_interested", "already_left_company_or_not_right_person"]);
const EMAILED_PROSPECT = ["approved", "queued", "contacted"];
const EMAILED_LEAD = ["approved", "queued", "contacted"];

const normEmail = (e: string) => {
  const [u, d] = String(e || "").trim().toLowerCase().split("@");
  return d ? u.replace(/\+.*$/, "") + "@" + d : "";
};
async function emailHash(e: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normEmail(e)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function apollo(path: string, q: URLSearchParams) {
  const key = (Deno.env.get("APOLLO_API_KEY") || "").trim();
  if (!key) throw new Error("Apollo isn't connected (APOLLO_API_KEY)");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}${path}?${q}`, { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": key }, signal: AbortSignal.timeout(30000) });
    if (res.status === 429) { await sleep(attempt ? 20000 : 5000); continue; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error("Apollo refused the request: it needs a Master API key (Apollo: Settings > Integrations > API).");
    if (!res.ok) throw new Error("Apollo " + res.status + ": " + String(data?.error || data?.message || "").slice(0, 200));
    return data;
  }
  throw new RateLimited(RATE_MSG);
}

async function apolloPost(path: string, body: Record<string, unknown>) {
  const key = (Deno.env.get("APOLLO_API_KEY") || "").trim();
  if (!key) throw new Error("Apollo isn't connected (APOLLO_API_KEY)");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": key }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (res.status === 429) { await sleep(attempt ? 20000 : 5000); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Apollo " + res.status + ": " + String(data?.error || data?.message || "").slice(0, 200));
    return data;
  }
  throw new RateLimited(RATE_MSG);
}

// ---- The reply's own text, from the email's activities in Apollo (no credits) ----
const AUTO_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|autoreply|auto:|out of (the )?office|ooo\b|away from (the )?office|abwesenheitsnotiz|r[ée]ponse automatique|respuesta autom[áa]tica|risposta automatica|automatisch antwoord)/i;
const AUTO_TEXT = /^\s*(this is an auto(mated|matic)[- ]?(reply|response|message)|i('| a)m (currently )?(out of (the )?office|away|on (annual )?leave))/i;
const decode = (t: string) => t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
function htmlToText(h: string) {
  return decode(h.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "").replace(/<blockquote[\s\S]*$/i, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, ""));
}
function cleanReply(t: string) {
  let s = t.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\r/g, "");
  // Stop at the quoted email or the legal footer.
  const cut = s.search(/\n\s*(On .{4,200}wrote:|-{2,}\s*Original Message|From: .+\n|Sent from my |>\s|Disclaimer\b|This e-?mail (may|and any|is|has been)|Please consider the environment|Registered in England)/i);
  if (cut > 0) s = s.slice(0, cut);
  return s.split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);
}
type Reply = { text: string; subject: string; from: string; fromName: string; at: string; auto: boolean; referred: string[] };
async function readReply(messageId: string): Promise<Reply | null> {
  const a = await apollo("/emailer_messages/" + messageId + "/activities", new URLSearchParams());
  const ours = String(a?.emailer_message?.from_email || "").toLowerCase();
  const ourDomain = ours.split("@")[1] || "";
  const list = (Array.isArray(a?.activities) ? a.activities : []).map((x: any) => x?.emailer_message)
    .filter((m: any) => m?.id && m.type !== "outreach_automatic_email" && String(m.from_email || "").toLowerCase() !== ours)
    .sort((x: any, y: any) => String(x.completed_at || x.created_at || "").localeCompare(String(y.completed_at || y.created_at || "")));
  const m = list[list.length - 1];
  if (!m) return null;
  // The activity's text is cut short; the email itself has the full HTML.
  let text = String(m.body_text || "");
  try {
    const full = (await apollo("/emailer_messages/" + m.id, new URLSearchParams()))?.emailer_message || {};
    const fromHtml = full.body_html ? htmlToText(String(full.body_html)) : "";
    const t = String(full.body_text || "");
    text = fromHtml.length > t.length ? fromHtml : (t || text);
  } catch (_) { /* keep the short text */ }
  text = cleanReply(text);
  const subject = String(m.subject || "").slice(0, 300);
  const from = String(m.from_email || "").toLowerCase();
  const auto = AUTO_SUBJECT.test(subject) || AUTO_TEXT.test(text);
  const referred = auto ? [] : [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase()))]
    .filter((e) => e !== from && e !== ours && !(ourDomain && e.endsWith("@" + ourDomain)) && !/^(no-?reply|mailer-daemon|postmaster)@/.test(e)).slice(0, 5);
  return { text, subject, from, fromName: String(m.from_name || ""), at: String(m.completed_at || m.created_at || ""), auto, referred };
}

type Ev = { id: string; kind: "reply" | "unsubscribed" | "bounced"; contactId: string; email: string; replyClass: string; at: string; sequenceId: string };

// Emails in our sequences over the window, filtered one way (a reply class list, or a stat).
async function fetchMessages(seqs: string[], filter: (q: URLSearchParams) => void, kind: Ev["kind"]): Promise<Ev[]> {
  const out: Ev[] = [];
  const min = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const max = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  for (let page = 1; page <= 10; page++) {
    const q = new URLSearchParams();
    seqs.forEach((id) => q.append("emailer_campaign_ids[]", id));
    filter(q);
    q.set("emailer_message_date_range_mode", "completed_at");
    q.set("emailer_message_date_range[min]", min);
    q.set("emailer_message_date_range[max]", max);
    q.set("per_page", "100");
    q.set("page", String(page));
    const d = await apollo("/emailer_messages/search", q);
    const list: any[] = Array.isArray(d?.emailer_messages) ? d.emailer_messages : [];
    for (const m of list) {
      if (!m?.id) continue;
      if (kind === "reply" && !m.reply_class && !m.replied) continue;
      out.push({ id: String(m.id) + ":" + kind, kind, contactId: String(m.contact_id || ""), email: String(m.to_email || "").toLowerCase(),
        replyClass: kind === "reply" ? String(m.reply_class || "none_of_the_above") : "", at: String(m.completed_at || m.created_at || new Date().toISOString()), sequenceId: String(m.emailer_campaign_id || "") });
    }
    if (list.length < 100) break;
  }
  return out;
}

async function suppress(admin: any, email: string, reason: string) {
  if (email) await admin.from("outreach_suppressions").upsert({ email_norm: await emailHash(email), reason }, { onConflict: "email_norm" });
}

async function applyEvent(admin: any, ev: Ev, reply: Reply | null = null) {
  // Who it went to: the outreach message Apollo sent (contact id), else the address.
  let prospectId: string | null = null, leadId: string | null = null;
  if (ev.contactId) {
    const { data: om } = await admin.from("outreach_messages").select("prospect_id,lead_id").eq("provider", "apollo").eq("provider_ref", ev.contactId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    prospectId = om?.prospect_id || null; leadId = om?.lead_id || null;
  }
  if (!prospectId && !leadId && ev.email) {
    const { data: p } = await admin.from("prospects").select("id").ilike("email", ev.email).not("contacted_at", "is", null).order("contacted_at", { ascending: false }).limit(1).maybeSingle();
    if (p) prospectId = p.id;
    else {
      const { data: l } = await admin.from("leads").select("id").ilike("contact_email", ev.email).not("contacted_at", "is", null).order("contacted_at", { ascending: false }).limit(1).maybeSingle();
      if (l) leadId = l.id;
    }
  }
  const unsub = ev.kind === "unsubscribed" || ev.replyClass === "unsubscribe";
  const auto = !!reply?.auto && !unsub;
  const note: Record<string, unknown> = { event: ev.kind, replyClass: ev.replyClass || null, at: ev.at, syncedAt: new Date().toISOString() };
  if (ev.kind === "reply") { note.messageId = ev.id.split(":")[0]; note.replyChecked = true; if (reply) note.reply = reply; }
  let changed = "";

  if (prospectId) {
    const { data: p } = await admin.from("prospects").select("id,status,email,data").eq("id", prospectId).maybeSingle();
    if (p) {
      let next = "";
      if (unsub) next = p.status === "converted" ? "" : "unsubscribed";
      else if (ev.kind === "bounced") next = EMAILED_PROSPECT.includes(p.status) ? "bounced" : "";
      else if (auto) next = "";
      else if (POSITIVE.has(ev.replyClass)) next = EMAILED_PROSPECT.includes(p.status) ? "interested" : "";
      else if (NEGATIVE.has(ev.replyClass)) next = EMAILED_PROSPECT.includes(p.status) ? "not_interested" : "";
      const upd: Record<string, unknown> = { data: { ...(p.data || {}), apollo: note }, updated_at: new Date().toISOString() };
      if (next && next !== p.status) { upd.status = next; changed = "prospect:" + next; }
      await admin.from("prospects").update(upd).eq("id", p.id);
      if (unsub) await suppress(admin, p.email || ev.email, "Unsubscribed in Apollo");
    }
  } else if (leadId) {
    const { data: l } = await admin.from("leads").select("id,status,contact_email,data").eq("id", leadId).maybeSingle();
    if (l) {
      let next = "";
      if (unsub) next = l.status === "won" ? "" : "unsubscribed";
      else if (auto) next = "";
      else if (POSITIVE.has(ev.replyClass)) next = EMAILED_LEAD.includes(l.status) ? "replied" : "";
      else if (NEGATIVE.has(ev.replyClass)) next = EMAILED_LEAD.includes(l.status) ? "lost" : "";
      const upd: Record<string, unknown> = { data: { ...(l.data || {}), apollo: note }, updated_at: new Date().toISOString() };
      if (next && next !== l.status) { upd.status = next; changed = "lead:" + next; }
      await admin.from("leads").update(upd).eq("id", l.id);
      if (unsub) await suppress(admin, l.contact_email || ev.email, "Unsubscribed in Apollo");
    }
  } else if (unsub) {
    // Not matched to anyone, but they still never get another ProNext email.
    await suppress(admin, ev.email, "Unsubscribed in Apollo");
  }
  return { prospectId, leadId, changed };
}

async function sync(admin: any) {
  const seqs = [...new Set([Deno.env.get("APOLLO_SEQUENCE_ID"), Deno.env.get("APOLLO_CLIENT_SEQUENCE_ID")].map((x) => String(x || "").trim()).filter(Boolean))];
  if (!seqs.length) return { ok: true, skipped: "No Apollo sequence is set (APOLLO_SEQUENCE_ID)" };
  const events = [
    ...(await fetchMessages(seqs, (q) => REPLY_CLASSES.forEach((c) => q.append("emailer_message_reply_classes[]", c)), "reply")),
    ...(await fetchMessages(seqs, (q) => q.append("emailer_message_stats[]", "unsubscribed"), "unsubscribed")),
    ...(await fetchMessages(seqs, (q) => q.append("emailer_message_stats[]", "bounced"), "bounced")),
  ];
  const ids = [...new Set(events.map((e) => e.id))];
  const done = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from("apollo_events").select("id").in("id", ids.slice(i, i + 200));
    (data || []).forEach((r: any) => done.add(r.id));
  }
  let applied = 0, replies = 0, unsubscribes = 0, bounces = 0;
  const changes: string[] = [];
  for (const ev of events) {
    if (done.has(ev.id)) continue;
    done.add(ev.id);
    let reply: Reply | null = null;
    if (ev.kind === "reply") { try { reply = await readReply(ev.id.split(":")[0]); } catch (e) { console.error("apollo reply text", ev.id, String((e as Error)?.message || e)); } }
    const r = await applyEvent(admin, ev, reply);
    await admin.from("apollo_events").insert({ id: ev.id, kind: ev.kind, reply_class: ev.replyClass || null, contact_id: ev.contactId || null,
      email: ev.email || null, sequence_id: ev.sequenceId || null, at: ev.at, prospect_id: r.prospectId, lead_id: r.leadId, status_change: r.changed || null });
    applied++;
    if (ev.kind === "reply") replies++; else if (ev.kind === "unsubscribed") unsubscribes++; else bounces++;
    if (r.changed) changes.push(r.changed);
  }
  const filled = await backfillReplies(admin);
  return { ok: true, checked: events.length, applied, replies, unsubscribes, bounces, statusChanges: changes.length, repliesFilled: filled };
}

// Replies synced before ProNext read their text (or whose read failed): fill in up to 5 per run.
async function backfillReplies(admin: any) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: evs } = await admin.from("apollo_events").select("id,at,prospect_id,lead_id,status_change").eq("kind", "reply").gte("at", since).order("at", { ascending: false }).limit(200);
  let filled = 0;
  for (const ev of evs || []) {
    if (filled >= 5) break;
    const table = ev.prospect_id ? "prospects" : ev.lead_id ? "leads" : "";
    if (!table) continue;
    const { data: row } = await admin.from(table).select("id,status,data").eq("id", ev.prospect_id || ev.lead_id).maybeSingle();
    const note = row?.data?.apollo;
    // Only the reply this person's card is showing, and only once.
    if (!row || !note || note.event !== "reply" || note.replyChecked || Math.abs(new Date(note.at).getTime() - new Date(ev.at).getTime()) > 2000) continue;
    let reply: Reply | null = null;
    try { reply = await readReply(String(ev.id).split(":")[0]); } catch (e) { console.error("apollo reply backfill", ev.id, String((e as Error)?.message || e)); continue; }
    const upd: Record<string, unknown> = { data: { ...row.data, apollo: { ...note, messageId: String(ev.id).split(":")[0], replyChecked: true, ...(reply ? { reply } : {}) } }, updated_at: new Date().toISOString() };
    // An automatic reply moved them to Interested/Replied: put them back, unless someone has moved them on since.
    if (reply?.auto && ((table === "prospects" && ev.status_change === "prospect:interested" && row.status === "interested") || (table === "leads" && ev.status_change === "lead:replied" && row.status === "replied"))) {
      upd.status = "contacted";
      (upd.data as any).apollo.autoUndone = true;
    }
    await admin.from(table).update(upd).eq("id", row.id);
    filled++;
  }
  return filled;
}


// ---- Email tracking: every email in ProNext's sequences, read live from Apollo (no credits) ----
const pick = (m: any, keys: string[]) => { for (const k of keys) { const v = m?.[k]; if (v !== undefined && v !== null && v !== "") return v; } return null; };
const NOT_SENT: Record<string, string> = {
  contact_stage_safeguard: "Contact stage safeguard", same_account_reply: "Someone at their company replied", account_stage_safeguard: "Account stage safeguard",
  email_unverified: "Email not verified", snippets_missing: "Missing personalisation", personalized_opener_missing: "Missing personalisation",
  thread_reply_original_email_missing: "Original email missing", no_active_email_account: "No active mailbox", email_format_invalid: "Invalid email address",
  ownership_permission: "Permission", email_service_provider_delivery_failure: "Mail provider refused it", sendgrid_dropped_email: "Dropped", mailgun_dropped_email: "Dropped",
  gdpr_compliance: "GDPR safeguard", not_valid_hard_bounce_detected: "Hard bounce", other_safeguard: "Apollo safeguard", new_job_change_detected: "Changed jobs", email_on_global_bounce_list: "On Apollo's bounce list",
};

async function tracking(admin: any, days: number, withSample = false) {
  const seqs = [...new Set([Deno.env.get("APOLLO_SEQUENCE_ID"), Deno.env.get("APOLLO_CLIENT_SEQUENCE_ID")].map((x) => String(x || "").trim()).filter(Boolean))];
  if (!seqs.length) return { ok: true, rows: [], warning: "No Apollo sequence is set (APOLLO_SEQUENCE_ID)." };
  const clientSeq = String(Deno.env.get("APOLLO_CLIENT_SEQUENCE_ID") || "").trim();
  const min = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const raw: any[] = [];
  let truncated = false;
  for (let page = 1; page <= 20; page++) {
    const q = new URLSearchParams();
    seqs.forEach((id) => q.append("emailer_campaign_ids[]", id));
    q.set("per_page", "100");
    q.set("page", String(page));
    const d = await apollo("/emailer_messages/search", q);
    const list: any[] = Array.isArray(d?.emailer_messages) ? d.emailer_messages : [];
    // No date filter on Apollo's side: filtering by due date leaves out emails already sent.
    raw.push(...list.filter((m) => String(m.status) === "scheduled" || String(m.completed_at || m.due_at || m.created_at || "") >= min));
    if (list.length < 100) break;
    if (page === 20) truncated = true;
  }
  // Opened / clicked / bounced etc. aren't on the email itself; Apollo filters by them instead.
  const STATS = ["delivered", "opened", "clicked", "bounced", "spam_blocked", "unsubscribed", "failed_other"];
  const flags = new Map<string, Set<string>>();
  // Each status is its own search; they run side by side (with the sequence lookups below) instead of one after another.
  // One status at a time (seven searches at once tripped Apollo's per-minute limit).
  const statsTask = raw.length ? (async () => { for (const stat of STATS) {
    for (let page = 1; page <= 20; page++) {
      const q = new URLSearchParams();
      seqs.forEach((id) => q.append("emailer_campaign_ids[]", id));
      q.append("emailer_message_stats[]", stat);
      q.set("per_page", "100");
      q.set("page", String(page));
      const d = await apollo("/emailer_messages/search", q);
      const list: any[] = Array.isArray(d?.emailer_messages) ? d.emailer_messages : [];
      for (const m of list) { const id = String(m.id); if (!flags.has(id)) flags.set(id, new Set()); flags.get(id)!.add(stat); }
      if (list.length < 100) break;
    }
  } })() : Promise.resolve();
  // The sequences themselves (steps, daily cap) and where each person is in them.
  const sequences: any[] = [];
  const stepById = new Map<string, { position: number; seq: string }>();
  const sampleSeq: any[] = [];
  const seqTask = Promise.all(seqs.map(async (id) => {
    try {
      const c = await apollo("/emailer_campaigns/" + id, new URLSearchParams());
      const camp = c?.emailer_campaign || {};
      const touches: any[] = Array.isArray(c?.emailer_touches) ? c.emailer_touches : [];
      const templates = new Map<string, any>((Array.isArray(c?.emailer_templates) ? c.emailer_templates : []).map((t: any) => [String(t.id), t]));
      const steps = (Array.isArray(c?.emailer_steps) ? c.emailer_steps : []).map((x: any) => {
        const touch = touches.find((t) => String(t.emailer_step_id) === String(x.id));
        const tpl = touch ? templates.get(String(touch.emailer_template_id || "")) : null;
        stepById.set(String(x.id), { position: Number(x.position) || 0, seq: id });
        return { id: String(x.id), position: Number(x.position) || 0, type: String(x.type || ""), waitTime: Number(x.wait_time) || 0, waitMode: String(x.wait_mode || "minute"),
          subject: String(tpl?.subject || ""), preview: String(tpl?.body_text || tpl?.body_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140) };
      }).sort((a: any, b: any) => a.position - b.position);
      if (withSample) sampleSeq.push({ touchKeys: touches[0] ? Object.keys(touches[0]).sort() : [], templateKeys: c?.emailer_templates?.[0] ? Object.keys(c.emailer_templates[0]).sort() : [] });
      sequences.push({ id, name: String(camp.name || ""), active: !!camp.active, maxPerDay: camp.max_emails_per_day ?? null, kind: id === clientSeq ? "client" : "candidate", steps,
        people: { active: 0, paused: 0, finished: 0, failed: 0, total: 0 } });
    } catch (e) { sequences.push({ id, name: "", steps: [], error: String((e as Error).message || e), people: { active: 0, paused: 0, finished: 0, failed: 0, total: 0 } }); }
  }));
  const where = new Map<string, any>(); // `${contactId}|${seqId}` -> status in that sequence
  const contactsTask = seqTask.then(() => Promise.all(seqs.map(async (id) => {
    for (let page = 1; page <= 20; page++) {
      const d = await apolloPost("/contacts/search", { emailer_campaign_ids: [id], per_page: 100, page });
      const list: any[] = Array.isArray(d?.contacts) ? d.contacts : [];
      for (const ct of list) {
        const st = (Array.isArray(ct.contact_campaign_statuses) ? ct.contact_campaign_statuses : []).find((x: any) => String(x.emailer_campaign_id) === id);
        if (!st) continue;
        const status = String(st.status || "").toLowerCase();
        const step = stepById.get(String(st.current_step_id || ""));
        const seq = sequences.find((x) => x.id === id);
        if (seq) { seq.people.total++; if (status in seq.people) seq.people[status]++; }
        where.set(String(ct.id) + "|" + id, { status, step: step?.position || Number(st.current_step_position) || null,
          reason: String(st.inactive_reason || st.failure_reason || "").replace(/_/g, " "), finishedAt: st.finished_at || null, pausedAt: st.paused_at || null, addedAt: st.added_at || null });
      }
      if (list.length < 100) break;
    }
  })));
  await Promise.all([statsTask, contactsTask]);
  // Keep the sequences in the order they're configured.
  sequences.sort((x, y) => seqs.indexOf(x.id) - seqs.indexOf(y.id));
  // Who each email went to in ProNext (name, role or company), by Apollo contact id.
  const ids = [...new Set(raw.map((m) => String(m.contact_id || "")).filter(Boolean))];
  const who = new Map<string, { name: string; role: string; kind: string; messageId: string }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from("outreach_messages").select("id,provider_ref,to_name,kind,created_at,prospects(full_name,jobs(role_title)),leads(contact_name,company)")
      .eq("provider", "apollo").in("provider_ref", ids.slice(i, i + 200)).order("created_at", { ascending: true });
    for (const r of data || []) who.set(String(r.provider_ref), {
      name: r.prospects?.full_name || r.leads?.contact_name || r.to_name || "",
      role: r.prospects?.jobs?.role_title || r.leads?.company || "", kind: r.kind || "", messageId: r.id,
    });
  }
  const DELAY: Record<string, string> = { hourly_limit_reached: "Mailbox hourly limit reached", daily_limit_reached: "Mailbox daily limit reached" };
  const rows = raw.map((m) => {
    const f = flags.get(String(m.id)) || new Set<string>();
    const status = String(pick(m, ["status"]) || "").toLowerCase();
    const reason = String(pick(m, ["not_sent_reason", "failure_reason"]) || "");
    const bounced = f.has("bounced") || !!pick(m, ["bounce"]) || status === "bounced" || /bounce/i.test(String(m.failure_reason || ""));
    const spam = f.has("spam_blocked") || !!pick(m, ["spam_blocked"]);
    const replied = !!pick(m, ["replied", "reply_class"]);
    const p = who.get(String(m.contact_id || ""));
    const sentAt = pick(m, ["completed_at"]);
    let state = "scheduled";
    if (bounced) state = "bounced";
    else if (spam) state = "spam";
    else if (f.has("failed_other") || /fail|not_sent|cancel/.test(status) || (reason && !sentAt)) state = "not_sent";
    else if (sentAt || status === "completed" || f.has("delivered")) state = "sent";
    else if (/draft|pause/.test(status)) state = "paused";
    const delayCd = String(pick(m, ["schedule_delayed_reason_details"]) || "");
    const inSeq = where.get(String(m.contact_id || "") + "|" + String(m.emailer_campaign_id || "")) || null;
    return {
      id: String(m.id), contactId: String(m.contact_id || ""),
      to: String(pick(m, ["to_email"]) || ""), name: p?.name || String(pick(m, ["to_name"]) || ""), role: p?.role || "",
      kind: p?.kind || (clientSeq && String(m.emailer_campaign_id) === clientSeq ? "client" : "candidate"),
      from: String(pick(m, ["from_email"]) || ""), subject: String(pick(m, ["subject"]) || ""), sequence: String(pick(m, ["campaign_name"]) || ""),
      step: stepById.get(String(m.emailer_step_id || ""))?.position || Number(pick(m, ["campaign_position"]) || 0) || null,
      sequenceId: String(m.emailer_campaign_id || ""), inSequence: inSeq, timeZone: String(pick(m, ["time_zone"]) || ""),
      state, apolloStatus: status, reason: NOT_SENT[reason] || reason.replace(/_/g, " "),
      delay: state === "scheduled" ? (DELAY[delayCd] || String(pick(m, ["schedule_delayed_reason"]) || "").replace(/ You can adjust.*$/, "")) : "",
      dueAt: pick(m, ["due_at"]), sentAt, createdAt: pick(m, ["created_at"]),
      opened: f.has("opened"), clicked: f.has("clicked"), delivered: f.has("delivered") || (state === "sent" && !bounced),
      replied, replyClass: String(pick(m, ["reply_class"]) || ""), unsubscribed: f.has("unsubscribed"),
    };
  });
  rows.sort((a, b) => String(b.sentAt || b.dueAt || "").localeCompare(String(a.sentAt || a.dueAt || "")));
  return { ok: true, rows, sequences, truncated, fetchedAt: new Date().toISOString(), ...(withSample ? { sample: raw.slice(0, 1), sampleSeq } : {}) };
}

// The tracking view is kept ready in public.app_cache ("apollo_tracking"): rebuilt after every 15-minute
// sync and whenever someone presses Refresh, so opening the page reads one row instead of ~15 Apollo calls.
// The snapshot covers 12 months; shorter periods are cut from it.
const SNAP_KEY = "apollo_tracking";
async function buildSnapshot(admin: any) {
  const snap = await tracking(admin, 365);
  await admin.from("app_cache").upsert({ key: SNAP_KEY, payload: snap, fetched_at: new Date().toISOString() });
  return snap;
}
function forDays(snap: any, days: number) {
  const min = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const rows = (snap.rows || []).filter((r: any) => r.state === "scheduled" || String(r.sentAt || r.dueAt || r.createdAt || "") >= min);
  return { ...snap, rows };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const opsKey = req.headers.get("x-harbor-ops") || "";
    if (opsKey) {
      const { data: tok } = await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!tok || opsKey.length < 32) return json({ error: "Invalid ops token" }, 403);
    }
    const body = await req.json().catch(() => ({}));
    if (!opsKey) {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: caller } = await admin.auth.getUser(jwt);
      if (!caller?.user) return json({ error: "Your session has ended. Sign in again." }, 401);
      const { data: me } = await admin.from("profiles").select("role,status").eq("id", caller.user.id).single();
      if (!me || me.status !== "Active") return json({ error: "Your account isn't active" }, 403);
      if ((body.action === "tracking" || body.action === "preview") && me.role !== "admin") return json({ error: "Only admins can see email tracking" }, 403);
    }
    if (body.action === "tracking") {
      const days = Math.max(1, Math.min(365, Number(body.days) || 30));
      if (opsKey && body.sample) return json(await tracking(admin, days, true));
      if (!body.refresh) {
        const { data: c } = await admin.from("app_cache").select("payload,fetched_at").eq("key", SNAP_KEY).maybeSingle();
        // Older than an hour means the scheduled rebuild has stopped; fetch live rather than show stale numbers.
        if (c?.payload && Date.now() - new Date(c.fetched_at).getTime() < 60 * 60000) return json({ ...forDays(c.payload, days), cached: true, fetchedAt: c.fetched_at });
      }
      return json(forDays(await buildSnapshot(admin), days));
    }
    if (body.action === "preview") {
      const { data: m } = await admin.from("outreach_messages").select("to_email,to_name,subject,body,html,sent_at,created_at").eq("provider", "apollo")
        .eq("provider_ref", String(body.contactId || "")).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!m) return json({ error: "ProNext has no copy of this email (it may have been written in Apollo)." }, 404);
      return json({ subject: m.subject, html: m.html || "<pre style='font-family:Arial;white-space:pre-wrap'>" + String(m.body || "").replace(/[&<>]/g, (c: string) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]) + "</pre>", name: m.to_name, date: m.sent_at || m.created_at });
    }
    if (body.action !== "sync") return json({ error: "That request isn't supported." }, 400);
    // Paused after Apollo's limit was hit: scheduled runs wait it out quietly.
    const { data: pause } = await admin.from("app_cache").select("payload").eq("key", PAUSE_KEY).maybeSingle();
    const until = pause?.payload?.until ? new Date(pause.payload.until).getTime() : 0;
    if (until > Date.now()) {
      if (opsKey) return json({ ok: true, paused: true, until: pause?.payload?.until });
      return json({ error: RATE_MSG }, 429);
    }
    let result: any;
    try { result = await sync(admin); }
    catch (e) {
      if (!(e instanceof RateLimited)) throw e;
      const untilIso = new Date(Date.now() + PAUSE_MIN * 60e3).toISOString();
      await admin.from("app_cache").upsert({ key: PAUSE_KEY, payload: { until: untilIso, at: new Date().toISOString() }, fetched_at: new Date().toISOString() });
      console.warn("apollo-sync: Apollo rate limit hit, pausing until", untilIso);
      return opsKey ? json({ ok: true, paused: true, until: untilIso }) : json({ error: RATE_MSG }, 429);
    }
    // The scheduled run also rebuilds the tracking snapshot, at most once an hour (the page shows a
    // snapshot up to an hour old; rebuilding it every 15 minutes used up Apollo's request limit).
    if (!opsKey) return json(result);
    let tracking_rows: number | string = "";
    const { data: snap } = await admin.from("app_cache").select("fetched_at").eq("key", SNAP_KEY).maybeSingle();
    if (!snap?.fetched_at || Date.now() - new Date(snap.fetched_at).getTime() > 50 * 60000) {
      try { tracking_rows = (await buildSnapshot(admin)).rows.length; }
      catch (e) {
        tracking_rows = e instanceof RateLimited ? "paused: Apollo rate limit" : "failed: " + String((e as Error)?.message || e).slice(0, 200);
        if (e instanceof RateLimited) await admin.from("app_cache").upsert({ key: PAUSE_KEY, payload: { until: new Date(Date.now() + PAUSE_MIN * 60e3).toISOString(), at: new Date().toISOString() }, fetched_at: new Date().toISOString() });
      }
    } else tracking_rows = "snapshot is recent";
    return json({ ...result, tracking_rows });
  } catch (e) {
    console.error("apollo-sync", String((e as Error)?.message || e));
    const m = String((e as Error)?.message || e);
    return json({ error: e instanceof RateLimited ? RATE_MSG : /Master API key/.test(m) ? m : "We couldn't check Apollo just now. It tries again by itself in 15 minutes." }, e instanceof RateLimited ? 429 : 500);
  }
});
