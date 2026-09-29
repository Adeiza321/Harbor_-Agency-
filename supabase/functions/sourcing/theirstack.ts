// TheirStack: new job postings from LinkedIn, Indeed, Glassdoor, career pages and ATSs.
// Key: THEIRSTACK_API_KEY. POST https://api.theirstack.com/v1/jobs/search (1 credit per job returned).

export const theirstackKey = () => Deno.env.get("THEIRSTACK_API_KEY") || "";

export type Posting = {
  id: string; title: string; url: string; posted_at: string | null;
  company: string; domain: string; country: string; location: string; remote: boolean;
  description: string; salary: string;
  hiring_team: { first_name: string; full_name: string; role: string; linkedin_url: string }[];
};

export async function searchJobs(opts: { titles: string[]; countries: string[]; maxAgeDays: number; limit: number }): Promise<Posting[]> {
  const key = theirstackKey();
  if (!key) throw new Error("The job feed isn't connected yet (THEIRSTACK_API_KEY)");
  const res = await fetch("https://api.theirstack.com/v1/jobs/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      job_title_or: opts.titles.slice(0, 40),
      job_country_code_or: opts.countries,
      posted_at_max_age_days: Math.max(1, opts.maxAgeDays),
      company_type: "direct_employer",            // skip other recruitment agencies
      limit: Math.min(Math.max(opts.limit, 1), 100),
      page: 0,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Job feed " + res.status + ": " + String(data?.error?.message || data?.detail || data?.message || "").slice(0, 200));
  return (Array.isArray(data?.data) ? data.data : []).map((j: any) => ({
    id: String(j.id ?? ""), title: String(j.job_title || ""), url: String(j.final_url || j.url || ""),
    posted_at: j.date_posted || null, company: String(j.company || j.company_object?.name || ""),
    domain: String(j.company_domain || j.company_object?.domain || ""), country: String(j.country_code || ""),
    location: String(j.location || j.short_location || ""), remote: !!j.remote,
    description: String(j.description || "").slice(0, 6000), salary: String(j.salary_string || ""),
    hiring_team: (Array.isArray(j.hiring_team) ? j.hiring_team : []).map((h: any) => ({
      first_name: String(h.first_name || ""), full_name: String(h.full_name || ""), role: String(h.role || ""), linkedin_url: String(h.linkedin_url || ""),
    })),
  })).filter((p: Posting) => p.id && p.title);
}
