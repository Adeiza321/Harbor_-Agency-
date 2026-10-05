// Spend approvals. Anything that uses paid credits (Apollo, TheirStack) waits here until an
// Admin approves it in Harbor (Outreach > Approvals). Admins get an email when one comes in.
//   apollo_search  outside search for one job: Apollo reveals up to prospectsPerJob emails
//   leads_fetch    the client-lead feed: up to postingsPerDay TheirStack postings, plus up to
//                  the same number of Apollo lookups for hiring contacts' emails

import type { Settings } from "./common.ts";

export type Kind = "apollo_search" | "leads_fetch";

const esc = (x: unknown) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c] || c);

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
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#FAF8F3;font-family:Arial,sans-serif;color:#1A1A1A;">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E7E2D6;border-radius:16px;padding:28px;">
<div style="font-family:Georgia,serif;font-size:20px;margin-bottom:10px;">Harbor needs your approval</div>
<div style="font-size:15px;line-height:1.6;">${esc(req.title)}</div>
<div style="font-size:14px;line-height:1.6;color:#56605A;margin-top:8px;">Cost: ${esc(req.cost_text)}. Nothing is spent until you approve.</div>
<a href="${esc(link)}" style="display:inline-block;margin-top:18px;padding:12px 22px;background:#1F6F54;color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600;">Review in Harbor</a>
</div></body></html>`;
  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json", "api-key": key },
    body: JSON.stringify({ sender: { email: from, name: Deno.env.get("BREVO_SENDER_NAME") || "Harbor" }, to, subject: "Approval needed: " + req.title, htmlContent: html }),
  }).catch((e) => console.error("approval email", String(e)));
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
