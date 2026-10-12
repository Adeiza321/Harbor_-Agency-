// ContactOut: a fallback email lookup for X-ray people Apollo couldn't find, by LinkedIn profile.
// Key: CONTACTOUT_API_KEY (sent as the `token` header). Docs: https://api.contactout.com
//   GET /v1/people/linkedin?profile=<url>&email_type=<personal,work | work>
//   1 email credit when an email comes back; nothing when none is found (404).
// Work emails are verified in real time and only "Verified" ones are used. Personal emails are
// only asked for outside the EU/UK/EEA: emailing someone's personal address about a job without
// their consent is the riskier case under GDPR and the UK's PECR.

export const contactoutKey = () => (Deno.env.get("CONTACTOUT_API_KEY") || "").trim();

const okEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/noreply|no-reply/i.test(e);
const list = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(okEmail);

export type ContactOutResult = { email: string; status: "verified" | "personal" | ""; found: boolean };

export async function contactoutByLinkedIn(profileUrl: string, allowPersonal: boolean): Promise<ContactOutResult> {
  const key = contactoutKey();
  if (!key) throw new Error("ContactOut isn't connected (CONTACTOUT_API_KEY)");
  const qs = new URLSearchParams({ profile: profileUrl, email_type: allowPersonal ? "personal,work" : "work", include_phone: "false" });
  const res = await fetch("https://api.contactout.com/v1/people/linkedin?" + qs, {
    headers: { token: key, Accept: "application/json", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) return { email: "", status: "", found: false };
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data?.status_code && Number(data.status_code) >= 400)) {
    throw new Error("ContactOut " + (data?.status_code || res.status) + ": " + String(data?.message || data?.error || "").slice(0, 160));
  }
  const p = data?.profile && !Array.isArray(data.profile) ? data.profile : null;
  if (!p) return { email: "", status: "", found: false };
  const statuses: Record<string, string> = p.work_email_status && typeof p.work_email_status === "object" ? p.work_email_status : {};
  const verifiedWork = list(p.work_email).find((e) => /^verified$/i.test(String(statuses[e] || "")));
  if (verifiedWork) return { email: verifiedWork, status: "verified", found: true };
  const personal = allowPersonal ? list(p.personal_email)[0] : "";
  if (personal) return { email: personal, status: "personal", found: true };
  return { email: "", status: "", found: true };
}
