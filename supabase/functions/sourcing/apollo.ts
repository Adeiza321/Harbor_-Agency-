// Apollo.io: people search (free, no emails) and people match (reveals email, 1 credit).
// Key: APOLLO_API_KEY. Docs: https://docs.apollo.io
//   POST /api/v1/mixed_people/api_search  -> people[] (id, first_name, last_name_obfuscated, title, organization, has_email)
//   POST /api/v1/people/match             -> person (email, email_status, name, linkedin_url, city/state/country, employment_history)

const BASE = "https://api.apollo.io/api/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const apolloKey = () => Deno.env.get("APOLLO_API_KEY") || "";

async function call(path: string, params: Record<string, unknown>) {
  const key = apolloKey();
  if (!key) throw new Error("Apollo isn't connected yet (APOLLO_API_KEY)");
  // Apollo documents these as query parameters; arrays use the key[] form.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k + "[]", String(x)));
    else qs.append(k, String(v));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}${path}?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": key },
      body: JSON.stringify(params),
    });
    if (res.status === 429) { await sleep(attempt === 0 ? 5000 : 20000); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Apollo " + res.status + ": " + String(data?.error || data?.message || "").slice(0, 200));
    return data;
  }
  throw new Error("Apollo is rate-limiting requests; try again in a minute");
}

export type ApolloHit = { id: string; first_name: string; title: string; company: string; has_email: boolean };

export async function searchPeople(opts: { titles: string[]; locations: string[]; perPage?: number; page?: number }): Promise<{ hits: ApolloHit[]; total: number }> {
  const data = await call("/mixed_people/api_search", {
    person_titles: opts.titles.slice(0, 10),
    include_similar_titles: false,
    person_locations: opts.locations.slice(0, 40),
    contact_email_status: ["verified"],
    per_page: Math.min(opts.perPage || 100, 100),
    page: opts.page || 1,
  });
  const hits = (Array.isArray(data?.people) ? data.people : []).map((p: any) => ({
    id: String(p.id || ""), first_name: String(p.first_name || ""), title: String(p.title || ""),
    company: String(p.organization?.name || p.organization_name || ""), has_email: p.has_email !== false,
  })).filter((p: ApolloHit) => p.id);
  return { hits, total: Number(data?.total_entries || data?.pagination?.total_entries || hits.length) };
}

export type ApolloPerson = {
  id: string; first_name: string; last_name: string; name: string; title: string; email: string; email_status: string;
  linkedin_url: string; city: string; state: string; country: string; company: string; domain: string; history: string;
};

function toPerson(p: any): ApolloPerson | null {
  if (!p) return null;
  const hist = (Array.isArray(p.employment_history) ? p.employment_history : []).slice(0, 6)
    .map((h: any) => `${h.title || "?"} at ${h.organization_name || "?"} (${String(h.start_date || "").slice(0, 7) || "?"} to ${h.current ? "now" : String(h.end_date || "").slice(0, 7) || "?"})`).join("; ");
  return {
    id: String(p.id || ""), first_name: String(p.first_name || ""), last_name: String(p.last_name || ""), name: String(p.name || ""),
    title: String(p.title || ""), email: String(p.email || ""), email_status: String(p.email_status || ""),
    linkedin_url: String(p.linkedin_url || ""), city: String(p.city || ""), state: String(p.state || ""), country: String(p.country || ""),
    company: String(p.organization?.name || ""), domain: String(p.organization?.primary_domain || p.organization?.website_url || ""), history: hist,
  };
}

// Reveal one person by Apollo id (1 credit when an email comes back).
export async function matchById(id: string): Promise<ApolloPerson | null> {
  const data = await call("/people/match", { id, reveal_personal_emails: false, reveal_phone_number: false });
  return toPerson(data?.person);
}

// Find a named person at a company (for a job poster whose email we don't have).
export async function matchByName(first: string, last: string, domain: string, company: string): Promise<ApolloPerson | null> {
  const data = await call("/people/match", { first_name: first, last_name: last, domain: domain || undefined, organization_name: domain ? undefined : company, reveal_personal_emails: false, reveal_phone_number: false });
  return toPerson(data?.person);
}
