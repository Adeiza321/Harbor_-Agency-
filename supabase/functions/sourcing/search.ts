// Free search engines for X-ray sourcing. Each engine is used only while its key exists and
// only inside its free allowance (counted in public.search_usage), so nothing is ever charged:
//   Serper.dev  real Google results           SERPER_API_KEY   one-time free allowance (2,500)
//   Brave       Brave's own index             BRAVE_API_KEY    monthly free credit (~1,000)
//   Tavily      AI search API                 TAVILY_API_KEY   1,000 free credits a month
//   Gemini      Google Search grounding       GEMINI_API_KEY + XRAY_GEMINI_MODEL (opt-in: off unless the
//               model is named, because grounding on current Gemini models may be billed)
//   GitHub      user search (technical roles) GITHUB_TOKEN optional (more profiles per run)
// The allowances can be lowered (or raised, if a paid plan is added later) with SERPER_FREE_LIMIT,
// BRAVE_FREE_LIMIT, TAVILY_FREE_LIMIT and GEMINI_FREE_LIMIT.
// Order: allowances that reset every month (Tavily, Brave) are spent first, because what isn't used
// by the end of the month is lost; Serper's one-time allowance is kept for when they run out or
// find nothing; Gemini last. A search that fails, or finds no profiles, is tried on the next engine.
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

// Tavily takes the site as a domain filter rather than a site: operator.
async function tavily(q: string): Promise<Hit[]> {
  const site = q.match(/site:(\S+)/i)?.[1] || "";
  const domain = site.split("/")[0];
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST", headers: { Authorization: "Bearer " + env("TAVILY_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ query: q.replace(/site:\S+/gi, " ").replace(/\s+/g, " ").trim().slice(0, 390), search_depth: "basic", max_results: 20, ...(domain ? { include_domains: [domain] } : {}) }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error("Tavily " + res.status + ": " + (await res.text()).slice(0, 160));
  const d = await res.json();
  return (d.results || []).map((r: any) => ({ url: String(r.url || ""), title: clip(r.title, 200), snippet: clip(r.content, 500), engine: "tavily" }));
}

// Gemini with Google Search grounding. Only addresses that Google actually returned (the
// grounding sources, resolved from Google's redirect links) are kept, so nothing the model
// might make up gets through.
async function gemini(q: string): Promise<Hit[]> {
  const model = env("XRAY_GEMINI_MODEL");
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
    { name: "serper", key: env("SERPER_API_KEY"), period: "total" as const, limit: limitOf("SERPER_FREE_LIMIT", 2400), run: serper },
    { name: "gemini", key: env("XRAY_GEMINI_MODEL") ? env("GEMINI_API_KEY") : "", period: "day" as const, limit: limitOf("GEMINI_FREE_LIMIT", 400), run: gemini },
  ].filter((e) => e.key);
}

export function searchEngines() {
  return { serper: !!env("SERPER_API_KEY"), brave: !!env("BRAVE_API_KEY"), tavily: !!env("TAVILY_API_KEY"), gemini: !!(env("GEMINI_API_KEY") && env("XRAY_GEMINI_MODEL")), github: !!env("GITHUB_TOKEN") };
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
export async function checkEngines(admin: any, q = "site:linkedin.com/in recruiter Lagos Nigeria") {
  const out: Record<string, unknown>[] = [];
  for (const e of engines()) {
    const { data: ok } = await admin.rpc("use_search_quota", { p_provider: e.name, p_period: periodKey(e.period), p_limit: e.limit });
    if (!ok) { out.push({ engine: e.name, ok: false, error: "free allowance used up" }); continue; }
    try {
      const hits = await e.run(q);
      out.push({ engine: e.name, ok: true, results: hits.length, profiles: hits.filter((h) => profileOf(h.url)).length, sample: hits.slice(0, 3).map((h) => h.url) });
    } catch (err) { out.push({ engine: e.name, ok: false, error: String((err as Error)?.message || err).slice(0, 200) }); }
  }
  return { connected: searchEngines(), usage: await searchUsage(admin), results: out };
}

// GitHub's own user search (free): people in the area who code in the role's main language.
// Each profile is then read for name, bio, employer and location. Without a token GitHub allows
// 60 requests an hour, so fewer profiles are read.
export async function githubUsers(p: { location?: string; language?: string; keywords?: string }, max = 30): Promise<Hit[]> {
  const token = env("GITHUB_TOKEN");
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "ProNext-sourcing", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: "Bearer " + token } : {}) };
  const quote = (s: string) => /\s/.test(s) ? `"${s.replace(/"/g, "")}"` : s;
  const q = [clip(p.keywords, 80), p.location ? "location:" + quote(clip(p.location, 60)) : "", p.language ? "language:" + quote(clip(p.language, 30)) : "", "type:user", "followers:>=5"].filter(Boolean).join(" ");
  const res = await fetch("https://api.github.com/search/users?per_page=50&sort=followers&q=" + encodeURIComponent(q), { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error("GitHub " + res.status + ": " + (await res.text()).slice(0, 160));
  const items: any[] = (await res.json()).items || [];
  const n = Math.min(items.length, token ? max : Math.min(max, 12));
  const out: Hit[] = [];
  for (const it of items.slice(0, n)) {
    const r = await fetch("https://api.github.com/users/" + encodeURIComponent(it.login), { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) { if ([403, 429].includes(r.status)) break; continue; }
    const u = await r.json();
    out.push({
      url: String(u.html_url || "https://github.com/" + it.login), engine: "github",
      title: clip(`${u.name || u.login} (${u.login}) · GitHub`, 200),
      snippet: clip([u.bio, u.company ? "Company: " + u.company : "", u.location ? "Location: " + u.location : "", `${u.public_repos} public repos, ${u.followers} followers`, u.hireable ? "Open to work (hireable)" : "", u.blog ? "Site: " + u.blog : ""].filter(Boolean).join(" | "), 500),
    });
  }
  return out;
}
