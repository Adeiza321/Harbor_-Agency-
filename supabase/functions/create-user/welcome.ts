// The welcome email a new team member gets when an admin activates their account: who added
// them and as what, a one-time "Set your password" link (no password is ever put in an email),
// where to sign in, and a few first steps for their role.
import { button, emailShell, esc, type Brand } from "./brand.ts";

export const ROLE_LABEL: Record<string, string> = { admin: "Admin", recops: "Rec Ops manager", recruiter: "Recruiter" };

const STEPS: Record<string, string[]> = {
  recruiter: [
    "Add your photo and job title under <b>My profile</b>, so candidates know who they're talking to.",
    "Open <b>Jobs</b> and click <b>Engage</b> on the roles you're working on.",
    "Check <b>Candidates</b> and your <b>Inbox</b> for people assigned to you.",
    "Message candidates from their profile. They reply from their own candidate page.",
  ],
  recops: [
    "Add your photo and job title under <b>My profile</b>.",
    "Review new applications and referrals in the <b>Inbox</b> and assign them to recruiters.",
    "Check <b>Jobs</b> for roles that still need candidates, and approve outreach under <b>Outreach</b>.",
  ],
  admin: [
    "Add your photo and job title under <b>My profile</b>.",
    "Add the rest of your team under <b>Users &amp; permissions</b>.",
    "Check your logo, company details and email footer under <b>Agency settings</b>.",
  ],
};

export function welcomeEmail(b: Brand, o: { name: string; email: string; role: string; inviter: string; setupUrl: string; signInUrl: string; hours: number }) {
  const first = (o.name || "").trim().split(/\s+/)[0] || "there";
  const role = ROLE_LABEL[o.role] || "team member";
  const agency = b.name;
  const subject = `Welcome to ${agency}, ${first}`;
  const steps = (STEPS[o.role] || STEPS.recruiter)
    .map((s, i) => `<tr><td valign="top" style="padding:0 12px 10px 0;"><div style="width:24px;height:24px;border-radius:12px;background:#E3F1E9;color:${b.color};font-family:Arial,sans-serif;font-size:12px;font-weight:700;line-height:24px;text-align:center;">${i + 1}</div></td><td valign="top" style="padding:2px 0 10px;font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#14201B;">${s}</td></tr>`)
    .join("");
  const html = emailShell(b, `${o.inviter} added you to ${agency} as a ${role}. Set your password to get started.`,
    `<div style="font-size:24px;line-height:1.25;margin-bottom:10px;">Welcome to ${esc(agency)}, ${esc(first)}</div>
     <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#14201B;"><b>${esc(o.inviter)}</b> has added you to the ${esc(agency)} workspace as a <b>${esc(role)}</b>. Set your password to sign in for the first time.</div>
     ${button(b, o.setupUrl, "Set your password")}
     <div style="font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#56605A;margin-top:10px;">This link works once and expires in ${o.hours} hours. If it runs out, ask ${esc(o.inviter.split(" ")[0] || "your admin")} to send a new one.</div>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px;"><tr><td style="background:#F6F4EE;border-radius:12px;padding:14px 16px;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#14201B;">
       <div style="font-size:11px;letter-spacing:1px;font-weight:700;color:${b.color};margin-bottom:4px;">YOUR SIGN-IN</div>
       <div>Sign in at <a href="${esc(o.signInUrl)}" style="color:${b.color};">${esc(o.signInUrl.replace(/^https?:\/\//, ""))}</a></div>
       <div>with <b>${esc(o.email)}</b></div>
     </td></tr></table>
     <div style="font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#14201B;margin:20px 0 10px;">Your first steps</div>
     <table role="presentation" cellpadding="0" cellspacing="0" border="0">${steps}</table>
     <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#56605A;margin-top:10px;">Questions? Just reply to this email or ask ${esc(o.inviter)}.</div>`,
    `You're receiving this because an admin at ${b.legal || agency} created an account for you.`);
  return { subject, html };
}
