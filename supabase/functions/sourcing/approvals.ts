// Spend approvals. Anything that uses paid credits (Apollo, TheirStack) waits here until an
// Admin approves it in Pronext (Outreach > Approvals). Admins get an email when one comes in.
//   apollo_search  outside search for one job: Apollo reveals up to prospectsPerJob emails
//   leads_fetch    the client-lead feed: up to postingsPerDay TheirStack postings, plus up to
//                  the same number of Apollo lookups for hiring contacts' emails

import type { Settings } from "./common.ts";

export type Kind = "apollo_search" | "leads_fetch";

import { button, emailShell, esc, loadBrand, sendBrevo } from "./brand.ts";

export function estimate(kind: Kind, s: Settings) {
  if (kind === "apollo_search") return { apollo: s.prospectsPerJob, theirstack: 0 };
  return { apollo: s.leads.postingsPerDay, theirstack: s.leads.postingsPerDay };
}
export const costText = (e: { apollo: number; theirstack: number }) =>
  [e.theirstack ? `up to ${e.theirstack} TheirStack credits` : "", e.apollo ? `up to ${e.apollo} Apollo credits` : ""].filter(Boolean).join(" and ");

async function alertAdmins(admin: any, req: any) {
  const key = Deno.env.get("BREVO_API_KEY"), from = Deno.env.get("BREVO_SENDER_EMAIL");
  if (!key || !from) return;
  const { data: admins } = await admin.from("profiles").select("email,full_name").eq("role", "admin").eq("status", "Active");
  const to = (admins || []).filter((a: any) => a.email).map((a: any) => ({ email: a.email, name: a.full_name || undefined }));
  if (!to.length) return;
  const link = (Deno.env.get("PORTAL_BASE_URL") || "https://harbor.link") + "/?page=campaigns&tab=approvals";
  const b = await loadBrand(admin);
  const html = emailShell(b, "Approval needed: " + req.title,
    `<div style="font-size:20px;margin-bottom:10px;">Your approval is needed</div>
<div style="font-size:15px;line-height:1.6;">${esc(req.title)}</div>
<div style="font-size:14px;line-height:1.6;color:#56605A;margin-top:8px;">Cost: ${esc(req.cost_text)}. Nothing is spent until you approve.</div>
${button(b, link, "Review in Pronext")}`, b.name + " · spending approvals");
  for (const t of to) await sendBrevo(b, t, "Approval needed: " + req.title, html);
}

// One open request per job (or one feed request) at a time.
export async function requestSpend(admin: any, kind: Kind, s: Settings, o: { jobId?: string | null; title: string; requestedBy?: string | null; payload?: Record<string, unknown> }) {
  let q = admin.from("spend_requests").select("*").eq("kind", kind).eq("status", "pending");
  q = o.jobId ? q.eq("job_id", o.jobId) : q.is("job_id", null);
  const { data: open } = await q.limit(1).maybeSingle();
  if (open) return { request: open, created: false };
  const est = estimate(kind, s);
  const { data: req, error } = await admin.from("spend_requests").insert({
    kind, job_id: o.jobId || null, title: o.title, est_apollo: est.apollo, est_theirstack: est.theirstack, cost_text: costText(est),
    payload: o.payload || {}, requested_by: o.requestedBy || null,
  }).select().single();
  if (error) throw new Error(error.message);
  await alertAdmins(admin, req);
  return { request: req, created: true };
}
