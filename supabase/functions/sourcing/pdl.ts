// People Data Labs (PDL): a paid people database (about 1.5 billion profiles) used two ways.
// Key: PDL_API_KEY (sent as the X-Api-Key header). Contact fields (emails, phones) need a paid
// plan; on the free plan they come back as true/false only, so nothing usable is found.
//   1. Emails for X-ray people Apollo and ContactOut couldn't find, by their LinkedIn profile:
//      GET /v5/person/enrich?profile=<url>&min_likelihood=6&required=work_email OR personal_emails
//      1 credit per match that has an email; no match (404) is free.
//   2. A search for new people for a job (Admin approval, like Apollo):
//      POST /v5/person/search with an Elasticsearch query on job title, place and "has an email";
//      1 credit per person returned, so `size` caps the spend.

export const pdlKey = () => (Deno.env.get("PDL_API_KEY") || "").trim();
const BASE = "https://api.peopledatalabs.com/v5/person/";
const okEmail = (e: unknown) => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/noreply|no-reply/i.test(e);
const cap = (s: unknown) => String(s || "").replace(/\b([a-z])/g, (m) => m.toUpperCase());

export type PdlPerson = {
  id: string; name: string; first_name: string; last_name: string; title: string; company: string;
  city: string; region: string; country: string; location: string; linkedin_url: string;
  work_email: string; personal_emails: string[]; phones: string[]; skills: string[]; headline: string;
  years: number | null; history: string; employers: string[]; contactsHidden: boolean; summary: string; education: string;
};

function toPerson(d: any): PdlPerson {
  const exp = Array.isArray(d?.experience) ? d.experience : [];
  const history = exp.slice(0, 8).map((x: any) => {
    const t = cap(x?.title?.name), c = cap(x?.company?.name);
    const when = [x?.start_date, x?.end_date || (x?.is_primary ? "now" : "")].filter(Boolean).join("–");
    const did = String(x?.summary || "").replace(/\s+/g, " ").trim().slice(0, 200);
    return [t, c ? "at " + c : "", when ? "(" + when + ")" : ""].filter(Boolean).join(" ") + (did ? ": " + did : "");
  }).filter(Boolean).join("; ");
  const personal = (Array.isArray(d?.personal_emails) ? d.personal_emails : []).filter(okEmail);
  const rec = okEmail(d?.recommended_personal_email) ? [d.recommended_personal_email] : [];
  return {
    id: String(d?.id || ""), name: cap(d?.full_name), first_name: cap(d?.first_name), last_name: cap(d?.last_name),
    title: cap(d?.job_title), company: cap(d?.job_company_name),
    city: cap(d?.location_locality), region: cap(d?.location_region), country: cap(d?.location_country), location: cap(d?.location_name),
    linkedin_url: d?.linkedin_url ? "https://www." + String(d.linkedin_url).replace(/^https?:\/\/(www\.)?/i, "") : "",
    work_email: okEmail(d?.work_email) ? d.work_email : "",
    personal_emails: [...new Set([...rec, ...personal])],
    phones: (Array.isArray(d?.phone_numbers) ? d.phone_numbers : []).filter((p: unknown) => typeof p === "string").slice(0, 3),
    skills: (Array.isArray(d?.skills) ? d.skills : []).slice(0, 25),
    headline: String(d?.headline || ""), years: Number.isFinite(Number(d?.inferred_years_experience)) ? Number(d.inferred_years_experience) : null,
    history, employers: exp.map((x: any) => cap(x?.company?.name)).filter(Boolean),
    summary: String(d?.summary || "").replace(/\s+/g, " ").trim().slice(0, 600),
    education: (Array.isArray(d?.education) ? d.education : []).slice(0, 3).map((e: any) => [cap((e?.degrees || []).join(", ")), cap((e?.majors || []).join(", ")), cap(e?.school?.name)].filter(Boolean).join(", ")).filter(Boolean).join("; "),
    // Free plan: contact fields are booleans, not addresses.
    contactsHidden: d?.work_email === true || d?.personal_emails === true || d?.recommended_personal_email === true,
  };
}

// A person's full profile by their LinkedIn link (the must-have check's paid fallback, after an
// Admin approves it): 1 credit per match, no match (404) is free. Unlike pdlByLinkedIn it doesn't
// need them to have an email.
export async function pdlProfile(profileUrl: string): Promise<PdlPerson | null> {
  const profile = String(profileUrl || "").replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!/linkedin\.com\/in\//i.test(profile)) return null;
  const out: any = await call("GET", "enrich", undefined, new URLSearchParams({ profile, min_likelihood: "6" }));
  if (!out || out.status === 404 || !out.data) return null;
  return toPerson(out.data);
}

// The address to use: their work email first, else their best personal email.
export function bestPdlEmail(p: PdlPerson | null): { email: string; status: string } {
  if (!p) return { email: "", status: "" };
  if (p.work_email) return { email: p.work_email, status: "pdl_work" };
  if (p.personal_emails[0]) return { email: p.personal_emails[0], status: "pdl_personal" };
  return { email: "", status: "" };
}

async function call(method: "GET" | "POST", path: string, body?: unknown, qs?: URLSearchParams) {
  const key = pdlKey();
  if (!key) throw new Error("People Data Labs isn't connected (PDL_API_KEY)");
  const res = await fetch(BASE + path + (qs ? "?" + qs : ""), {
    method, headers: { "X-Api-Key": key, "Content-Type": "application/json", Accept: "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000),
  });
  if (res.status === 404) return { status: 404 };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(data?.error?.message || data?.error?.type || data?.message || "").slice(0, 200);
    if (res.status === 402) throw new Error("People Data Labs: out of credits" + (msg ? " (" + msg + ")" : ""));
    if (res.status === 401 || res.status === 403) throw new Error("People Data Labs: the API key was refused" + (msg ? " (" + msg + ")" : ""));
    if (res.status === 429) throw new Error("People Data Labs: rate limited, try again in a minute");
    throw new Error("People Data Labs " + res.status + (msg ? ": " + msg : ""));
  }
  return data;
}

// One person by their LinkedIn profile; only billed (and only returned) when they have an email.
export async function pdlByLinkedIn(profileUrl: string): Promise<PdlPerson | null> {
  const profile = String(profileUrl || "").replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!/linkedin\.com\/in\//i.test(profile)) return null;
  const qs = new URLSearchParams({ profile, min_likelihood: "6", required: "work_email OR personal_emails" });
  let out: any;
  try { out = await call("GET", "enrich", undefined, qs); }
  catch (e) {
    // If the "required" filter itself is refused, ask once without it.
    if (!/\b400\b/.test(String((e as Error)?.message))) throw e;
    qs.delete("required");
    out = await call("GET", "enrich", undefined, qs);
  }
  if (!out || out.status === 404 || !out.data) return null;
  return toPerson(out.data);
}

// Search: current title (any of the titles), place, and someone we can email; the client's own
// staff left out. Places: cities for on-site / hybrid roles, states for state-wide or remote roles
// with preferred time zones, otherwise the whole country.
export async function pdlSearch(o: { titles: string[]; country: string; cities?: string[]; regions?: string[]; excludeCompany?: string; size: number }): Promise<{ people: PdlPerson[]; total: number }> {
  const lc = (s: string) => String(s || "").toLowerCase().trim();
  const titles = [...new Set(o.titles.map(lc).filter(Boolean))].slice(0, 10);
  const must: any[] = [
    { bool: { should: titles.map((t) => ({ match_phrase: { "job_title.text": t } })) } },
    { term: { location_country: lc(o.country) } },
    { bool: { should: [{ exists: { field: "work_email" } }, { exists: { field: "personal_emails" } }] } },
  ];
  const cities = [...new Set((o.cities || []).map(lc).filter(Boolean))].slice(0, 40);
  const regions = [...new Set((o.regions || []).map(lc).filter(Boolean))].slice(0, 20);
  if (cities.length) must.push({ terms: { location_locality: cities } });
  else if (regions.length) must.push({ terms: { location_region: regions } });
  const query: any = { bool: { must } };
  if (o.excludeCompany) query.bool.must_not = [{ term: { job_company_name: lc(o.excludeCompany) } }];
  const out: any = await call("POST", "search", { size: Math.max(1, Math.min(100, Math.round(o.size))), query });
  if (!out || out.status === 404) return { people: [], total: 0 };
  return { people: (Array.isArray(out.data) ? out.data : []).map(toPerson), total: Number(out.total) || 0 };
}
