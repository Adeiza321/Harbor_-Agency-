// TheirStack: new job postings from LinkedIn, Indeed, Glassdoor, career pages and ATSs.
// Key: THEIRSTACK_API_KEY. POST https://api.theirstack.com/v1/jobs/search (1 credit per job returned).

export const theirstackKey = () => Deno.env.get("THEIRSTACK_API_KEY") || "";

export type Posting = {
  id: string; title: string; url: string; posted_at: string | null;
  company: string; domain: string; country: string; location: string; remote: boolean; industry: string;
  description: string; salary: string;
  hiring_team: { first_name: string; full_name: string; role: string; linkedin_url: string }[];
};

// TheirStack's free plan returns at most 25 jobs per request, so bigger asks are fetched 25 at a time.
const PAGE = 25;
export async function searchJobs(opts: { titles: string[]; countries: string[]; places?: string[]; maxAgeDays: number; limit: number }): Promise<Posting[]> {
  const want = Math.min(Math.max(opts.limit, 1), 100);
  const out: Posting[] = [];
  for (let page = 0; out.length < want; page++) {
    let got: Posting[];
    try { got = await searchPage(opts, Math.min(PAGE, want - out.length), page); }
    catch (e) { if (page > 0 && /\b(402|403)\b/.test(String((e as Error)?.message))) break; throw e; }  // keep what we have
    out.push(...got);
    if (got.length < PAGE) break;                          // no more postings
  }
  return out;
}

async function searchPage(opts: { titles: string[]; countries: string[]; places?: string[]; maxAgeDays: number }, limit: number, page: number): Promise<Posting[]> {
  const key = theirstackKey();
  if (!key) throw new Error("The job feed isn't connected yet (THEIRSTACK_API_KEY)");
  const res = await fetch("https://api.theirstack.com/v1/jobs/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      job_title_or: opts.titles.slice(0, 25),
      job_country_code_or: opts.countries,
      // Only around these places (city or state names, matched against each job's normalized city and
      // state, case-insensitive). Regex characters in the names are escaped.
      ...(opts.places && opts.places.length ? { job_location_pattern_or: opts.places.slice(0, 20).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) } : {}),
      posted_at_max_age_days: Math.max(1, opts.maxAgeDays),
      company_type: "direct_employer",            // skip other recruitment agencies
      limit,
      page,
    }),
  });
  const raw = await res.text().catch(() => "");
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!res.ok) {
    // TheirStack's reason, whatever shape it comes in (it was coming back blank as "Job feed 403: ").
    const why = String(data?.error?.description || data?.error?.message || (typeof data?.detail === "string" ? data.detail : data?.detail ? JSON.stringify(data.detail) : "") || data?.message || raw || "").replace(/\s+/g, " ").slice(0, 240);
    const plan = data?.error?.code === "E-020";
    const hint = plan ? " This is a limit of TheirStack's free plan."
      : res.status === 401 || res.status === 403 ? " TheirStack refused the API key: check THEIRSTACK_API_KEY (Edge Functions > Secrets), that your plan includes API access, and that you have credits left."
      : res.status === 402 ? " TheirStack is out of credits." : "";
    throw new Error("Job feed " + res.status + (why ? ": " + why : "") + "." + hint);
  }
  return (Array.isArray(data?.data) ? data.data : []).map((j: any) => ({
    id: String(j.id ?? ""), title: String(j.job_title || ""), url: String(j.final_url || j.url || ""),
    posted_at: j.date_posted || null, company: String(j.company || j.company_object?.name || ""),
    domain: String(j.company_domain || j.company_object?.domain || ""), country: String(j.country_code || ""),
    industry: String(j.company_object?.industry || j.company_industry || j.industry || ""),
    location: String(j.location || j.short_location || ""), remote: !!j.remote,
    description: String(j.description || "").slice(0, 6000), salary: String(j.salary_string || ""),
    hiring_team: (Array.isArray(j.hiring_team) ? j.hiring_team : []).map((h: any) => ({
      first_name: String(h.first_name || ""), full_name: String(h.full_name || ""), role: String(h.role || ""), linkedin_url: String(h.linkedin_url || ""),
    })),
  })).filter((p: Posting) => p.id && p.title);
}
