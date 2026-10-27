// Free search engines for X-ray sourcing. Each engine is used only while its key exists and
// only inside its free allowance (counted in public.search_usage), so nothing is ever charged:
//   Serper.dev  real Google results           SERPER_API_KEY   one-time free allowance (2,500)
//   Brave       Brave's own index             BRAVE_API_KEY    monthly free credit (~1,000)
//   Tavily      AI search API                 TAVILY_API_KEY   1,000 free credits a month
//   Gemini      Google Search grounding       GEMINI_API_KEY (on whenever the key exists; model from
//               XRAY_GEMINI_MODEL, else GEMINI_MODEL, else gemini-3.8-flash; XRAY_GEMINI_MODEL=off turns
//               it off). Capped at GEMINI_FREE_LIMIT searches a day (400).
//   GitHub      user search (technical roles) GITHUB_TOKEN optional (more profiles per run)
// The allowances can be lowered (or raised, if a paid plan is added later) with SERPER_FREE_LIMIT,
// BRAVE_FREE_LIMIT, TAVILY_FREE_LIMIT and GEMINI_FREE_LIMIT.
// Order: allowances that reset (Tavily and Brave monthly, Gemini daily) are spent first, because what
// isn't used is lost; Serper's one-time allowance is kept for when they run out or find nothing.
// A search that fails, or finds no profiles, is tried on the next engine.
//
// Only search-engine results are read (title, link, snippet). Profile sites themselves (LinkedIn
// included) are never opened or scraped.

export type Hit = { url: string; title: string; snippet: string; engine: string };

const env = (k: string) => (Deno.env.get(k) || "").trim();
const limitOf = (k: string, d: number) => { const v = env(k); const n = Number(v); return v !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };
const periodKey = (p: "day" | "month" | "total") => p === "total" ? "total" : new Date().toISOString().slice(0, p === "day" ? 10 : 7);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ---------------------------------------------------------------------------
// Profile pages we accept, and their one canonical address (used to spot duplicates).
// ---------------------------------------------------------------------------
export type SiteKey = "linkedin" | "github" | "stackoverflow" | "gitlab" | "kaggle" | "huggingface" | "devto" | "dribbble" | "behance";
export const SITES: Record<SiteKey, { label: string; prefix: string; domain: string }> = {
  linkedin: { label: "LinkedIn", prefix: "site:linkedin.com/in", domain: "linkedin.com" },
  github: { label: "GitHub", prefix: "site:github.com", domain: "github.com" },
  stackoverflow: { label: "Stack Overflow", prefix: "site:stackoverflow.com/users", domain: "stackoverflow.com" },
  gitlab: { label: "GitLab", prefix: "site:gitlab.com", domain: "gitlab.com" },
  kaggle: { label: "Kaggle", prefix: "site:kaggle.com", domain: "kaggle.com" },
  huggingface: { label: "Hugging Face", prefix: "site:huggingface.co", domain: "huggingface.co" },
  devto: { label: "DEV", prefix: "site:dev.to", domain: "dev.to" },
  dribbble: { label: "Dribbble", prefix: "site:dribbble.com", domain: "dribbble.com" },
  behance: { label: "Behance", prefix: "site:behance.net", domain: "behance.net" },
};
// First path segments that are site pages, not people.
const NOT_PEOPLE: Partial<Record<SiteKey, string[]>> = {
  github: ["orgs", "topics", "search", "features", "marketplace", "explore", "about", "pricing", "enterprise", "sponsors", "collections", "trending", "login", "join", "settings", "apps", "site", "readme", "events"],
  gitlab: ["explore", "users", "help", "groups", "projects", "dashboard", "search", "gitlab-org", "-"],
  kaggle: ["competitions", "datasets", "code", "discussions", "discussion", "learn", "models", "docs", "rankings", "c", "t", "general", "search", "organizations", "contact"],
  huggingface: ["models", "datasets", "spaces", "docs", "blog", "papers", "pricing", "learn", "join", "login", "organizations", "tasks", "posts", "chat", "settings", "collections"],
  devto: ["t", "top", "latest", "search", "listings", "videos", "podcasts", "enter", "about", "faq", "pod", "settings"],
  dribbble: ["shots", "designers", "jobs", "tags", "search", "stories", "learn", "pro", "session", "signup", "hiring", "following", "places", "colors"],
  behance: ["gallery", "search", "joblist", "galleries", "assets", "hire", "onboarding", "live", "adobe"],
};

export function profileOf(raw: string): { key: string; site: SiteKey } | null {
  let u: URL;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const one = (site: SiteKey, base: string) => {
    if (parts.length < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(parts[0])) return null;
    if ((NOT_PEOPLE[site] || []).includes(parts[0].toLowerCase())) return null;
    // GitHub/GitLab/Hugging Face: a person's page is exactly one segment (deeper pages are repos).
    if (["github", "gitlab", "huggingface", "kaggle", "devto", "dribbble"].includes(site) && parts.length > 1) return null;
    return { key: base + parts[0].toLowerCase(), site };
  };
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    if (parts[0] !== "in" || !parts[1] || parts.length > 3) return null;
    const slug = parts[1].toLowerCase();
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{1,100}$/u.test(slug)) return null;
    return { key: "https://www.linkedin.com/in/" + encodeURIComponent(slug).replace(/%2D/gi, "-"), site: "linkedin" };
  }
  if (host === "stackoverflow.com") {
    if (parts[0] !== "users" || !/^\d+$/.test(parts[1] || "")) return null;
    return { key: "https://stackoverflow.com/users/" + parts[1], site: "stackoverflow" };
  }
  if (host === "github.com") return one("github", "https://github.com/");
  if (host === "gitlab.com") return one("gitlab", "https://gitlab.com/");
  if (host === "kaggle.com") return one("kaggle", "https://www.kaggle.com/");
  if (host === "huggingface.co") return one("huggingface", "https://huggingface.co/");
  if (host === "dev.to") return one("devto", "https://dev.to/");
  if (host === "dribbble.com") return one("dribbble", "https://dribbble.com/");
  if (host === "behance.net") return parts.length === 1 ? one("behance", "https://www.behance.net/") : null;
  return null;
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------
type Engine = { name: string; key: string; period: "day" | "month" | "total"; limit: number; run: (q: string) => Promise<Hit[]> };

async function serper(q: string): Promise<Hit[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST", headers: { "X-API-KEY": env("SERPER_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ q, num: 10 }), signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("Serper " + res.status + ": " + (await res.text()).slice(0, 160));
  const d = await res.json();
  return (d.organic || []).map((r: any) => ({ url: String(r.link || ""), title: clip(r.title, 200), snippet: clip(r.snippet, 500), engine: "serper" }));
}

async function brave(q: string): Promise<Hit[]> {
  const res = await fetch("https://api.search.brave.com/res/v1/web/search?count=20&q=" + encodeURIComponent(q), {
    headers: { Accept: "application/json", "X-Subscription-Token": env("BRAVE_API_KEY") }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("Brave " + res.status + ": " + (await res.text()).slice(0, 160));
  const d = await res.json();
  return (d.web?.results || []).map((r: any) => ({ url: String(r.url || ""), title: clip(r.title, 200), snippet: clip([r.description, ...(r.extra_snippets || [])].join(" "), 500).replace(/<\/?strong>/g, ""), engine: "brave" }));
}

// Tavily gets the query exactly as written, site: operator included. Tested on real X-ray searches:
// that returns 20 profiles out of 20, where turning site: into a domain filter (linkedin.com) let in
// mostly job ads and posts (6 profiles out of 20). Queries are kept under Tavily's 400 characters.
async function tavily(q: string): Promise<Hit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST", headers: { Authorization: "Bearer " + env("TAVILY_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ query: q.replace(/\s+/g, " ").trim().slice(0, 395), search_depth: "basic", max_results: 20 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error("Tavily " + res.status + ": " + (await res.text()).slice(0, 160));
  const d = await res.json();
  return (d.results || []).map((r: any) => ({ url: String(r.url || ""), title: clip(r.title, 200), snippet: clip(r.content, 500), engine: "tavily" }));
}

// Gemini with Google Search grounding. Only addresses that Google actually returned (the
// grounding sources, resolved from Google's redirect links) are kept, so nothing the model
// might make up gets through.
const geminiModel = () => env("XRAY_GEMINI_MODEL") || env("GEMINI_MODEL") || "gemini-3.8-flash";
const geminiOn = () => !!env("GEMINI_API_KEY") && geminiModel().toLowerCase() !== "off";
async function gemini(q: string, modelOverride = ""): Promise<Hit[]> {
  const model = modelOverride || geminiModel();
  const prompt = "Use Google Search to run exactly this search query and report the results it returns. Do not add anything that is not in the results.\n" +
    `Query: ${q}\n` +
    "Reply with STRICT JSON only: {\"results\": [{\"url\": string, \"title\": string, \"snippet\": string}]} with every individual person's profile page found (up to 20).";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env("GEMINI_API_KEY") },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0 } }),
    signal: AbortSignal.timeout(45000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Gemini " + res.status + ": " + String(d?.error?.message || "").slice(0, 160));
  const cand = d.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
  let said: any[] = [];
  try { const m = text.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/); said = m ? (JSON.parse(m[0]).results || []) : []; } catch { said = []; }
  const chunks: any[] = (cand?.groundingMetadata?.groundingChunks || []).map((c: any) => c?.web).filter((w: any) => w?.uri).slice(0, 25);
  const real: string[] = [];
  await Promise.all(chunks.map(async (w: any) => {
    let url = String(w.uri);
    if (/grounding-api-redirect/.test(url)) {
      try { const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000) }); url = r.headers.get("location") || ""; await r.body?.cancel(); } catch { url = ""; }
    }
    if (url) real.push(url);
  }));
  const realKeys = new Map(real.map((u) => [profileOf(u)?.key || u, u]));
  const out: Hit[] = [];
  const used = new Set<string>();
  for (const r of said) {
    const k = profileOf(String(r?.url || ""))?.key;
    if (k && realKeys.has(k) && !used.has(k)) { used.add(k); out.push({ url: k, title: clip(r.title, 200), snippet: clip(r.snippet, 500), engine: "gemini" }); }
  }
  // Grounding sources the model didn't describe still count, with what little Google gave.
  for (const [k, u] of realKeys) if (!used.has(k) && profileOf(u)) { used.add(k); out.push({ url: u, title: "", snippet: "", engine: "gemini" }); }
  return out;
}

function engines(): Engine[] {
  return [
    { name: "tavily", key: env("TAVILY_API_KEY"), period: "month" as const, limit: limitOf("TAVILY_FREE_LIMIT", 950), run: tavily },
    { name: "brave", key: env("BRAVE_API_KEY"), period: "month" as const, limit: limitOf("BRAVE_FREE_LIMIT", 950), run: brave },
    { name: "gemini", key: geminiOn() ? env("GEMINI_API_KEY") : "", period: "day" as const, limit: limitOf("GEMINI_FREE_LIMIT", 400), run: gemini },
    { name: "serper", key: env("SERPER_API_KEY"), period: "total" as const, limit: limitOf("SERPER_FREE_LIMIT", 2400), run: serper },
  ].filter((e) => e.key);
}

export function searchEngines() {
  return { serper: !!env("SERPER_API_KEY"), brave: !!env("BRAVE_API_KEY"), tavily: !!env("TAVILY_API_KEY"), gemini: geminiOn(), github: !!env("GITHUB_TOKEN") };
}

// Current use against each engine's free allowance (for Outreach > Setup and the run summary).
export async function searchUsage(admin: any) {
  const out: Record<string, { used: number; limit: number; per: string }> = {};
  for (const e of engines()) {
    const { data } = await admin.from("search_usage").select("used").eq("provider", e.name).eq("period", periodKey(e.period)).maybeSingle();
    out[e.name] = { used: Number(data?.used || 0), limit: e.limit, per: e.period };
  }
  return out;
}

// One search through the first engine with a key and free allowance left. When it finds no
// profiles, the same search goes to the next engine (different indexes find different people).
export async function searchWeb(admin: any, q: string, skip: Set<string> = new Set()): Promise<{ hits: Hit[]; engine: string | null; errors: string[] }> {
  const errors: string[] = [];
  let empty: { hits: Hit[]; engine: string } | null = null;
  for (const e of engines()) {
    if (skip.has(e.name)) continue;
    const { data: ok } = await admin.rpc("use_search_quota", { p_provider: e.name, p_period: periodKey(e.period), p_limit: e.limit });
    if (!ok) { skip.add(e.name); errors.push(e.name + ": free allowance used up"); continue; }
    try {
      const hits = await e.run(q);
      if (hits.some((h) => profileOf(h.url))) return { hits, engine: e.name, errors };
      empty = empty || { hits, engine: e.name };
      continue;
    }
    catch (err) {
      const msg = String((err as Error)?.message || err);
      errors.push(msg.slice(0, 200));
      console.error("search", e.name, msg.slice(0, 200));
      // A bad key or an exhausted plan won't recover within this run.
      if (/\b(401|402|403|429|432|433)\b/.test(msg)) skip.add(e.name);
    }
  }
  return empty ? { ...empty, errors } : { hits: [], engine: null, errors };
}

// Tests every connected engine with one real search (one credit each) and reports what came back.
export async function checkEngines(admin: any, q = "site:linkedin.com/in recruiter Lagos Nigeria", only = "", models: string[] = []) {
  const out: Record<string, unknown>[] = [];
  // Try named Gemini models (to find one with Google Search allowance left on this key).
  for (const m of models.slice(0, 4)) {
    try { const hits = await gemini(q, m); out.push({ engine: "gemini:" + m, ok: true, results: hits.length, profiles: hits.filter((h) => profileOf(h.url)).length, sample: hits.slice(0, 3).map((h) => h.url) }); }
    catch (err) { out.push({ engine: "gemini:" + m, ok: false, error: String((err as Error)?.message || err).slice(0, 200) }); }
  }
  if (models.length) return { connected: searchEngines(), geminiModel: geminiOn() ? geminiModel() : null, results: out };
  for (const e of engines()) {
    if (only && e.name !== only) continue;
    const { data: ok } = await admin.rpc("use_search_quota", { p_provider: e.name, p_period: periodKey(e.period), p_limit: e.limit });
    if (!ok) { out.push({ engine: e.name, ok: false, error: "free allowance used up" }); continue; }
    try {
      const hits = await e.run(q);
      out.push({ engine: e.name, ok: true, results: hits.length, profiles: hits.filter((h) => profileOf(h.url)).length, sample: hits.slice(0, 3).map((h) => h.url) });
    } catch (err) { out.push({ engine: e.name, ok: false, error: String((err as Error)?.message || err).slice(0, 200) }); }
  }
  return { connected: searchEngines(), geminiModel: geminiOn() ? geminiModel() : null, usage: await searchUsage(admin), results: out };
}

// GitHub's own user search (free), tightened for technical roles:
//   - up to 3 places (office city first, then nearby cities; the country for remote roles) x up to 2
//     languages, at most 4 searches, merged in turn so every place gets a share
//   - real working developers, not celebrities or empty accounts: 3 to 3,000 followers, 5+ public repos
//   - with a GITHUB_TOKEN, their own most recently pushed repositories are read: anyone who hasn't
//     pushed code in 12 months is left out, and what they build (repos, languages, topics, last push)
//     goes into the snippet the AI reviews, so skills are judged on their code, not just their bio.
//   - with topics (the role's work, e.g. 'sigma', 'yara', 'threat-hunting' for a SOC role): only people
//     with at least one repository of their own about that work are kept (name, description or topics),
//     so a security role gets security people, not every developer in the city. More people are
//     scanned (repos first, one request each), and the profile is read only for those who match.
// Without a token GitHub allows 60 requests an hour, so fewer profiles are read, repos aren't, and
// topics can't be checked.
export type GithubPlan = { location?: string; locations?: string[]; language?: string; languages?: string[]; topics?: string[]; keywords?: string };
const STALE_MONTHS = 12;
const norm = (t: unknown) => String(t || "").toLowerCase().replace(/[_\s]+/g, "-");
// Text as space-separated words, so a topic only matches whole words ("soc" never matches "social").
const words = (t: unknown) => " " + String(t || "").toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim() + " ";
const hasTopic = (text: string, topic: string) => text.includes(words(topic));
const GQL = `query($q: String!, $after: String) { search(query: $q, type: USER, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on User {
  login name bio company location url websiteUrl isHireable followers { totalCount }
  repositories(first: 20, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, orderBy: { field: PUSHED_AT, direction: DESC }) { totalCount nodes {
    name description pushedAt stargazerCount primaryLanguage { name } repositoryTopics(first: 6) { nodes { topic { name } } } } } } } } }`;
async function githubTopicScan(headers: Record<string, string>, places: string[], topics: string[], max: number): Promise<Hit[] | null> {
  const cutoff = Date.now() - STALE_MONTHS * 30 * 864e5;
  const found: { score: number; hit: Hit }[] = [];
  const seen = new Set<string>();
  let pages = 0;
  for (const place of places.length ? places : [""]) {
    let after: string | null = null;
    for (let page = 0; page < 6 && pages < 12; page++, pages++) {
      const q = [place ? `location:"${place.replace(/"/g, "")}"` : "", "type:user", "followers:>=1", "repos:>=3"].filter(Boolean).join(" ");
      const res = await fetch("https://api.github.com/graphql", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ query: GQL, variables: { q, after } }), signal: AbortSignal.timeout(30000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.errors) { if (!found.length && !pages) throw new Error("GraphQL " + res.status + ": " + JSON.stringify(j.errors || j).slice(0, 160)); break; }
      const sr = j.data?.search;
      for (const u of sr?.nodes || []) {
        if (!u?.login || seen.has(u.login)) continue;
        seen.add(u.login);
        const repos: any[] = u.repositories?.nodes || [];
        const last = repos.map((x: any) => Date.parse(x.pushedAt || "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
        if (!last || last < cutoff) continue;   // no code pushed in the last 12 months
        const topicsOf = (x: any) => (x.repositoryTopics?.nodes || []).map((n: any) => n?.topic?.name).filter(Boolean);
        const about = (x: any) => words([x.name, x.description, ...topicsOf(x)].join(" "));
        const bio = words([u.bio, u.company].join(" "));
        const bioHits = topics.filter((t) => hasTopic(bio, t));
        const repoHits = repos.filter((x: any) => topics.some((t) => hasTopic(about(x), t)));
        if (!bioHits.length && !repoHits.length) continue;   // nothing about this role's work
        const matched = [...new Set([...bioHits, ...repoHits.flatMap((x: any) => topics.filter((t) => hasTopic(about(x), t)))])];
        const tally: Record<string, number> = {};
        for (const x of repos) if (x.primaryLanguage?.name) tally[x.primaryLanguage.name] = (tally[x.primaryLanguage.name] || 0) + 1;
        const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
        const show = [...repoHits, ...repos.filter((x: any) => !repoHits.includes(x))].slice(0, 4);
        const recent = show.map((x: any) => `${x.name}${x.primaryLanguage?.name ? " (" + x.primaryLanguage.name + ")" : ""}${topicsOf(x).length ? " [" + topicsOf(x).slice(0, 3).join(", ") + "]" : ""}${x.description ? ": " + clip(x.description, 70) : ""}${x.stargazerCount ? " " + x.stargazerCount + "★" : ""}`);
        const work = [matched.length ? "Work on GitHub matching the role: " + matched.join(", ") : "", top.length ? "Languages: " + top.join(", ") : "", recent.length ? "Repos: " + recent.join("; ") : "", "Last pushed code: " + new Date(last).toISOString().slice(0, 7)].filter(Boolean).join(" | ");
        // Their bio saying so counts most, then how many of their own repositories are about the work.
        found.push({ score: bioHits.length * 3 + repoHits.length + matched.length, hit: {
          url: String(u.url || "https://github.com/" + u.login), engine: "github",
          title: clip(`${u.name || u.login} (${u.login}) · GitHub`, 200),
          snippet: clip([u.bio, u.company ? "Company: " + u.company : "", u.location ? "Location: " + u.location : "", work, `${u.repositories?.totalCount ?? repos.length} public repos, ${u.followers?.totalCount ?? 0} followers`, u.isHireable ? "Open to work (hireable)" : "", u.websiteUrl ? "Site: " + u.websiteUrl : ""].filter(Boolean).join(" | "), 800),
        } });
      }
      if (!sr?.pageInfo?.hasNextPage) break;
      after = sr.pageInfo.endCursor;
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.hit);
}

export async function githubUsers(p: GithubPlan, max = 30): Promise<Hit[]> {
  const token = env("GITHUB_TOKEN");
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "ProNext-sourcing", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: "Bearer " + token } : {}) };
  const quote = (s: string) => /\s/.test(s) ? `"${s.replace(/"/g, "")}"` : s;
  const uniq = (xs: unknown[], n: number, len: number) => [...new Set(xs.map((x) => clip(x, len)).filter(Boolean))].slice(0, n);
  const places = uniq([...(Array.isArray(p.locations) ? p.locations : []), p.location], 3, 60);
  const langs = uniq([...(Array.isArray(p.languages) ? p.languages : []), p.language], 2, 30);
  const topics = token ? uniq(Array.isArray(p.topics) ? p.topics : [], 8, 40).map(norm).filter((t) => t.length > 1) : [];
  const byTopic = topics.length > 0;
  // With a token and topics: GitHub's GraphQL search reads 100 people a page with their bio and their
  // own recent repositories in one request, so up to 1,000 people are scanned for the role's work
  // (bio or repositories). If it fails, the REST scan below is used instead.
  if (byTopic) {
    try { const g = await githubTopicScan(headers, places, topics, max); if (g) return g; }
    catch (e) { console.error("github graphql", String((e as Error)?.message || e).slice(0, 200)); }
  }
  const combos: { place: string; lang: string }[] = [];
  // A topic search casts a wider net (no language filter), then keeps only people whose work matches.
  for (const place of places.length ? places : [""]) for (const lang of byTopic || !langs.length ? [""] : langs) combos.push({ place, lang });
  const searches = combos.slice(0, 4);
  const perSearch = byTopic ? 100 : 40;
  // Logins from each search, taken in turn so no single place or language crowds the others out.
  const lists: string[][] = [];
  for (const c of searches) {
    const q = [clip(p.keywords, 80), c.place ? "location:" + quote(c.place) : "", c.lang ? "language:" + quote(c.lang) : "", "type:user", "followers:3..3000", byTopic ? "repos:>=3" : "repos:>=5"].filter(Boolean).join(" ");
    const res = await fetch(`https://api.github.com/search/users?per_page=${perSearch}&sort=followers&q=` + encodeURIComponent(q), { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) { if (!lists.length && [401, 403, 422, 429].includes(res.status)) throw new Error("GitHub " + res.status + ": " + (await res.text()).slice(0, 160)); break; }
    lists.push(((await res.json()).items || []).map((it: any) => String(it.login || "")).filter(Boolean));
  }
  const order: string[] = [];
  for (let i = 0; i < perSearch; i++) for (const l of lists) if (l[i] && !order.includes(l[i])) order.push(l[i]);
  const read = token ? max : Math.min(max, 8);
  const cutoff = Date.now() - STALE_MONTHS * 30 * 864e5;
  // What someone builds, from their own repositories (most recently pushed first). null = skip them.
  const workOf = async (login: string): Promise<{ text: string; matched: string[] } | null | "limit"> => {
    const rr = await fetch("https://api.github.com/users/" + encodeURIComponent(login) + `/repos?type=owner&sort=pushed&per_page=${byTopic ? 30 : 10}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!rr.ok) return [403, 429].includes(rr.status) ? "limit" : null;
    const repos: any[] = ((await rr.json()) || []).filter((x: any) => !x.fork);
    const last = repos.map((x: any) => Date.parse(x.pushed_at || "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (!last || last < cutoff) return null;   // no code pushed in the last 12 months
    const about = (x: any) => words([x.name, x.description, ...(Array.isArray(x.topics) ? x.topics : [])].join(" "));
    const hits = byTopic ? repos.filter((x: any) => { const a = about(x); return topics.some((t) => hasTopic(a, t)); }) : [];
    if (byTopic && !hits.length) return null;   // nothing of their own about this role's work
    const matched = [...new Set(hits.flatMap((x: any) => topics.filter((t) => hasTopic(about(x), t))))];
    const tally: Record<string, number> = {};
    for (const x of repos) if (x.language) tally[x.language] = (tally[x.language] || 0) + 1;
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
    const show = [...hits, ...repos.filter((x: any) => !hits.includes(x))].slice(0, 4);
    const recent = show.map((x: any) => `${x.name}${x.language ? " (" + x.language + ")" : ""}${Array.isArray(x.topics) && x.topics.length ? " [" + x.topics.slice(0, 3).join(", ") + "]" : ""}${x.description ? ": " + clip(x.description, 70) : ""}${x.stargazers_count ? " " + x.stargazers_count + "★" : ""}`);
    return { matched, text: [matched.length ? "Work on GitHub matching the role: " + matched.join(", ") : "", top.length ? "Languages: " + top.join(", ") : "", recent.length ? (byTopic ? "Repos: " : "Recent repos: ") + recent.join("; ") : "", "Last pushed code: " + new Date(last).toISOString().slice(0, 7)].filter(Boolean).join(" | ") };
  };
  const out: Hit[] = [];
  let stop = false;
  // Topic searches scan more people, a few at a time; plain searches go one by one as before.
  const scan = byTopic ? order.slice(0, 150) : order;
  const batch = byTopic ? 6 : 1;
  for (let i = 0; i < scan.length && out.length < read && !stop; i += batch) {
    const group = scan.slice(i, i + batch);
    const works = token ? await Promise.all(group.map((l) => workOf(l).catch(() => null))) : group.map(() => ({ text: "", matched: [] as string[] }));
    for (let k = 0; k < group.length && out.length < read; k++) {
      const w = works[k];
      if (w === "limit") { stop = true; break; }
      if (!w) continue;
      const r = await fetch("https://api.github.com/users/" + encodeURIComponent(group[k]), { headers, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { if ([403, 429].includes(r.status)) { stop = true; break; } continue; }
      const u = await r.json();
      if (u.type && u.type !== "User") continue;
      out.push({
        url: String(u.html_url || "https://github.com/" + group[k]), engine: "github",
        title: clip(`${u.name || u.login} (${u.login}) · GitHub`, 200),
        snippet: clip([u.bio, u.company ? "Company: " + u.company : "", u.location ? "Location: " + u.location : "", w.text, `${u.public_repos} public repos, ${u.followers} followers`, u.hireable ? "Open to work (hireable)" : "", u.blog ? "Site: " + u.blog : ""].filter(Boolean).join(" | "), 800),
      });
    }
  }
  return out;
}
