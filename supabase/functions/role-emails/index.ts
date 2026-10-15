import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, emailShell, button, esc, sendBrevo } from "./brand.ts";

// Role emails to recruiters, sent by the database (triggers on jobs and job_recruiters) with the
// ops token:
//   { kind: "status", jobId, from, to }  a role went live (Draft/new -> Open): every active
//                                         recruiter hears about the new role; any other status
//                                         change (On hold, Closed, reopened): every active recruiter
//                                         hears about it too.
//   { kind: "worklist", jobId, recruiterId, actorId }  a role was added to a recruiter's worklist
//                                         (they engaged, or Admin / Rec Ops added them).
// Recruiters never see the client fee; their own incentive is shown when the role has one.
// Anyone can turn these off in My profile > Notifications ("Role emails").

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const APP_URL = Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com";
const p = (t: string) => `<div style="font-size:15px;line-height:1.6;margin-top:10px;">${t}</div>`;

function money(n: number | null, cur: string) {
  if (n == null) return "";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n); } catch { return `${n} ${cur || ""}`.trim(); }
}
function facts(j: any) {
  const pay = j.min_pay || j.max_pay ? [money(j.min_pay, j.currency), money(j.max_pay, j.currency)].filter(Boolean).join(" – ") + (j.salary_period ? " " + String(j.salary_period).toLowerCase() : "") : "";
  const cut = j.incentive_amount ? (j.incentive_type === "percent" ? j.incentive_amount + "%" : money(j.incentive_amount, j.incentive_currency || j.currency)) : "";
  const rows = [
    ["Location", [j.location, j.work_setup].filter(Boolean).join(" · ")],
    ["Type", j.employment_type || ""],
    ["Pay", pay],
    ["Your incentive", cut],
    ["Openings", j.headcount && j.headcount > 1 ? String(j.headcount) : ""],
  ].filter((r) => r[1]);
  if (!rows.length) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px;width:100%;background:#F3EFE7;border-radius:10px;">${rows.map((r) => `<tr><td style="padding:8px 14px;font-size:13px;color:#56605A;font-family:Arial,sans-serif;width:120px;">${esc(r[0])}</td><td style="padding:8px 14px;font-size:14px;">${esc(r[1])}</td></tr>`).join("")}</table>`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: true });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const opsKey = req.headers.get("x-harbor-ops") || "";
    const { data: tok } = opsKey.length >= 32 ? await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle() : { data: null };
    if (!tok) return json({ error: "Invalid ops token" }, 403);
    const body = await req.json().catch(() => ({}));
    const jobId = String(body.jobId || "");
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: "No job" }, 400);
    const { data: j } = await admin.from("jobs").select("id,role_title,client,status,location,work_setup,employment_type,min_pay,max_pay,currency,salary_period,incentive_type,incentive_amount,incentive_currency,headcount,hold_reason").eq("id", jobId).maybeSingle();
    if (!j) return json({ ok: true, skipped: "job not found" });
    const brand = await loadBrand(admin);
    const role = j.role_title + (j.client ? " at " + j.client : "");
    const link = APP_URL + "/?page=jobDetail&job=" + j.id;
    const foot = "You're receiving this because you're a recruiter with " + brand.name + ". Turn role emails off in ProNext: My profile, Notifications.";
    const wants = (u: any) => u?.email && u.status === "Active" && (u.notification_prefs || {}).roleEmail !== false;
    const send = async (u: any, subject: string, inner: string) => {
      const first = String(u.full_name || "").split(" ")[0] || "there";
      const html = emailShell(brand, subject, `<div style="font-size:20px;margin-bottom:8px;">Hi ${esc(first)},</div>${inner}`, foot);
      return sendBrevo(brand, { email: u.email, name: u.full_name || undefined }, subject, html);
    };

    if (body.kind === "worklist") {
      const rid = String(body.recruiterId || "");
      const { data: u } = await admin.from("profiles").select("id,email,full_name,status,role,notification_prefs").eq("id", rid).maybeSingle();
      if (!wants(u)) return json({ ok: true, skipped: "no email or turned off" });
      let by = "";
      if (body.actorId && body.actorId !== rid) { const { data: a } = await admin.from("profiles").select("full_name").eq("id", String(body.actorId)).maybeSingle(); by = a?.full_name || ""; }
      const subject = "Added to your worklist: " + j.role_title;
      const sent = await send(u, subject,
        p(`<b>${esc(role)}</b> is now on your worklist${by ? ` (added by ${esc(by)})` : ""}. You can now submit candidates for it.`) + facts(j) +
        button(brand, link, "Open the role"));
      return json({ ok: true, sent: sent ? 1 : 0 });
    }

    // Status changes: to every active recruiter.
    const from = String(body.from || ""), to = String(body.to || j.status || "");
    if (to === "Draft") return json({ ok: true, skipped: "draft" });
    let subject = "", inner = "";
    if (to === "Open" && (!from || from === "Draft")) {
      subject = "New role: " + j.role_title + (j.client ? " at " + j.client : "");
      inner = p(`A new role is open: <b>${esc(role)}</b>.`) + facts(j) + p("Engage on it to add it to your worklist; you can submit candidates once it's there.") + button(brand, link, "View the role");
    } else if (to === "Open") {
      subject = "Back open: " + j.role_title;
      inner = p(`<b>${esc(role)}</b> is open again and taking candidates.`) + facts(j) + button(brand, link, "View the role");
    } else if (to === "On hold") {
      subject = "On hold: " + j.role_title;
      inner = p(`<b>${esc(role)}</b> is on hold${j.hold_reason ? ": " + esc(j.hold_reason) : ""}. Don't submit new candidates for now; we'll let you know when it reopens.`) + button(brand, link, "View the role");
    } else if (to === "Closed") {
      subject = "Closed: " + j.role_title;
      inner = p(`<b>${esc(role)}</b> is closed and no longer taking candidates. Thank you to everyone who worked on it.`);
    } else return json({ ok: true, skipped: "status " + to });
    const { data: people } = await admin.from("profiles").select("id,email,full_name,status,role,notification_prefs").eq("role", "recruiter").eq("status", "Active");
    let sent = 0;
    for (const u of (people || []).filter(wants)) if (await send(u, subject, inner)) sent++;
    return json({ ok: true, sent });
  } catch (e) {
    console.error("role-emails", String((e as Error)?.message || e));
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
