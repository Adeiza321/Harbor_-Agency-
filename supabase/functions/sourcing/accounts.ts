// Recruiters who stop using ProNext (database function suspend_inactive_recruiters, run on the
// 10-minute tick): at 23 days without using it they're emailed a warning; at 30 days, and at least
// 6 days after that warning, the account is suspended and they're told how to get it back.
import { button, emailShell, esc, loadBrand, sendBrevo } from "./brand.ts";

const APP_URL = Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com";

export async function stepInactiveRecruiters(admin: any) {
  const { data, error } = await admin.rpc("suspend_inactive_recruiters");
  if (error) throw new Error(error.message);
  const suspended: any[] = data?.suspended || [], warn: any[] = data?.warn || [];
  if (!suspended.length && !warn.length) return { suspended: 0, warned: 0 };
  const b = await loadBrand(admin);
  const foot = "You're receiving this because you have a recruiter account with " + b.name + ".";
  const hi = (u: any) => `<div style="font-size:20px;margin-bottom:8px;">Hi ${esc(String(u.full_name || "there").split(" ")[0])},</div>`;
  const p = (t: string) => `<div style="font-size:15px;line-height:1.6;margin-top:10px;">${t}</div>`;
  for (const u of warn) {
    if (!u.email) continue;
    const subject = "Your " + b.name + " account will be suspended in 7 days";
    await sendBrevo(b, { email: u.email, name: u.full_name || undefined }, subject, emailShell(b, subject,
      hi(u) + p(`You haven't signed in to ${esc(b.name)} for over three weeks. Recruiter accounts that aren't used for 30 days are suspended.`) +
      p("Sign in within the next 7 days to keep your account active. Your candidates and roles stay as they are.") + button(b, APP_URL, "Sign in"), foot));
  }
  for (const u of suspended) {
    if (!u.email) continue;
    const subject = "Your " + b.name + " account has been suspended";
    await sendBrevo(b, { email: u.email, name: u.full_name || undefined }, subject, emailShell(b, subject,
      hi(u) + p(`Your ${esc(b.name)} recruiter account has been suspended because it wasn't used for 30 days.`) +
      p("Nothing has been deleted. To get back in, reply to this email or contact your Rec Ops team and ask them to reactivate your account."), foot));
  }
  return { suspended: suspended.length, warned: warn.length };
}
