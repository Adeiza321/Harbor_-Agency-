import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, emailShell, button, esc, sendBrevo } from "./brand.ts";
import { countryCode, locationCountry } from "../sourcing/regions.ts";
import { regionMatch } from "../sourcing/world_regions.ts";

// Role emails to recruiters, sent by the database (triggers on jobs and job_recruiters) with the
// ops token:
//   { kind: "status", jobId, from, to }  a role went live (Draft/new -> Open): every active
//                                         recruiter hears about the new role (recruiters who
//                                         work best in its region get "a new role in your region"); any other status
//                                         change (On hold, Closed, reopened): every active recruiter
//                                         hears about it too.
//   { kind: "worklist", jobId, recruiterId, actorId }  a role was added to a recruiter's worklist
//                                         (they engaged, or Admin / Rec Ops added them).
//   Activity on a recruiter's own candidates or work, by someone else (or by the system):
//   { kind: "stage", linkId, from, to, actorId }        a candidate moved stage (Placed included)
//   { kind: "response", linkId, actorId }               a candidate accepted / declined a role
//   { kind: "added", linkId, actorId }                  a candidate was put forward / applied to a role
//   { kind: "interview", interviewId, op, actorId }     an interview booked, moved, cancelled or decided
//   { kind: "task", taskId }                            a task given to them by someone else (no email:
//                                                       recruiters' emails are only about their
//                                                       candidates and job status)
//   { kind: "assigned", candidateId, actorId }          a candidate assigned to them
//   { kind: "comment", commentId }                      a teammate's note on their candidate
//   Team activity (Admins and Rec Ops, plus recruiters where it's theirs):
//   { kind: "new_candidate", candidateId, actorId }     a candidate was added (or a draft submitted).
//                                                       Added by a recruiter: Admins and Rec Ops hear.
//                                                       Given to a recruiter by someone else: that
//                                                       recruiter gets "is now your candidate".
//   { kind: "applied", applicationId }                  someone applied directly (apply page, outreach
//                                                       "I'm interested", a job board) or a referral said
//                                                       yes: Admins and Rec Ops (not recruiters: the
//                                                       applicant isn't their candidate until assigned,
//                                                       which sends "is now your candidate").
//   Team wins (no email to recruiters; still shown in ProNext):
//   { kind: "placed", cheerId }   a placement made by someone else
//   { kind: "kudos", kudosId }    a teammate congratulated the recruiter on a placement
// Recruiters' emails are only about their own candidates and the status of jobs.
// Recruiters never see the client fee; their own incentive is shown when the role has one.
// Switches in My profile > Notifications: "Role emails" (roles) and "Activity emails" (the rest).

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const APP_URL = Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com";
const p = (t: string) => `<div style="font-size:15px;line-height:1.6;margin-top:10px;">${t}</div>`;

function money(n: number | null, cur: string) {
  if (n == null) return "";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n); } catch { return `${n} ${cur || ""}`.trim(); }
}
// What the recruiter earns, in money (same sums as the app's recruiterEarning): a percentage fee
// billed once is a share of a year's pay, billed monthly a share of a month's pay (an hourly rate
// counts 40 hours a week); a percentage incentive is a share of that fee.
const PAY_PER_YEAR: Record<string, number> = { Hourly: 2080, Daily: 260, Weekly: 52, Monthly: 12, Yearly: 1 };
function earning(j: any) {
  if (!j.incentive_amount) return "";
  const monthlyBill = j.billing_frequency === "Monthly";
  const pay = (Number(j.max_pay) || Number(j.min_pay) || 0) * (PAY_PER_YEAR[j.salary_period || "Yearly"] || 1) / (monthlyBill ? 12 : 1);
  const flatFee = j.billing_type === "flat";
  const fee = flatFee ? Number(j.billing_amount) || 0 : Math.round(pay * (Number(j.billing_amount) || 0) / 100);
  const pct = j.incentive_type !== "flat";
  const amount = pct ? Math.round(fee * Number(j.incentive_amount) / 100) : Number(j.incentive_amount);
  const cur = pct ? (flatFee ? j.billing_currency : j.currency) || "USD" : j.incentive_currency || j.currency || "USD";
  if (!amount) return pct ? j.incentive_amount + "% of the client fee" : "";
  const monthly = j.incentive_frequency === "Monthly" || (pct && monthlyBill);
  const months = monthly ? (j.incentive_months || j.billing_months || 6) : 0;
  const upTo = pct && !flatFee && j.min_pay && j.max_pay && Number(j.min_pay) < Number(j.max_pay);
  return (upTo ? "up to " : "") + money(amount, cur) + (monthly ? " a month" + (months ? " for " + months + " months" : "") : "");
}
function facts(j: any) {
  const pay = j.min_pay || j.max_pay ? [money(j.min_pay, j.currency), money(j.max_pay, j.currency)].filter(Boolean).join(" – ") + (j.salary_period ? " " + String(j.salary_period).toLowerCase() : "") : "";
  const cut0 = earning(j), cut = cut0 ? cut0.charAt(0).toUpperCase() + cut0.slice(1) : "";
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
    if (!["status", "worklist"].includes(String(body.kind || "status"))) return json(await activity(admin, body));
    const jobId = String(body.jobId || "");
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: "No job" }, 400);
    const { data: j } = await admin.from("jobs").select("id,role_title,client,status,location,country,work_setup,employment_type,min_pay,max_pay,currency,salary_period,incentive_type,incentive_amount,incentive_currency,incentive_frequency,incentive_months,billing_type,billing_amount,billing_currency,billing_frequency,billing_months,headcount,hold_reason").eq("id", jobId).maybeSingle();
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
    const { data: people } = await admin.from("profiles").select("id,email,full_name,status,role,notification_prefs,regions").eq("role", "recruiter").eq("status", "Active");
    // A new role in a region a recruiter works best in (My profile): their own version, first in
    // their inbox with the region named.
    const newRole = to === "Open" && (!from || from === "Draft");
    const code = countryCode(j.country) || locationCountry(j.location);
    let sent = 0, special = 0;
    for (const u of (people || []).filter(wants)) {
      const hit = newRole ? regionMatch(u.regions, code, String(j.country || "")) : "";
      if (hit) {
        const ok = await send(u, "New role in your region (" + hit + "): " + j.role_title + (j.client ? " at " + j.client : ""),
          p(`A new role just opened in <b>${esc(hit)}</b>, one of the regions you work best in: <b>${esc(role)}</b>.`) + facts(j) +
          p("You're hearing about it first because of the regions on your profile. Engage on it to add it to your worklist.") + button(brand, link, "View the role"));
        if (ok) { sent++; special++; }
      } else if (await send(u, subject, inner)) sent++;
    }
    return json({ ok: true, sent, special });
  } catch (e) {
    console.error("role-emails", String((e as Error)?.message || e));
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

// ---------------------------------------------------------------- activity and team wins
const uuid = (v: unknown) => /^[0-9a-f-]{36}$/i.test(String(v || "")) ? String(v) : "";
const NOTE_STAGES = ["Screening", "Submitted", "Interview", "Offer", "Placed", "Rejected", "Withdrawn"];
const PROFILE = "id,email,full_name,status,role,notification_prefs";
const TEAM_FOOT = (name: string) => "You're receiving this because you're an Admin or Rec Ops at " + name + ". Turn activity emails off in ProNext: My profile, Notifications.";

async function activity(admin: any, body: any) {
  const brand = await loadBrand(admin);
  const kind = String(body.kind || "");
  const actorId = uuid(body.actorId);
  const nameOf = async (id: string) => { if (!id) return ""; const { data } = await admin.from("profiles").select("full_name").eq("id", id).maybeSingle(); return data?.full_name || ""; };
  const person = async (id: string) => { if (!id) return null; const { data } = await admin.from("profiles").select(PROFILE).eq("id", id).maybeSingle(); return data; };
  // Recruiters only, never for something they did themselves; "Activity emails" can turn it off.
  const okFor = (u: any) => u?.email && u.status === "Active" && u.role === "recruiter" && u.id !== actorId && (u.notification_prefs || {}).activityEmail !== false;
  const send = async (u: any, subject: string, inner: string, foot?: string) => {
    const first = String(u.full_name || "").split(" ")[0] || "there";
    const html = emailShell(brand, subject, `<div style="font-size:20px;margin-bottom:8px;">Hi ${esc(first)},</div>${inner}`,
      foot || "You're receiving this because it's about your candidates or work in " + brand.name + ". Turn activity emails off in ProNext: My profile, Notifications.");
    return sendBrevo(brand, { email: u.email, name: u.full_name || undefined }, subject, html);
  };
  const candLink = (id: string) => APP_URL + "/?page=candidates&cand=" + id;
  // Admins and Rec Ops who want activity emails.
  const team = async () => {
    const { data } = await admin.from("profiles").select(PROFILE).in("role", ["admin", "recops"]).eq("status", "Active");
    return (data || []).filter((u: any) => u.email && (u.notification_prefs || {}).activityEmail !== false);
  };
  const quote = (t: string) => t ? `<div style="margin-top:14px;padding:14px 16px;background:#F3EFE7;border-radius:10px;font-size:14px;line-height:1.5;">${esc(t.slice(0, 600))}</div>` : "";
  const loadLink = async (id: string) => {
    const { data } = await admin.from("candidate_jobs").select("id,stage,candidate_response,reject_kind,reject_reason,reject_feedback,candidates(id,name,recruiter_id,email,email_opt_out),jobs(id,role_title,client,lead_role)").eq("id", id).maybeSingle();
    return data;
  };
  const roleOf = (j: any) => j ? j.role_title + (j.client ? " at " + j.client : "") : "a role";
  const by = async () => { const n = await nameOf(actorId); return n ? " by " + n : ""; };

  if (kind === "stage" || kind === "response" || kind === "added") {
    const l = await loadLink(uuid(body.linkId)); if (!l) return { ok: true, skipped: "no link" };
    const c: any = l.candidates, j: any = l.jobs;
    // A pitch to a client lead: the candidate is put on the lead's role by the system before the
    // pitch; their recruiter hears about it through the candidate's replies in the chat instead.
    if (kind === "added" && j?.lead_role) return { ok: true, skipped: "client-lead pitch" };
    const u = await person(c?.recruiter_id); if (!okFor(u)) return { ok: true, skipped: "not for them" };
    const who = `<b>${esc(c.name)}</b>`, role = `<b>${esc(roleOf(j))}</b>`;
    if (kind === "stage") {
      const to = String(body.to || l.stage);
      if (!NOTE_STAGES.includes(to)) return { ok: true, skipped: "stage " + to };
      // Routed to another role: the earlier role closes quietly. The recruiter gets the
      // "routed" email for the new role instead of a rejection for the old one.
      if (to === "Rejected" && l.reject_kind === "rerouted") return { ok: true, skipped: "rerouted" };
      if (to === "Placed") {
        return { ok: true, sent: await send(u, "Congratulations! " + c.name + " is placed", `<div style="font-size:30px;text-align:center;margin:6px 0 10px;">&#127881;</div>` +
          p(`${who} has been placed as ${role}. Brilliant work, this one's yours.`) + p("The team has been told, so expect some congratulations.") + button(brand, candLink(c.id), "See the placement")) };
      }
      const extra = to === "Rejected" ? quote([l.reject_kind === "client" ? "Client's reason: " + (l.reject_reason || "") : l.reject_reason ? "Reason: " + l.reject_reason : "", l.reject_feedback || ""].filter(Boolean).join("\n")) : "";
      return { ok: true, sent: await send(u, c.name + ": " + to + " · " + (j?.role_title || ""), p(`${who} moved to <b>${esc(to)}</b> for ${role}${esc(await by())}.`) + extra + button(brand, candLink(c.id), "Open " + String(c.name).split(" ")[0])) };
    }
    if (kind === "response") {
      const r = String(l.candidate_response || "");
      if (!["accepted", "declined"].includes(r)) return { ok: true, skipped: "response " + r };
      return { ok: true, sent: await send(u, c.name + (r === "accepted" ? " accepted " : " declined ") + (j?.role_title || "a role"),
        p(`${who} ${r === "accepted" ? "accepted" : "declined"} ${role}.`) + (r === "accepted" ? p("Their screening starts now; you'll see it on their profile.") : "") + button(brand, candLink(c.id), "Open " + String(c.name).split(" ")[0])) };
    }
    if (l.stage === "Sourced" && l.candidate_response === "pending") {
      // A route: the recruiter is copied on the candidate's own "A new role for you" email
      // (send-message invite), so no separate note, unless the candidate can't be emailed.
      if (c.email && !c.email_opt_out) return { ok: true, skipped: "routed: recruiter is cc'd on the candidate's email" };
      return { ok: true, sent: await send(u, c.name + " was routed to " + (j?.role_title || "a new role"), p(`${who} was routed to ${role}${esc(await by())}.`) + p("They'll see it on their candidate page and can accept it there. Any earlier role they were on has been closed.") + button(brand, candLink(c.id), "Open " + String(c.name).split(" ")[0])) };
    }
    return { ok: true, sent: await send(u, c.name + " is on " + (j?.role_title || "a new role"), p(`${who} is now on ${role}${esc(await by()) || " (they applied)"}.`) + button(brand, candLink(c.id), "Open " + String(c.name).split(" ")[0])) };
  }

  if (kind === "interview") {
    const { data: iv } = await admin.from("interviews").select("id,round,starts_at,status,decision,feedback,scheduler_tz,candidate_id,job_id,candidates(id,name,recruiter_id),jobs(role_title,client)").eq("id", uuid(body.interviewId)).maybeSingle();
    if (!iv) return { ok: true, skipped: "no interview" };
    const c: any = iv.candidates;
    const u = await person(c?.recruiter_id); if (!okFor(u)) return { ok: true, skipped: "not for them" };
    let when = new Date(iv.starts_at).toUTCString();
    try { when = new Intl.DateTimeFormat("en-GB", { timeZone: iv.scheduler_tz || "Africa/Lagos", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(iv.starts_at)); } catch { /* keep UTC */ }
    const op = String(body.op || "");
    const what = op === "insert" ? "booked" : iv.status === "cancelled" ? "cancelled" : iv.decision && op === "decision" ? "decided: " + iv.decision : "moved";
    return { ok: true, sent: await send(u, "Interview " + what.split(":")[0] + ": " + c.name,
      p(`${esc(iv.round || "Interview")} for <b>${esc(c.name)}</b> (${esc(roleOf(iv.jobs))}) was <b>${esc(what)}</b>${esc(await by())}.`) +
      (iv.status !== "cancelled" ? p("When: " + esc(when)) : "") + (op === "decision" && iv.feedback ? quote(iv.feedback) : "") + button(brand, candLink(c.id), "Open " + String(c.name).split(" ")[0])) };
  }

  // Tasks and team wins aren't about the recruiter's candidates or job status: no email (they
  // still show in ProNext).
  if (kind === "task" || kind === "placed" || kind === "kudos") return { ok: true, skipped: "recruiter emails: candidates and job status only" };

  if (kind === "assigned") {
    const { data: c } = await admin.from("candidates").select("id,name,recruiter_id,is_draft").eq("id", uuid(body.candidateId)).maybeSingle();
    if (!c) return { ok: true, skipped: "no candidate" };
    if (c.is_draft) return { ok: true, skipped: "still a draft (they'll hear when it's submitted)" };
    const u = await person(c.recruiter_id); if (!okFor(u)) return { ok: true, skipped: "not for them" };
    return { ok: true, sent: await send(u, c.name + " is now your candidate", p(`<b>${esc(c.name)}</b> has been assigned to you${esc(await by())}.`) + button(brand, candLink(c.id), "Open " + String(c.name).split(" ")[0])) };
  }

  if (kind === "comment") {
    const { data: cm } = await admin.from("candidate_comments").select("id,body,author_id,candidates(id,name,recruiter_id)").eq("id", uuid(body.commentId)).maybeSingle();
    if (!cm) return { ok: true, skipped: "no comment" };
    const c: any = cm.candidates; const u = await person(c?.recruiter_id);
    if (!(u?.email && u.status === "Active" && u.role === "recruiter" && u.id !== cm.author_id && (u.notification_prefs || {}).activityEmail !== false)) return { ok: true, skipped: "not for them" };
    const from = await nameOf(cm.author_id);
    return { ok: true, sent: await send(u, (from || "A teammate") + " left a note on " + c.name, p(`${esc(from || "A teammate")} left a note on <b>${esc(c.name)}</b>:`) + quote(cm.body || "") + button(brand, candLink(c.id), "Open " + String(c.name).split(" ")[0])) };
  }

  if (kind === "new_candidate") {
    const { data: c } = await admin.from("candidates").select("id,name,role_title,location,source,recruiter_id,is_draft").eq("id", uuid(body.candidateId)).maybeSingle();
    if (!c || c.is_draft) return { ok: true, skipped: "no candidate" };
    const actor = await person(actorId);
    const out: any = { ok: true };
    // Given to a recruiter by someone else (or by the Inbox): they hear it's theirs.
    if (c.recruiter_id && c.recruiter_id !== actorId) {
      const u = await person(c.recruiter_id);
      if (okFor(u)) out.assigned = await send(u, c.name + " is now your candidate", p(`<b>${esc(c.name)}</b>${c.role_title ? " (" + esc(c.role_title) + ")" : ""} has been assigned to you${esc(await by())}.`) + button(brand, candLink(c.id), "Open " + String(c.name).split(" ")[0]));
    }
    // Added by a recruiter: Admins and Rec Ops hear about it.
    if (actor?.role === "recruiter") {
      const meta = [c.role_title, c.location].filter(Boolean).join(" · ");
      out.team = 0;
      for (const u of (await team()).filter((u: any) => u.id !== actorId)) {
        if (await send(u, (actor.full_name || "A recruiter") + " added " + c.name,
          p(`<b>${esc(actor.full_name || "A recruiter")}</b> added a new candidate: <b>${esc(c.name)}</b>${meta ? " (" + esc(meta) + ")" : ""}.`) +
          button(brand, candLink(c.id), "Open " + String(c.name).split(" ")[0]), TEAM_FOOT(brand.name))) out.team++;
      }
    }
    return out;
  }

  if (kind === "applied") {
    const { data: a } = await admin.from("applications").select("id,name,role_title,source,job_id,status,referrer,interest_at,jobs(id,role_title,client)").eq("id", uuid(body.applicationId)).maybeSingle();
    if (!a || a.status === "dismissed") return { ok: true, skipped: "no application" };
    if (a.source === "referral" && !a.interest_at) return { ok: true, skipped: "referral not interested yet" };
    const j: any = a.jobs;
    const how = a.source === "referral" ? "was referred" + (a.referrer?.name ? " by " + String(a.referrer.name) : "") + " and is interested in"
      : a.source === "outreach" ? "replied to our outreach and applied for" : "applied for";
    const what = j ? `<b>${esc(roleOf(j))}</b>` : a.role_title ? `<b>${esc(a.role_title)}</b>` : "a role (no specific job)";
    const subject = "New application: " + a.name + (j?.role_title ? " · " + j.role_title : "");
    const SRC: Record<string, string> = { linkedin: "LinkedIn", facebook: "Facebook", whatsapp: "WhatsApp", x: "X (Twitter)", telegram: "Telegram", email: "a job shared by email", instagram: "Instagram", indeed: "Indeed", google_jobs: "Google for Jobs", manual: "added by hand" };
    const src = a.source && !["career_page", "outreach", "referral"].includes(a.source) ? p("Came from: " + esc(SRC[a.source] || a.source)) : "";
    let sent = 0;
    // Admins and Rec Ops: it's waiting in the Inbox to be assigned. Recruiters aren't emailed: the
    // applicant isn't their candidate yet (they hear "is now your candidate" once assigned).
    for (const u of await team()) {
      if (await send(u, subject, p(`<b>${esc(a.name)}</b> ${esc(how)} ${what}.`) + src + p("It's in the Inbox, waiting to be assigned.") + button(brand, APP_URL + "/?page=inbox", "Open the Inbox"), TEAM_FOOT(brand.name))) sent++;
    }
    return { ok: true, sent };
  }
  return { ok: true, skipped: "unknown kind" };
}
