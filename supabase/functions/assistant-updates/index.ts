import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, emailShell, button, esc, sendBrevo } from "./brand.ts";

// Emails people the assistant updates they haven't seen in ProNext (public.assistant_updates), so
// nothing is missed while they're away. Called by the database every 5 minutes (cron
// "harbor-assistant-update-emails") with the ops token: POST { action: "email" }.
//   - Waits a few minutes first (someone in ProNext sees the update and it's never emailed);
//     interview reminders go after 1 minute, the round-up and everything else after 5.
//   - One email per person per run, listing everything waiting (newest first, up to 12).
//   - Skips updates another email already covered (email_ok = false), people who turned
//     "Email me updates I haven't seen" off (assistEmail), and inactive accounts.
//   - Updates older than 36 hours are never emailed.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const APP_URL = Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com";

// Where an update's button goes in ProNext.
function linkFor(l: any): string {
  const q = new URLSearchParams();
  if (l?.threadId) q.set("assistant", String(l.threadId));
  else if (l?.page === "jobDetail" && l.jobId) { q.set("page", "jobDetail"); q.set("job", String(l.jobId)); }
  else if (l?.page === "candidates" && l.candidateId) { q.set("page", "candidates"); q.set("cand", String(l.candidateId)); }
  else if (l?.page) q.set("page", String(l.page));
  const s = q.toString();
  return APP_URL + "/" + (s ? "?" + s : "");
}
// Recruiters are only emailed about their own candidates (stage changes, replies, interviews,
// a candidate given to them, a candidate confirming details for a client role). Tasks, the daily
// to-do reminder, the end-of-day round-up, finished searches and new Inbox interest stay in ProNext.
// (Job status emails come from role-emails.)
const RECRUITER_PAGES = new Set(["candidates", "messages", "campaigns"]);
const recruiterEmailOk = (r: any) => (r.kind === "event" || r.kind === "reminder") && RECRUITER_PAGES.has(String(r.link?.page || ""));
const ICON: Record<string, string> ={ event: "&#128276;", job: "&#9989;", reminder: "&#9200;", roundup: "&#127751;" };
const para = (t: string) => esc(t).replace(/\n/g, "<br>");

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: true });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const opsKey = req.headers.get("x-harbor-ops") || "";
    const { data: tok } = opsKey.length >= 32 ? await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle() : { data: null };
    if (!tok) return json({ error: "Invalid ops token" }, 403);
    const body = await req.json().catch(() => ({}));
    if (body.action !== "email") return json({ error: "Unknown action" }, 400);

    const now = Date.now();
    const { data: rows, error } = await admin.from("assistant_updates").select("id,user_id,kind,title,body,link,created_at")
      .is("seen_at", null).is("emailed_at", null).eq("email_ok", true)
      .gt("created_at", new Date(now - 36 * 3600e3).toISOString()).lt("created_at", new Date(now - 60e3).toISOString())
      .order("created_at", { ascending: false }).limit(500);
    if (error) return json({ error: error.message }, 500);
    // Give people a few minutes to see it in ProNext first; reminders can't wait that long.
    const due = (rows || []).filter((r: any) => r.kind === "reminder" || now - new Date(r.created_at).getTime() >= 5 * 60e3);
    const byUser = new Map<string, any[]>();
    for (const r of due) { const l = byUser.get(r.user_id) || []; l.push(r); byUser.set(r.user_id, l); }
    if (!byUser.size) return json({ ok: true, sent: 0 });

    const { data: people } = await admin.from("profiles").select("id,email,full_name,status,role,notification_prefs").in("id", [...byUser.keys()]);
    const brand = await loadBrand(admin);
    let sent = 0, skipped = 0;
    for (const u of people || []) {
      if (u.role === "recruiter") {
        // Not about their candidates: never emailed (still shown in ProNext), and not tried again.
        const all = byUser.get(u.id) || [];
        const no = all.filter((r: any) => !recruiterEmailOk(r)).map((r: any) => r.id);
        if (no.length) { await admin.from("assistant_updates").update({ email_ok: false }).in("id", no); skipped += no.length; }
        byUser.set(u.id, all.filter(recruiterEmailOk));
        if (!byUser.get(u.id)!.length) continue;
      }
      const list = (byUser.get(u.id) || []).slice(0, 12);
      const ids = (byUser.get(u.id) || []).map((r: any) => r.id);
      const off = !u.email || u.status !== "Active" || (u.notification_prefs || {}).assistEmail === false;
      if (off) {
        // Not emailed, and not tried again.
        await admin.from("assistant_updates").update({ email_ok: false }).in("id", ids);
        skipped += ids.length; continue;
      }
      // Claim them first so two runs never send the same update twice.
      const { data: claimed } = await admin.from("assistant_updates").update({ emailed_at: new Date().toISOString() }).in("id", ids).is("emailed_at", null).is("seen_at", null).select("id");
      const got = new Set((claimed || []).map((r: any) => r.id));
      const items = list.filter((r: any) => got.has(r.id));
      if (!items.length) continue;
      const first = String(u.full_name || "").split(" ")[0] || "there";
      const one = items.length === 1;
      const subject = one ? items[0].title : items.length + " updates from your ProNext assistant";
      const cards = items.map((r: any) => `
        <div style="margin-top:14px;padding:14px 16px;background:#F3EFE7;border-radius:10px;">
          <div style="font-size:15px;font-weight:bold;line-height:1.4;">${ICON[r.kind] || ""} ${esc(r.title)}</div>
          ${r.body ? `<div style="font-size:14px;line-height:1.55;margin-top:6px;">${para(r.kind === "roundup" ? r.body : String(r.body).slice(0, 500))}</div>` : ""}
          <div style="margin-top:8px;"><a href="${esc(linkFor(r.link))}" style="font-family:Arial,sans-serif;font-size:13px;font-weight:600;color:${brand.color};">Open in ProNext &rarr;</a></div>
        </div>`).join("");
      const more = (byUser.get(u.id) || []).length - items.length;
      const html = emailShell(brand, subject,
        `<div style="font-size:20px;margin-bottom:8px;">Hi ${esc(first)},</div>
         <div style="font-size:15px;line-height:1.6;">${one ? "Here's something you haven't seen in ProNext yet:" : "Here's what happened while you were away from ProNext:"}</div>
         ${cards}
         ${more > 0 ? `<div style="font-size:13px;color:#56605A;margin-top:12px;">…and ${more} more in ProNext.</div>` : ""}
         ${button(brand, APP_URL + "/", "Open ProNext")}
         <div style="font-size:12px;color:#8A8578;margin-top:18px;">Updates you see in ProNext aren't emailed. Change this in ProNext: My profile, Notifications.</div>`,
        "You're receiving this because you work with " + brand.name + " in ProNext.");
      const ok = await sendBrevo(brand, { email: u.email, name: u.full_name || undefined }, subject, html);
      if (ok) sent++;
      else await admin.from("assistant_updates").update({ emailed_at: null }).in("id", [...got]); // try again next run
    }
    return json({ ok: true, sent, skipped });
  } catch (e) {
    console.error("assistant-updates", String((e as Error)?.message || e));
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
