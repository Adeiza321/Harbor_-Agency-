import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, emailShell, button, esc, sendBrevo } from "./brand.ts";

// Emails a staff member when a candidate replies in their chat, so a reply isn't missed while
// they're away from ProNext. Called by the database (trigger candidate_job_messages_notify) with
// the ops token: POST { messageId }.
// Skipped when: the person turned "Email me when a candidate replies" off, their account isn't
// active, or the candidate already wrote in the same chat in the last 10 minutes (one email per
// burst of messages, not one per line).

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const APP_URL = Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: true });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const opsKey = req.headers.get("x-harbor-ops") || "";
    const { data: tok } = opsKey.length >= 32 ? await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle() : { data: null };
    if (!tok) return json({ error: "Invalid ops token" }, 403);

    const body = await req.json().catch(() => ({}));
    const id = String(body.messageId || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "No message" }, 400);
    const { data: m } = await admin.from("candidate_job_messages").select("id,link_id,staff_id,sender,body,attachment_name,created_at").eq("id", id).maybeSingle();
    if (!m || m.sender !== "candidate" || !m.staff_id) return json({ ok: true, skipped: "not a candidate reply" });

    const since = new Date(new Date(m.created_at).getTime() - 10 * 60000).toISOString();
    const { data: recent } = await admin.from("candidate_job_messages").select("id").eq("link_id", m.link_id).eq("staff_id", m.staff_id)
      .eq("sender", "candidate").neq("id", m.id).gte("created_at", since).lt("created_at", m.created_at).limit(1);
    if (recent && recent.length) return json({ ok: true, skipped: "already emailed for this burst" });

    const { data: staff } = await admin.from("profiles").select("email,full_name,status,notification_prefs").eq("id", m.staff_id).maybeSingle();
    if (!staff?.email || staff.status !== "Active") return json({ ok: true, skipped: "no active staff email" });
    if ((staff.notification_prefs || {}).msgEmail === false) return json({ ok: true, skipped: "turned off" });

    const { data: link } = await admin.from("candidate_jobs").select("candidates(name),jobs(role_title,client)").eq("id", m.link_id).maybeSingle();
    const cand = String((link as any)?.candidates?.name || "A candidate");
    const job = (link as any)?.jobs;
    const role = job ? job.role_title + (job.client ? " at " + job.client : "") : "a role";
    const text = String(m.body || "").trim();
    const preview = text.length > 220 ? text.slice(0, 220) + "…" : text;

    const brand = await loadBrand(admin);
    const subject = cand + " replied about " + (job?.role_title || "a role");
    const first = String(staff.full_name || "").split(" ")[0] || "there";
    const html = emailShell(brand, subject,
      `<div style="font-size:20px;margin-bottom:8px;">Hi ${esc(first)},</div>
       <div style="font-size:15px;line-height:1.6;"><b>${esc(cand)}</b> sent you a message about <b>${esc(role)}</b>:</div>
       ${preview ? `<div style="margin-top:14px;padding:14px 16px;background:#F3EFE7;border-radius:10px;font-size:14px;font-style:italic;line-height:1.5;">&ldquo;${esc(preview)}&rdquo;</div>` : ""}
       ${m.attachment_name ? `<div style="margin-top:10px;font-size:14px;">${/^Voice message\b/.test(m.attachment_name) ? "&#127908; " + esc(m.attachment_name.replace(/\.[a-z0-9]+$/i, "")) : "&#128206; " + esc(m.attachment_name)}</div>` : ""}
       ${button(brand, APP_URL + "/?page=messages", "Reply in ProNext")}
       <div style="font-size:12px;color:#8A8578;margin-top:18px;">You can turn these emails off in ProNext: My profile, Notifications.</div>`,
      "You're receiving this because a candidate replied to you in " + brand.name + ".");
    const sent = await sendBrevo(brand, { email: staff.email, name: staff.full_name || undefined }, subject, html);
    return json({ ok: true, sent });
  } catch (e) {
    console.error("notify-staff", String((e as Error)?.message || e));
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
