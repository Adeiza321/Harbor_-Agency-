import { createClient } from "npm:@supabase/supabase-js@2";

// Apollo -> ProNext: replies, unsubscribes and bounces on the emails ProNext sent through Apollo
// sequences, so a reply never sits unseen in Apollo.
//   POST { action: "sync" } + x-harbor-ops     every 15 minutes (pg_cron, harbor-apollo-sync)
//   POST { action: "sync" } signed in (staff)  the "Check Apollo for replies" button
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
// The reply itself is read in the outreach mailbox (Apollo doesn't expose its text here).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-harbor-ops",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "https://api.apollo.io/api/v1";

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
    if (res.status === 403) throw new Error("Apollo refused: this needs a Master API key (Settings > Integrations > API).");
    if (!res.ok) throw new Error("Apollo " + res.status + ": " + String(data?.error || data?.message || "").slice(0, 200));
    return data;
  }
  throw new Error("Apollo is rate-limiting requests; try again in a minute");
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

async function applyEvent(admin: any, ev: Ev) {
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
  const note = { event: ev.kind, replyClass: ev.replyClass || null, at: ev.at, syncedAt: new Date().toISOString() };
  let changed = "";

  if (prospectId) {
    const { data: p } = await admin.from("prospects").select("id,status,email,data").eq("id", prospectId).maybeSingle();
    if (p) {
      let next = "";
      if (unsub) next = p.status === "converted" ? "" : "unsubscribed";
      else if (ev.kind === "bounced") next = EMAILED_PROSPECT.includes(p.status) ? "bounced" : "";
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
    const r = await applyEvent(admin, ev);
    await admin.from("apollo_events").insert({ id: ev.id, kind: ev.kind, reply_class: ev.replyClass || null, contact_id: ev.contactId || null,
      email: ev.email || null, sequence_id: ev.sequenceId || null, at: ev.at, prospect_id: r.prospectId, lead_id: r.leadId, status_change: r.changed || null });
    applied++;
    if (ev.kind === "reply") replies++; else if (ev.kind === "unsubscribed") unsubscribes++; else bounces++;
    if (r.changed) changes.push(r.changed);
  }
  return { ok: true, checked: events.length, applied, replies, unsubscribes, bounces, statusChanges: changes.length };
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
    } else {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: caller } = await admin.auth.getUser(jwt);
      if (!caller?.user) return json({ error: "Not signed in" }, 401);
      const { data: me } = await admin.from("profiles").select("status").eq("id", caller.user.id).single();
      if (!me || me.status !== "Active") return json({ error: "Your account isn't active" }, 403);
    }
    const body = await req.json().catch(() => ({}));
    if (body.action !== "sync") return json({ error: "Unknown action" }, 400);
    return json(await sync(admin));
  } catch (e) {
    console.error("apollo-sync", String((e as Error)?.message || e));
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
