import { createClient } from "npm:@supabase/supabase-js@2";
import { storeEvents, toRow } from "./events.ts";

// Admin-only: every email the app sent to a CANDIDATE through Brevo in the last 7 or 30 days, one row
// per email, with the candidate's name, whether it was delivered, opened and clicked (or bounced /
// blocked / marked as spam). Emails to staff (welcome, password reset, approvals, tests) are left out.
// A recipient counts as a candidate when their address is on a candidate, an application/referral or
// a sourced prospect, and isn't a staff account.
// Events are stored in public.email_events: pushed by Brevo's webhook (brevo-webhook) as they
// happen, plus a catch-up every 15 minutes (action "sync", scheduler only) that asks Brevo's event
// log (GET /v3/smtp/statistics/events) only for events since the newest one stored. The page reads
// the table, so it loads straight away and keeps history after Brevo has dropped it.
//   POST { days: 7 | 30 | 90 | 365, refresh? }  ->  { rows, totals, days, syncedAt }  (refresh: catch up first)
//   POST { action: "sync" } + x-harbor-ops      ->  { fetched, stored }
//   POST { action: "preview", messageId }       ->  { subject, to, date, html }  (the email as sent;
//        only for candidate recipients, so staff emails with reset codes or setup links never show)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-harbor-ops",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// What kind of email it was, from its subject (the app's own subject lines).
function typeOf(subject: string, tag: string): string {
  const s = subject || "";
  if (/^\[TEST\]/.test(s)) return "Test";
  if (/^Welcome to /.test(s)) return "Welcome";
  if (/password reset/i.test(s)) return "Password reset";
  if (/^(Interview booked|Interview cancelled|Updated time|Tomorrow:|Starting in an hour|We missed you)/.test(s)) return "Interview";
  if (/under review/i.test(s)) return "Application received";
  if (/^An update on /.test(s)) return "Candidate message";
  if (/referred you/i.test(s)) return "Referral";
  if (/^Approval needed/.test(s)) return "Approval";
  if (tag) return tag;
  return "Outreach & other";
}

const BOUNCE: Record<string, string> = {
  hard_bounce: "Bounced: the address doesn't exist or refused it",
  soft_bounce: "Soft bounce: inbox full or unavailable",
  blocked: "Blocked by Brevo (address previously bounced or unsubscribed)", invalid: "Invalid email address",
  error: "Couldn't be sent", deferred: "Delayed by the receiving server",
};

type Row = {
  id: string; to: string; subject: string; type: string; sentAt: string | null;
  deliveredAt: string | null; openedAt: string | null; opens: number; proxyOnly: boolean;
  clickedAt: string | null; clicks: number; links: string[];
  problem: string | null; spam: boolean; unsubscribed: boolean; lastAt: string; name?: string;
};
const STAFF_TYPES = new Set(["Welcome", "Password reset", "Approval", "Test"]);

// email (lowercase) -> candidate name, from candidates, then applications/referrals, then prospects.
async function candidateNames(admin: any): Promise<{ names: Map<string, string>; staff: Set<string> }> {
  const names = new Map<string, string>();
  const all = async (table: string, cols: string) => {
    const out: any[] = [];
    for (let from = 0; from < 50000; from += 1000) {
      const { data } = await admin.from(table).select(cols).not("email", "is", null).range(from, from + 999);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  };
  const [cands, apps, pros, staff] = await Promise.all([
    all("candidates", "email,name"), all("applications", "email,name"), all("prospects", "email,full_name,first_name,last_name"), all("profiles", "email"),
  ]);
  const add = (email: string, name: string) => { const k = String(email || "").trim().toLowerCase(); if (k && !names.has(k)) names.set(k, String(name || "").trim()); };
  for (const c of cands) add(c.email, c.name);
  for (const a of apps) add(a.email, a.name);
  for (const p of pros) add(p.email, p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" "));
  return { names, staff: new Set(staff.map((p: any) => String(p.email || "").trim().toLowerCase())) };
}

// Ask Brevo only for what's new: from the day before the newest stored event (the event log
// filters by whole days; repeats are skipped by the dedupe key). First run: the last 30 days.
async function syncFromBrevo(admin: any, key: string) {
  // The cursor is the newest event the sync itself stored, so webhook events never make it skip history.
  const { data: last } = await admin.from("email_events").select("at").eq("source", "sync").order("at", { ascending: false }).limit(1).maybeSingle();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const start = last?.at ? new Date(new Date(last.at).getTime() - 864e5) : new Date(Date.now() - 30 * 864e5);
  const LIMIT = 2500, MAX_PAGES = 20;
  let fetched = 0, stored = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://api.brevo.com/v3/smtp/statistics/events?limit=${LIMIT}&offset=${page * LIMIT}&startDate=${day(start)}&endDate=${day(new Date())}&sort=asc`;
    const r = await fetch(url, { headers: { "api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      if (page === 0) throw new Error("Brevo didn't return the email log (" + r.status + "). " + t.slice(0, 200));
      break;
    }
    const j = await r.json().catch(() => ({}));
    const list = Array.isArray(j.events) ? j.events : [];
    fetched += list.length;
    stored += await storeEvents(admin, list.map((e: any) => toRow(e, "sync")).filter(Boolean) as any[]);
    if (list.length < LIMIT) break;
  }
  // Kept for a year.
  await admin.from("email_events").delete().lt("at", new Date(Date.now() - 365 * 864e5).toISOString());
  return { fetched, stored };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // Scheduled catch-up (every 15 minutes).
    const opsKey = req.headers.get("x-harbor-ops") || "";
    if (opsKey) {
      const { data: tok } = await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!tok || opsKey.length < 32) return json({ error: "Invalid ops token" }, 403);
      const k = Deno.env.get("BREVO_API_KEY");
      if (!k) return json({ error: "BREVO_API_KEY is not set" }, 400);
      return json({ ok: true, ...(await syncFromBrevo(admin, k)) });
    }
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("role,status").eq("id", caller.user.id).single();
    if (!me || me.role !== "admin" || me.status !== "Active") return json({ error: "Only admins can see email tracking" }, 403);

    const key = Deno.env.get("BREVO_API_KEY");
    if (!key) return json({ error: "Brevo isn't connected (BREVO_API_KEY is not set)" }, 400);
    const body = await req.json().catch(() => ({}));

    if (body.action === "preview") {
      const messageId = String(body.messageId || "");
      if (!messageId || messageId.length > 300) return json({ error: "No email selected" }, 400);
      const h = { "api-key": key, accept: "application/json" };
      const lr = await fetch("https://api.brevo.com/v3/smtp/emails?limit=5&messageId=" + encodeURIComponent(messageId), { headers: h, signal: AbortSignal.timeout(15000) });
      const lj = await lr.json().catch(() => ({}));
      const meta = (lj.transactionalEmails || [])[0];
      if (!lr.ok || !meta?.uuid) return json({ error: "Brevo no longer has a copy of this email (it keeps them for a limited time)." }, 404);
      const k = String(meta.email || "").trim().toLowerCase();
      const { names, staff } = await candidateNames(admin);
      if (staff.has(k) || !names.has(k) || STAFF_TYPES.has(typeOf(String(meta.subject || ""), ""))) return json({ error: "Only emails sent to candidates can be previewed here." }, 403);
      const cr = await fetch("https://api.brevo.com/v3/smtp/emails/" + encodeURIComponent(meta.uuid), { headers: h, signal: AbortSignal.timeout(15000) });
      const cj = await cr.json().catch(() => ({}));
      if (!cr.ok || !cj.body) return json({ error: "Brevo no longer has the content of this email (it keeps it for a limited time)." }, 404);
      return json({ ok: true, subject: cj.subject || meta.subject || "", to: meta.email || "", name: names.get(k) || "", date: cj.date || meta.date || "", html: String(cj.body) });
    }

    const days = [7, 30, 90, 365].includes(Number(body.days)) ? Number(body.days) : 30;

    // "Refresh", or nothing stored yet: catch up with Brevo first (only new events are fetched).
    const { count: have } = await admin.from("email_events").select("id", { count: "exact", head: true }).eq("source", "sync");
    let syncError = "";
    if (body.refresh || !have) { try { await syncFromBrevo(admin, key); } catch (e) { syncError = String((e as Error)?.message || e); if (!have) return json({ error: syncError }, 502); } }

    // The stored events for the period, oldest first.
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const events: any[] = [];
    for (let from = 0; from < 300000; from += 1000) {
      const { data, error } = await admin.from("email_events").select("message_id,email,event,subject,tag,link,reason,at").gte("at", since).order("at").range(from, from + 999);
      if (error) return json({ error: error.message }, 500);
      events.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const { data: newest } = await admin.from("email_events").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();

    const byId = new Map<string, Row>();
    for (const e of events) {
      const at = String(e.at || "");
      const id = String(e.message_id || "") || `nomsg|${e.email}|${e.subject}|${at.slice(0, 16)}`;
      let row = byId.get(id);
      if (!row) {
        row = { id, to: String(e.email || ""), subject: String(e.subject || ""), type: typeOf(String(e.subject || ""), String(e.tag || "")), sentAt: null,
          deliveredAt: null, openedAt: null, opens: 0, proxyOnly: true, clickedAt: null, clicks: 0, links: [], problem: null, spam: false, unsubscribed: false, lastAt: at };
        byId.set(id, row);
      }
      if (at > row.lastAt) row.lastAt = at;
      const earliest = (cur: string | null) => (!cur || at < cur ? at : cur);
      switch (String(e.event || "")) {
        case "request": row.sentAt = earliest(row.sentAt); break;
        case "delivered": row.deliveredAt = earliest(row.deliveredAt); break;
        case "opened": row.opens++; row.proxyOnly = false; row.openedAt = earliest(row.openedAt); break;
        case "unique_opened": row.proxyOnly = false; row.openedAt = earliest(row.openedAt); if (!row.opens) row.opens = 1; break;
        case "proxy_open": row.opens++; row.openedAt = earliest(row.openedAt); break;
        case "click": row.clicks++; row.clickedAt = earliest(row.clickedAt); if (e.link && !row.links.includes(e.link) && row.links.length < 5) row.links.push(String(e.link)); break;
        case "spam": row.spam = true; break;
        case "unsubscribed": row.unsubscribed = true; break;
        default: { const ev = String(e.event || ""); if (BOUNCE[ev] && ev !== "deferred") row.problem = String(e.reason || BOUNCE[ev]).slice(0, 200); }
      }
    }
    const { names, staff } = await candidateNames(admin);
    const rows = [...byId.values()].filter((r) => {
      const k = r.to.trim().toLowerCase();
      if (STAFF_TYPES.has(r.type) || staff.has(k) || !names.has(k)) return false;
      r.name = names.get(k) || "";
      return true;
    }).map((r) => {
      // Opening or clicking also proves it arrived, even if the delivered event is missing.
      if (!r.deliveredAt && (r.openedAt || r.clickedAt)) r.deliveredAt = r.openedAt || r.clickedAt;
      if (!r.sentAt) r.sentAt = r.deliveredAt || r.lastAt;
      if (!r.opens) r.proxyOnly = false;
      if (r.deliveredAt) r.problem = r.problem && /soft|delay/i.test(r.problem) ? null : r.problem;
      return r;
    }).sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));

    const totals = {
      sent: rows.length,
      delivered: rows.filter((r) => r.deliveredAt).length,
      opened: rows.filter((r) => r.openedAt).length,
      clicked: rows.filter((r) => r.clickedAt).length,
      problems: rows.filter((r) => r.problem || r.spam).length,
    };
    return json({ ok: true, days, rows: rows.slice(0, 5000), totals, truncated: rows.length > 5000, syncedAt: newest?.created_at || null, ...(syncError ? { warning: "Couldn't reach Brevo just now; showing what's stored. " + syncError.slice(0, 160) } : {}) });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
