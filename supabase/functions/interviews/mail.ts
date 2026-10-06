// Interview emails to candidates, through the agency's own candidate email (Brevo), branded with
// the agency name from Agency settings. Best effort: a failed or unconfigured send never fails
// the action, it is reported back as sent:false.

export const PORTAL_BASE = () => Deno.env.get("PORTAL_BASE_URL") || "https://harbor.link";

import { Brand, button as brandButton, emailShell, esc } from "./brand.ts";
export { esc };
const p = (t: string) => `<div style="font-size:15px;line-height:1.6;margin-top:10px;">${t}</div>`;
const hi = (name: string) => `<div style="font-size:20px;margin-bottom:8px;">Hi ${esc(String(name || "there").split(" ")[0])},</div>`;

export const TZ_ABBR: Record<string, string> = { "Africa/Lagos": "WAT", "Asia/Kuala_Lumpur": "MYT", "Asia/Singapore": "SGT", "Asia/Dubai": "GST", "Africa/Nairobi": "EAT", "Africa/Johannesburg": "SAST", "Asia/Kolkata": "IST" };
// "Thursday 1 October, 12:00 – 13:00 EDT" in the candidate's time zone when we know it.
export function whenText(startsAt: string, minutes: number, tz?: string | null) {
  const start = new Date(startsAt), end = new Date(start.getTime() + minutes * 60000);
  const zone = tz || "UTC";
  try {
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long" }).format(start);
    const t = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    const abbr = TZ_ABBR[zone] || new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(start).find((x) => x.type === "timeZoneName")?.value || zone;
    return `${day}, ${t(start)} – ${t(end)} ${abbr}`;
  } catch { return start.toUTCString(); }
}

export type Info = {
  candidateName: string; candidateEmail: string; portalToken: string; role: string; company: string; round: string;
  startsAt: string; durationMin: number; tz?: string | null; locationType: string; location?: string | null; joinUrl?: string | null; recruiter: string;
};

function whereHtml(i: Info) {
  if (i.locationType === "phone") return `By phone${i.location ? ` (${esc(i.location)})` : ""}.`;
  if (i.locationType === "in_person") return `In person${i.location ? `: ${esc(i.location)}` : ""}.`;
  return i.joinUrl ? `Video call: <a href="${esc(i.joinUrl)}">${esc(i.joinUrl)}</a>` : "Video call. The link is on your candidate page.";
}
const roleLine = (i: Info) => `${esc(i.round)} for <b>${esc(i.role || "the role")}</b>${i.company ? ` at <b>${esc(i.company)}</b>` : ""}`;
const portal = (i: Info) => `${PORTAL_BASE()}/?c=${i.portalToken}`;

// Calendar file the candidate can add to any calendar app.
export function ics(i: Info & { id: string; seq: number; cancelled?: boolean }) {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const s = new Date(i.startsAt), e = new Date(s.getTime() + i.durationMin * 60000);
  const loc = i.locationType === "phone" ? "Phone" + (i.location ? " " + i.location : "") : i.locationType === "in_person" ? (i.location || "In person") : (i.joinUrl || "Video call");
  const clean = (t: string) => t.replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pronext//Interviews//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${i.id}@harbor`, `SEQUENCE:${i.seq}`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(s)}`, `DTEND:${f(e)}`,
    `SUMMARY:${clean(`${i.round}: ${i.role}${i.company ? " at " + i.company : ""}`)}`,
    `LOCATION:${clean(loc)}`, `DESCRIPTION:${clean("Your candidate page: " + portal(i))}`,
    ...(i.cancelled ? ["STATUS:CANCELLED"] : []), "END:VEVENT", "END:VCALENDAR",
  ];
  return btoa(unescape(encodeURIComponent(lines.join("\r\n"))));
}

export function inviteEmail(b: Brand, i: Info, changed = false) {
  const subject = changed ? `Updated time: your ${i.round.toLowerCase()} for ${i.role}` : `Interview booked: ${i.round} for ${i.role}`;
  const html = emailShell(b, subject, hi(i.candidateName) +
    p(changed ? `The time of your ${roleLine(i)} has changed.` : `Your ${roleLine(i)} is booked.`) +
    p(`<b>${esc(whenText(i.startsAt, i.durationMin, i.tz))}</b><br>${whereHtml(i)}`) +
    p(`Please confirm you'll be there on your candidate page. The attached file adds it to your calendar.`) +
    brandButton(b, portal(i), "Confirm I'll be there"));
  return { subject, html };
}

export function reminderEmail(b: Brand, i: Info, kind: "day" | "hour") {
  const subject = kind === "day" ? `Tomorrow: ${i.round} for ${i.role}` : `Starting in an hour: ${i.round} for ${i.role}`;
  const html = emailShell(b, subject, hi(i.candidateName) +
    p(kind === "day" ? `A reminder about your ${roleLine(i)} tomorrow.` : `Your ${roleLine(i)} starts in about an hour.`) +
    p(`<b>${esc(whenText(i.startsAt, i.durationMin, i.tz))}</b><br>${whereHtml(i)}`) +
    p(`Good luck. ${esc(i.recruiter || "Your recruiter")} is here if you need anything.`) +
    brandButton(b, portal(i), "Open your candidate page"));
  return { subject, html };
}

export const NOSHOW_TEXT = "Sorry we missed you at your interview. If you'd still like to be considered and want to reschedule, let us know and we'll ask the client for a new time.";
export function noShowEmail(b: Brand, i: Info) {
  const subject = `We missed you: ${i.round} for ${i.role}`;
  const html = emailShell(b, subject, hi(i.candidateName) +
    p(`About your ${roleLine(i)} on ${esc(whenText(i.startsAt, i.durationMin, i.tz))}:`) +
    p(esc(NOSHOW_TEXT)) +
    brandButton(b, portal(i), `Message ${i.recruiter || "your recruiter"}`));
  return { subject, html };
}

export function cancelEmail(b: Brand, i: Info) {
  const subject = `Interview cancelled: ${i.round} for ${i.role}`;
  const html = emailShell(b, subject, hi(i.candidateName) +
    p(`Your ${roleLine(i)} on ${esc(whenText(i.startsAt, i.durationMin, i.tz))} has been cancelled.`) +
    p(`${esc(i.recruiter || "Your recruiter")} will be in touch about next steps.`) +
    brandButton(b, portal(i), "Open your candidate page"));
  return { subject, html };
}
