import { createClient } from "npm:@supabase/supabase-js@2";

// Admin-only: every email the app sent to a CANDIDATE through Brevo in the last 7 or 30 days, one row
// per email, with the candidate's name, whether it was delivered, opened and clicked (or bounced /
// blocked / marked as spam). Emails to staff (welcome, password reset, approvals, tests) are left out.
// A recipient counts as a candidate when their address is on a candidate, an application/referral or
// a sourced prospect, and isn't a staff account.
// Read live from Brevo's event log (GET /v3/smtp/statistics/events); nothing is stored here.
//   POST { days: 7 | 30 }                       ->  { rows, totals, days, truncated }
//   POST { action: "preview", messageId }       ->  { subject, to, date, html }  (the email as sent;
//        only for candidate recipients, so staff emails with reset codes or setup links never show)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
  hardBounces: "Bounced: the address doesn't exist or refused it", hard_bounce: "Bounced: the address doesn't exist or refused it",
  softBounces: "Soft bounce: inbox full or unavailable", soft_bounce: "Soft bounce: inbox full or unavailable",
  blocked: "Blocked by Brevo (address previously bounced or unsubscribed)", invalid: "Invalid email address", invalid_email: "Invalid email address",
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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

    const days = Number(body.days) === 7 ? 7 : 30;

    // Page through the event log, newest first. Capped so one page load stays quick.
    const LIMIT = 2500, MAX_PAGES = 8;
    const events: any[] = [];
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `https://api.brevo.com/v3/smtp/statistics/events?limit=${LIMIT}&offset=${page * LIMIT}&days=${days}&sort=desc`;
      const r = await fetch(url, { headers: { "api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        if (page === 0) return json({ error: "Brevo didn't return the email log (" + r.status + "). " + t.slice(0, 200) }, 502);
        break;
      }
      const j = await r.json().catch(() => ({}));
      const list = Array.isArray(j.events) ? j.events : [];
      events.push(...list);
      if (list.length < LIMIT) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }

    const byId = new Map<string, Row>();
    for (const e of events) {
      const id = String(e.messageId || "") || `nomsg|${e.email}|${e.subject}|${String(e.date || "").slice(0, 16)}`;
      const at = String(e.date || "");
      let row = byId.get(id);
      if (!row) {
        row = { id, to: String(e.email || ""), subject: String(e.subject || ""), type: typeOf(String(e.subject || ""), String(e.tag || "")), sentAt: null,
          deliveredAt: null, openedAt: null, opens: 0, proxyOnly: true, clickedAt: null, clicks: 0, links: [], problem: null, spam: false, unsubscribed: false, lastAt: at };
        byId.set(id, row);
      }
      if (at > row.lastAt) row.lastAt = at;
      const earliest = (cur: string | null) => (!cur || at < cur ? at : cur);
      switch (String(e.event || "")) {
        case "requests": case "request": case "sent": row.sentAt = earliest(row.sentAt); break;
        case "delivered": row.deliveredAt = earliest(row.deliveredAt); break;
        case "opened": case "unique_opened": case "uniqueOpened": row.opens++; row.proxyOnly = false; row.openedAt = earliest(row.openedAt); break;
        case "loadedByProxy": row.opens++; row.openedAt = earliest(row.openedAt); break;
        case "clicks": case "click": row.clicks++; row.clickedAt = earliest(row.clickedAt); if (e.link && !row.links.includes(e.link) && row.links.length < 5) row.links.push(String(e.link)); break;
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
    return json({ ok: true, days, rows: rows.slice(0, 3000), totals, truncated });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
