// The email to someone a friend referred (sent when the referral comes in, and again as a
// follow-up from the Inbox). "I'm interested" opens the job page, which records their interest;
// until then the referral can only be viewed, not assigned. Same file in submit-application
// and inbox.
import { button, emailShell, esc, type Brand } from "./brand.ts";

export const PORTAL_BASE = () => (Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com").replace(/\/+$/, "");
// A job's address carries its title, then its code (/jobs/human-resources-manager-06df8c69/); older
// /jobs/<code>/ links still work. Keep this the same as jobPath in app.jsx.
export const jobPath = (slug: string, title?: string | null) => {
  let t = String(title || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (t.length > 60) t = t.slice(0, 60).replace(/-[^-]*$/, "");
  return t ? t + "-" + slug : String(slug || "");
};
export const newReferralToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");

export function referralEmail(b: Brand, o: { name: string; referrer: string; role: string; slug: string | null; token: string; followup?: boolean }) {
  const agency = b.legal || b.name;
  const page = o.slug ? `${PORTAL_BASE()}/jobs/${encodeURIComponent(jobPath(o.slug, o.role))}/` : `${PORTAL_BASE()}/jobs/`;
  const t = encodeURIComponent(o.token);
  const first = esc(o.name.split(" ")[0] || "there");
  const rFirst = o.referrer.split(" ")[0] || o.referrer;
  const subject = o.followup ? `Following up: ${rFirst} referred you for a ${o.role} role` : `${rFirst} referred you for a ${o.role} role`;
  const lead = o.followup
    ? `Just following up: <b>${esc(o.referrer)}</b> referred you to ${esc(agency)} for the <b>${esc(o.role)}</b> role we're recruiting for, and we'd love to know if it interests you.`
    : `<b>${esc(o.referrer)}</b> thinks you'd be a great fit for the <b>${esc(o.role)}</b> role we're recruiting for, and referred you to ${esc(agency)}.`;
  const html = emailShell(b, subject,
    `<div style="font-size:20px;margin-bottom:8px;">Hi ${first},</div>
     <div style="font-size:15px;line-height:1.6;">${lead}</div>
     <div style="font-size:15px;line-height:1.6;margin-top:12px;">Have a look at the job description. If it interests you, click <b>I'm interested</b> and a recruiter will be in touch. We won't share your details with anyone until you do.</div>
     ${button(b, `${page}?rt=${t}&interested=1`, "I'm interested")}
     <div style="font-size:14px;line-height:1.6;margin-top:16px;color:#56605A;"><a href="${esc(page)}?rt=${t}" style="color:${b.color};">Review the job description</a> first. Not interested? No problem, you don't need to do anything.</div>`,
    `You're receiving this email because ${o.referrer} referred you to ${agency}. We won't email you about it again unless you reply or say you're interested.`);
  return { subject, html };
}
