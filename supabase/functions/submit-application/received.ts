// The email every applicant gets the moment they apply (not referrals: they get the referral email).
// It says what happens next and, once they're on file (a recruiter's link assigns them straight away,
// or they applied before), links to their candidate page to see their full profile.
import { button, emailShell, esc, sendBrevo, type Brand } from "./brand.ts";
import { PORTAL_BASE } from "./referral.ts";

export function receivedEmail(b: Brand, o: { name: string; role: string | null; recruiter: string | null; portalToken: string | null }) {
  const first = esc(String(o.name || "there").split(" ")[0] || "there");
  const activeFile = !o.role || o.role === "Active file";
  const subject = activeFile ? "We've received your CV" : `We've received your application for ${o.role}`;
  const portal = o.portalToken ? `${PORTAL_BASE()}/?c=${encodeURIComponent(o.portalToken)}` : "";
  const next = o.recruiter
    ? `<b>${esc(o.recruiter)}</b> is your recruiter and is reviewing ${activeFile ? "your CV" : "your application"} now. You'll hear from them within a few working days.`
    : activeFile
      ? "We keep your CV on file and get in touch as soon as a role matches what you're looking for."
      : o.portalToken
        ? "Our team is reviewing your application now. You'll hear from us within a few working days, whatever the outcome."
        : "Our team reviews every application. You'll hear from us within a few working days, whatever the outcome.";
  const html = emailShell(b, subject,
    `<div style="font-size:20px;margin-bottom:8px;">Hi ${first},</div>
     <div style="font-size:15px;line-height:1.6;">Thanks for ${activeFile ? `sending your CV to ${esc(b.name)}` : `applying for the <b>${esc(o.role)}</b> role`}. We've got it.</div>
     <div style="font-size:15px;line-height:1.6;margin-top:12px;">${next}</div>
     ${portal
       ? `<div style="font-size:15px;line-height:1.6;margin-top:12px;">Your candidate page shows your full profile: your details, what you're looking for, the roles you're on and where each one stands${o.recruiter ? ", and you can message your recruiter there" : ""}.</div>${button(b, portal, "View your full profile")}`
       : `<div style="font-size:15px;line-height:1.6;margin-top:12px;">Once a recruiter picks up your application, we'll email you a link to your candidate page, where you can see your full profile and where each role stands.</div>`}
     <div style="font-size:13px;line-height:1.6;margin-top:16px;color:#56605A;">We never share your contact details with an employer without asking you first.</div>`,
    undefined, portal ? portal + "&unsub=1" : undefined);
  return { subject, html };
}

export async function sendReceived(admin: any, b: Brand, o: { email: string; name: string; role: string | null; candidateId: string | null }) {
  let portalToken: string | null = null, recruiter: string | null = null;
  // The candidate on file: this application's (assigned through a recruiter's link) or the one with
  // the same email from before. Someone who unsubscribed from emails isn't emailed.
  let cand: any = null;
  if (o.candidateId) ({ data: cand } = await admin.from("candidates").select("id,portal_token,recruiter_id,email_opt_out").eq("id", o.candidateId).maybeSingle());
  if (!cand) {
    const { data: same } = await admin.from("candidates").select("id,portal_token,recruiter_id,email_opt_out,email").eq("is_draft", false).ilike("email", o.email.replace(/[\\%_]/g, (c) => "\\" + c)).limit(1);
    cand = (same || [])[0] || null;
  }
  if (cand?.email_opt_out) return { sent: false, skipped: "unsubscribed" };
  if (cand) {
    portalToken = cand.portal_token || null;
    if (cand.recruiter_id && o.candidateId) {
      const { data: r } = await admin.from("profiles").select("full_name,role").eq("id", cand.recruiter_id).maybeSingle();
      // Assigned to an admin (no recruiter's link): "our team", not the admin's name.
      recruiter = r?.role === "admin" ? null : String(r?.full_name || "").trim() || null;
    }
  }
  const m = receivedEmail(b, { name: o.name, role: o.role, recruiter, portalToken });
  return { sent: await sendBrevo(b, { email: o.email, name: o.name }, m.subject, m.html) };
}
