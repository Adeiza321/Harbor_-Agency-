// TheirStack: new job postings from LinkedIn, Indeed, Glassdoor, career pages and ATSs.
// Key: THEIRSTACK_API_KEY. POST https://api.theirstack.com/v1/jobs/search (1 credit per job returned).

export const theirstackKey = () => Deno.env.get("THEIRSTACK_API_KEY") || "";

export type Posting = {
  id: string; title: string; url: string; posted_at: string | null;
  company: string; domain: string; country: string; location: string; remote: boolean; industry: string;
  description: string; salary: string; employees: number | null;
  hiring_team: { first_name: string; full_name: string; role: string; linkedin_url: string }[];
};

// Postings that say the employer won't take agency candidates or pay for unsolicited CVs, left out by
// TheirStack itself (so they cost no credits). Plain regex (no \b or look-arounds) so TheirStack's
// regex engine reads them; matched ignoring case. The same is checked again in code (noAgencyText in
// common.ts) and by the AI reading the job description (pitch.ts), which catch other wordings.
export const NO_AGENCY_PATTERNS = [
  "unsolicited (resume|résumé|cv|candidate|submission|profile|application)",
  "principals only",
  "no (third.party|3rd.party|outside|external) (recruit|agenc|staffing|candidate|submission|resume)",
  "no (recruitment |staffing |search )?(agencies|agency submissions|recruiters|headhunters)",
  "(agencies|recruiters|headhunters|third.part(y|ies)).{0,40}(need not|should not|do not|will not|please do not|must not).{0,25}(apply|contact|call|submit|send|reach)",
  "n.?t (accept|accepting|work with|working with|engage|use) (any )?(unsolicited )?(third.party |external |outside |recruitment |staffing )?(agenc|recruiter|headhunter)",
];

// TheirStack's free plan returns at most 25 jobs per request, so bigger asks are fetched 25 at a time.
const PAGE = 25;
// remote: true = remote roles only, false = on-site / hybrid only, unset = both.
export type JobSearch = { titles: string[]; countries: string[]; places?: string[]; remote?: boolean; maxAgeDays: number; limit: number; minEmployees?: number; maxEmployees?: number };
export async function searchJobs(opts: JobSearch): Promise<Posting[]> {
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

// Description patterns TheirStack refused once (a 400/422 naming them) are dropped for the rest of
// the run; the code check after the search still applies.
let patternsOk = true;
async function searchPage(opts: JobSearch, limit: number, page: number): Promise<Posting[]> {
  try { return await searchPageOnce(opts, limit, page, patternsOk); }
  catch (e) {
    if (patternsOk && /Job feed (400|422)/.test(String((e as Error)?.message || ""))) { patternsOk = false; return await searchPageOnce(opts, limit, page, false); }
    throw e;
  }
}
async function searchPageOnce(opts: JobSearch, limit: number, page: number, patterns: boolean): Promise<Posting[]> {
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
      ...(typeof opts.remote === "boolean" ? { remote: opts.remote } : {}),
      // Small and medium companies (Outreach settings): more likely to take an agency's CVs and pay.
      ...(opts.minEmployees ? { min_employee_count: opts.minEmployees } : {}),
      ...(opts.maxEmployees ? { max_employee_count: opts.maxEmployees } : {}),
      // Employers that say no agencies / no unsolicited CVs are left out.
      ...(patterns ? { job_description_pattern_not: NO_AGENCY_PATTERNS, job_description_pattern_is_case_insensitive: true } : {}),
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
    employees: Number.isFinite(Number(j.company_object?.employee_count ?? j.company_employee_count)) && (j.company_object?.employee_count ?? j.company_employee_count) !== null ? Number(j.company_object?.employee_count ?? j.company_employee_count) : null,
    hiring_team: (Array.isArray(j.hiring_team) ? j.hiring_team : []).map((h: any) => ({
      first_name: String(h.first_name || ""), full_name: String(h.full_name || ""), role: String(h.role || ""), linkedin_url: String(h.linkedin_url || ""),
    })),
  })).filter((p: Posting) => p.id && p.title);
}
