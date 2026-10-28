import { createClient } from "npm:@supabase/supabase-js@2";
import { storeEvents, toRow } from "./events.ts";

// Admin-only: every email the app sent through Brevo in the chosen period, one row per email, with the
// recipient's name, whether it was delivered, opened and clicked (or bounced / blocked / marked as spam).
// Three audiences: "candidates" (the default), "clients" (hiring contacts on client leads: pitches,
// contracts, follow-ups) and "staff" (welcome emails, update requests, approvals, password resets,
// assistant updates and tests sent to your own team).
// A recipient counts as a candidate when their address is on a candidate, an application/referral or
// a sourced prospect, and isn't a staff account.
// Events are stored in public.email_events: pushed by Brevo's webhook (brevo-webhook) as they
// happen, plus a catch-up every 15 minutes (action "sync", scheduler only) that asks Brevo's event
// log (GET /v3/smtp/statistics/events) only for events since the newest one stored. The page reads
// the table, so it loads straight away and keeps history after Brevo has dropped it.
//   POST { days: 7 | 30 | 90 | 365, refresh?, audience?: "candidates" | "clients" | "staff" }  ->  { rows, totals, days, syncedAt }
//   POST { action: "sync" } + x-harbor-ops      ->  { fetched, stored }
//   POST { action: "preview", messageId }       ->  { subject, to, date, html }  (the email as sent;
//        never for welcome or password-reset emails, which carry one-time links and codes)

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
  if (/^(How's sourcing going|Quick check-in on)/i.test(s)) return "Update request";
  if (/password reset/i.test(s)) return "Password reset";
  if (/^(Interview booked|Interview cancelled|Updated time|Tomorrow:|Starting in an hour|We missed you)/.test(s)) return "Interview";
  if (/under review/i.test(s)) return "Application received";
  if (/^An update on /.test(s)) return "Candidate message";
  if (/referred you/i.test(s)) return "Referral";
  if (/^Approval needed/.test(s)) return "Approval";
  if (tag === "client-pitch") return "Client pitch";
  if (tag === "spam-check") return "Spam check";
  if (/^Signed: /.test(s)) return "Signed terms";
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
const STAFF_TYPES = new Set(["Welcome", "Password reset", "Approval", "Test", "Update request"]);
// Emails that carry a one-time sign-in link or reset code: never shown in a preview.
const SECRET_TYPES = new Set(["Welcome", "Password reset"]);

// email (lowercase) -> candidate name, from candidates, then applications/referrals, then prospects.
async function candidateNames(admin: any): Promise<{ names: Map<string, string>; staff: Set<string>; staffNames: Map<string, string> }> {
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
    all("candidates", "email,name"), all("applications", "email,name"), all("prospects", "email,full_name,first_name,last_name"), all("profiles", "email,full_name"),
  ]);
  const add = (email: string, name: string) => { const k = String(email || "").trim().toLowerCase(); if (k && !names.has(k)) names.set(k, String(name || "").trim()); };
  for (const c of cands) add(c.email, c.name);
  for (const a of apps) add(a.email, a.name);
  for (const p of pros) add(p.email, p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" "));
  const staffNames = new Map<string, string>();
  for (const p of staff) { const k = String(p.email || "").trim().toLowerCase(); if (k) staffNames.set(k, String(p.full_name || "").trim()); }
  return { names, staff: new Set(staffNames.keys()), staffNames };
}

// email (lowercase) -> "Name · Company" for every hiring contact on a client lead (the lead's contacts,
// its single older contact field, and whoever signed our terms).
async function clientNames(admin: any): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const add = (email: unknown, name: unknown, company: unknown) => {
    const k = String(email || "").trim().toLowerCase();
    if (k && !out.has(k)) out.set(k, [String(name || "").trim(), String(company || "").trim()].filter(Boolean).join(" \u00b7 "));
  };
  for (let from = 0; from < 50000; from += 1000) {
    const { data } = await admin.from("leads").select("company,contact_email,contact_name,data").range(from, from + 999);
    for (const l of data || []) {
      for (const c of Array.isArray(l.data?.contacts) ? l.data.contacts : []) add(c?.email, c?.name, l.company);
      add(l.contact_email, l.contact_name, l.company);
      if (l.data?.signer?.email) add(l.data.signer.email, l.data.signer.name, l.company);
    }
    if (!data || data.length < 1000) break;
  }
  const { data: signed } = await admin.from("client_agreements").select("company,signer_email,signer_name").limit(5000);
  for (const a of signed || []) add(a.signer_email, a.signer_name, a.company);
  return out;
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
    if (!caller?.user) return json({ error: "Your session has ended. Sign in again." }, 401);
    const { data: me } = await admin.from("profiles").select("role,status").eq("id", caller.user.id).single();
    if (!me || me.role !== "admin" || me.status !== "Active") return json({ error: "Only admins can see email tracking." }, 403);

    const key = Deno.env.get("BREVO_API_KEY");
    if (!key) return json({ error: "Email sending isn't set up yet, so there's nothing to track. Add the Brevo key in Supabase settings." }, 400);
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
      const { names, staff, staffNames } = await candidateNames(admin);
      const kind = typeOf(String(meta.subject || ""), "");
      if (SECRET_TYPES.has(kind)) return json({ error: "Welcome and password-reset emails can't be previewed, because they contain a private sign-in link." }, 403);
      if (!staff.has(k) && !names.has(k) && !(await clientNames(admin)).has(k)) return json({ error: "This email wasn't sent to a candidate, a client or a team member, so it can't be previewed here." }, 403);
      const cr = await fetch("https://api.brevo.com/v3/smtp/emails/" + encodeURIComponent(meta.uuid), { headers: h, signal: AbortSignal.timeout(15000) });
      const cj = await cr.json().catch(() => ({}));
      const cn = names.has(k) || staff.has(k) ? null : await clientNames(admin);
      if (!cr.ok || !cj.body) return json({ error: "Brevo no longer has the content of this email (it keeps it for a limited time)." }, 404);
      return json({ ok: true, subject: cj.subject || meta.subject || "", to: meta.email || "", name: staffNames.get(k) || names.get(k) || cn?.get(k) || "", date: cj.date || meta.date || "", html: String(cj.body) });
    }

    const days = [7, 30, 90, 365].includes(Number(body.days)) ? Number(body.days) : 30;

    // "Refresh", or nothing stored yet: catch up with Brevo first (only new events are fetched).
    const { count: have } = await admin.from("email_events").select("id", { count: "exact", head: true }).eq("source", "sync");
    let syncError = "";
    if (body.refresh || !have) { try { await syncFromBrevo(admin, key); } catch (e) { syncError = String((e as Error)?.message || e); if (!have) return json({ error: "We couldn't reach Brevo to load the email log. Try again in a few minutes." }, 502); } }

    // The stored events for the period, oldest first.
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const events: any[] = [];
    for (let from = 0; from < 300000; from += 1000) {
      const { data, error } = await admin.from("email_events").select("message_id,email,event,subject,tag,link,reason,at").gte("at", since).order("at").range(from, from + 999);
      if (error) return json({ error: "We couldn't load the email log. Try again in a minute." }, 500);
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
    const { names, staff, staffNames } = await candidateNames(admin);
    const audience = body.audience === "staff" ? "staff" : body.audience === "clients" ? "clients" : "candidates";
    const clients = audience === "clients" ? await clientNames(admin) : null;
    const rows = [...byId.values()].filter((r) => {
      const k = r.to.trim().toLowerCase();
      const isStaff = staff.has(k) || (STAFF_TYPES.has(r.type) && !names.has(k));
      if (clients) {
        // Client contacts (a pitch to a hiring manager, the signed terms, follow-ups); never a
        // candidate's or a team member's own address, and never the spam-score test.
        if (!clients.has(k) || staff.has(k) || names.has(k) || r.type === "Spam check") return false;
        r.name = clients.get(k) || "";
        return true;
      }
      if (audience === "staff") {
        if (!isStaff) return false;
        r.name = staffNames.get(k) || "";
        (r as any).noPreview = SECRET_TYPES.has(r.type);
        return true;
      }
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
    return json({ ok: true, days, audience, rows: rows.slice(0, 5000), totals, truncated: rows.length > 5000, syncedAt: newest?.created_at || null, ...(syncError ? { warning: "Couldn't reach Brevo just now, so this shows what was already saved. Try Refresh again in a few minutes." } : {}) });
  } catch (e) {
    console.error("email-tracking", String((e as Error)?.message || e));
    return json({ error: "Something went wrong loading the email log. Try again in a minute." }, 500);
  }
});
