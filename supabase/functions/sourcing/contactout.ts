// ContactOut: a fallback email lookup for X-ray people Apollo couldn't find, by LinkedIn profile.
// Key: CONTACTOUT_API_KEY (sent as the `token` header). Docs: https://api.contactout.com
//   GET /v1/people/linkedin?profile=<url>&email_type=<personal,work | work>
//   1 email credit when an email comes back; nothing when none is found (404).
// Both work and personal emails are asked for. The one used: the first personal email (the agency
// reaches candidates at their own address first), else a "Verified" work email; every address found is
// returned so it can be kept on the prospect.

export const contactoutKey = () => (Deno.env.get("CONTACTOUT_API_KEY") || "").trim();

const okEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/noreply|no-reply/i.test(e);
const list = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(okEmail);

export type ContactOutResult = { email: string; status: "verified" | "personal" | ""; found: boolean; work: string[]; personal: string[]; location?: string };

// workOnly: only work emails are asked for (client contacts), and only a "Verified" one is used.
export async function contactoutByLinkedIn(profileUrl: string, workOnly = false): Promise<ContactOutResult> {
  const key = contactoutKey();
  if (!key) throw new Error("ContactOut isn't connected (CONTACTOUT_API_KEY)");
  const qs = new URLSearchParams({ profile: profileUrl, email_type: workOnly ? "work" : "personal,work", include_phone: "false" });
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
  if (personal[0] && !workOnly) return { email: personal[0], status: "personal", found: true, work, personal, location };
  if (verifiedWork) return { email: verifiedWork, status: "verified", found: true, work, personal, location };
  return { email: "", status: "", found: true, work, personal, location };
}

// People at a company by job title (client contacts): POST /v1/people/search. Profiles only, no
// emails (reveal_info false); the email is revealed per person with contactoutByLinkedIn(url, true).
// Search credits are charged per profile returned, so only a few are asked for.
export type ContactOutHit = { linkedin: string; name: string; title: string; company: string };
export async function contactoutSearch(opts: { domain?: string; company?: string; titles: string[]; limit?: number }): Promise<ContactOutHit[]> {
  const key = contactoutKey();
  if (!key) throw new Error("ContactOut isn't connected (CONTACTOUT_API_KEY)");
  const domain = String(opts.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const company = String(opts.company || "").trim();
  if (!domain && !company) return [];
  const body: Record<string, unknown> = { page: 1, job_title: opts.titles.slice(0, 10), current_titles_only: true, reveal_info: false,
    ...(domain ? { domain: [domain] } : { company: [company], company_filter: "current" }) };
  const res = await fetch("https://api.contactout.com/v1/people/search", {
    method: "POST", headers: { token: key, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) return [];
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data?.status_code && Number(data.status_code) >= 400)) throw new Error("ContactOut " + (data?.status_code || res.status) + ": " + String(data?.message || data?.error || "").slice(0, 160));
  // profiles comes back keyed by LinkedIn URL (or, in some versions, as a list).
  const raw = data?.profiles ?? data?.data?.profiles ?? [];
  const rows: [string, any][] = Array.isArray(raw) ? raw.map((p: any) => [String(p?.linkedin_url || p?.url || ""), p]) : Object.entries(raw || {});
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return rows.map(([url, p]) => ({
    linkedin: String(p?.linkedin_url || p?.url || url || ""), name: String(p?.full_name || p?.name || ""), title: String(p?.title || p?.headline || ""),
    company: String(p?.company?.name || p?.company_name || (typeof p?.company === "string" ? p.company : "") || ""),
  })).filter((h) => /linkedin\.com\//i.test(h.linkedin) && (domain || !company || norm(h.company).includes(norm(company)) || norm(company).includes(norm(h.company))))
    .slice(0, opts.limit || 5);
}
