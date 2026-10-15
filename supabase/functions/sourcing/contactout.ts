// ContactOut: a fallback email lookup for X-ray people Apollo couldn't find, by LinkedIn profile.
// Key: CONTACTOUT_API_KEY (sent as the `token` header). Docs: https://api.contactout.com
//   GET /v1/people/linkedin?profile=<url>&email_type=<personal,work | work>
//   1 email credit when an email comes back; nothing when none is found (404).
// Both work and personal emails are asked for. The one used: a "Verified" work email first, else
// the first personal email; every address found is returned so it can be kept on the prospect.

export const contactoutKey = () => (Deno.env.get("CONTACTOUT_API_KEY") || "").trim();

const okEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/noreply|no-reply/i.test(e);
const list = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(okEmail);

export type ContactOutResult = { email: string; status: "verified" | "personal" | ""; found: boolean; work: string[]; personal: string[]; location?: string };

export async function contactoutByLinkedIn(profileUrl: string): Promise<ContactOutResult> {
  const key = contactoutKey();
  if (!key) throw new Error("ContactOut isn't connected (CONTACTOUT_API_KEY)");
  const qs = new URLSearchParams({ profile: profileUrl, email_type: "personal,work", include_phone: "false" });
  const res = await fetch("https://api.contactout.com/v1/people/linkedin?" + qs, {
    headers: { token: key, Accept: "application/json", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  const none: ContactOutResult = { email: "", status: "", found: false, work: [], personal: [] };
  if (res.status === 404) return none;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data?.status_code && Number(data.status_code) >= 400)) {
    throw new Error("ContactOut " + (data?.status_code || res.status) + ": " + String(data?.message || data?.error || "").slice(0, 160));
  }
  const p = data?.profile && !Array.isArray(data.profile) ? data.profile : null;
  if (!p) return none;
  const statuses: Record<string, string> = p.work_email_status && typeof p.work_email_status === "object" ? p.work_email_status : {};
  const work = list(p.work_email), personal = list(p.personal_email);
  const location = typeof p.location === "string" ? p.location.trim().slice(0, 120) : "";
  const verifiedWork = work.find((e) => /^verified$/i.test(String(statuses[e] || "")));
  if (verifiedWork) return { email: verifiedWork, status: "verified", found: true, work, personal, location };
  if (personal[0]) return { email: personal[0], status: "personal", found: true, work, personal, location };
  return { email: "", status: "", found: true, work, personal, location };
}
