// "Not active" candidates: "Open to new roles" is off (they turned it off, said no to other roles,
// didn't answer the last reminder, or started a new job through us). It stays off until they turn
// it back on. A year after it went off we email once to ask whether they're looking again; their
// answer (on their candidate page) turns it back on, or keeps it off for another year.

import { button, emailShell, esc, loadBrand, sendBrevo } from "./brand.ts";
import { portalBase } from "./queue.ts";

const p = (t: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${t}</p>`;

export function openCheckinEmail(b: any, o: { first: string; recruiter: string; page: string }) {
  const ans = (a: string, label: string, primary: boolean) => `<a href="${esc(o.page + "&open=" + a)}" style="display:block;margin:0 0 10px;padding:12px 18px;border-radius:10px;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:600;${primary ? `background:${b.color};color:#FFFFFF;` : "border:1px solid #D9D4C8;color:#14201B;background:#FFFFFF;"}">${esc(label)}</a>`;
  return emailShell(b, "Are you looking for a new role?",
    p(`Hi ${esc(o.first)},`) +
    p(`It's been about a year since we stopped putting your profile forward for roles, so we wanted to check in.`) +
    p(`<b>Are you looking for a new role?</b> Tap the answer that fits:`) +
    `<div style="max-width:360px;margin:6px 0 14px;">${ans("active", "Yes, I'm actively looking", true)}${ans("open", "I'm open to the right role", false)}${ans("not_now", "Not right now", false)}</div>` +
    p(`We won't put you forward for anything until you tell us you're open to it. If now isn't the time, we'll check in again in a year.`) +
    p(`<br>${esc(o.recruiter || "The team")}<br><span style="color:#56605A;font-size:13px;">${esc(b.legal || b.name)}</span>`));
}

export async function stepOpenCheckins(admin: any, n = 20) {
  const now = new Date().toISOString();
  const { data: rows } = await admin.from("candidates").select("id,name,email,email_opt_out,portal_token,recruiter_id,open_paused_until,open_checkin_at")
    .eq("open_to_roles", false).not("open_paused_until", "is", null).lte("open_paused_until", now).limit(n * 3);
  const due = (rows || []).filter((c: any) => !c.open_checkin_at || Date.parse(c.open_checkin_at) < Date.parse(c.open_paused_until)).slice(0, n);
  if (!due.length) return { asked: 0 };
  const b = await loadBrand(admin);
  let asked = 0;
  for (const c of due) {
    // Marked first, so a failed or skipped email isn't retried every 10 minutes.
    await admin.from("candidates").update({ open_checkin_at: now }).eq("id", c.id);
    if (!c.email || c.email_opt_out || !c.portal_token) continue;
    const { data: rec } = c.recruiter_id ? await admin.from("profiles").select("full_name,email").eq("id", c.recruiter_id).maybeSingle() : { data: null };
    const page = `${portalBase()}/?c=${encodeURIComponent(c.portal_token)}`;
    const ok = await sendBrevo(b, { email: c.email, name: c.name }, "Are you looking for a new role?",
      openCheckinEmail(b, { first: String(c.name || "").split(" ")[0] || "there", recruiter: String(rec?.full_name || "").split(" ")[0] || "", page }),
      undefined, { replyTo: rec?.email ? { email: rec.email, name: rec.full_name || undefined } : null });
    await admin.from("candidate_timeline").insert({ candidate_id: c.id, title: "Asked whether they're looking for a new role again (a year on)" + (ok ? "" : " (email didn't send)"), done: true });
    if (ok) asked++;
  }
  return { asked };
}
