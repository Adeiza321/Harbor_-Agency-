// X-ray sourcing: free searches for public profiles, reviewed against the job.
//   1. The AI plans the searches from the job: LinkedIn X-ray queries (titles, key must-haves and
//      the job's search area), plus GitHub and technical sites for technical roles; and a short
//      checklist of the job's must-haves (with this role's lessons from past rejections).
//   2. The searches run through the free engines (search.ts), never past a free allowance.
//   3. People already on this job, already in ProNext, or working for the client are dropped.
//   4. The AI reviews each search result (title and snippet only): a short overview, the checklist
//      marked met / unconfirmed / not met, the gaps, and a fit score.
//   5. The best (up to Settings.xrayPerJob) are saved as prospects next to Apollo's, tagged with
//      where they were found, without an email. GitHub public emails are added straight away (free);
//      LinkedIn people's emails are looked up in Apollo automatically, within a daily limit (emails.ts).
// No credits are spent. The run is recorded on jobs.xray.

import { askAI } from "./ai.ts";
import { jobBrief, searchArea } from "./prospects.ts";
import { COUNTRY_NAMES, jobCountryNames } from "./regions.ts";
import { fitsToPercent, sameCompany, type Settings } from "./common.ts";
import { findGithubEmails } from "./emails.ts";
import { SITES, githubUsers, profileOf, searchEngines, searchUsage, searchWeb, type Hit, type SiteKey } from "./search.ts";

const errMsg = (e: unknown) => String((e as Error)?.message || e);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const MAX_QUERIES = 12;

async function setXray(admin: any, jobId: string, xray: Record<string, unknown>) {
  await admin.from("jobs").update({ xray: { ...xray, at: new Date().toISOString() } }).eq("id", jobId);
}

// Starts a run in the background (the caller gets an answer straight away). A run already going
// for this job is left alone unless it has been stuck for over 6 minutes.
export async function startXray(admin: any, jobId: string, s: Settings, by: string | null = null) {
  const { data: job } = await admin.from("jobs").select("id,xray").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, message: "Job not found" };
  const e = searchEngines();
  if (!e.serper && !e.brave && !e.tavily && !e.gemini) return { ok: false, notConnected: "search", message: "No free search engine is connected yet. Add a SERPER_API_KEY, BRAVE_API_KEY or TAVILY_API_KEY secret in Supabase." };
  const x = job.xray || {};
  if (x.state === "running" && Date.now() - new Date(x.at || 0).getTime() < 6 * 60e3) return { ok: true, running: true, message: "The X-ray search is already running for this job." };
  await setXray(admin, jobId, { state: "running", by });
  const work = runXray(admin, jobId, s).catch(async (err) => {
    console.error("xray", jobId, errMsg(err));
    await setXray(admin, jobId, { state: "error", error: errMsg(err).slice(0, 300) });
  });
  // @ts-ignore EdgeRuntime is provided by Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return { ok: true, started: true, message: "X-ray search started. Results appear under this job in a minute or two." };
}

type Plan = { technical: boolean; checklist: string[]; linkedin: string[]; sites: { site: SiteKey; query: string }[]; github: { location?: string; language?: string; keywords?: string } | null };

async function plan(job: any, area: any, lessons: string[], titles: string[]): Promise<Plan> {
  const siteList = (Object.keys(SITES) as SiteKey[]).filter((k) => k !== "linkedin").map((k) => `${k} (${SITES[k].label}, query starts "${SITES[k].prefix}")`).join("; ");
  const sys = "You are an expert technical and executive sourcer who writes Google X-ray searches to find people's public profiles for one job. Reply with STRICT JSON only: " +
    "{\"technical\": boolean, \"checklist\": string[], \"linkedin\": string[], \"sites\": [{\"site\": string, \"query\": string}], \"github\": {\"location\": string, \"language\": string, \"keywords\": string} | null}. " +
    "checklist: 5 to 8 of the job's most important must-haves, each a few words that a profile headline or summary could show (e.g. '8+ yrs technical accounting', 'Big 4 Advisory background', 'Senior Manager level', 'Based in Pacific or Mountain time zone'). Always include the seniority/title level and the location requirement. Add the lessons from past candidates when they apply. " +
    "linkedin: 4 to 8 search queries. Each MUST start with site:linkedin.com/in, then an OR group of 2 to 4 title variants in double quotes (the job title and its parallel titles, as people write them in headlines), " +
    "then at most 2 must-have terms in double quotes that people actually write in a headline or summary: a core skill, tool, standard or certification (e.g. \"ServiceNow\", \"ASC 606\", \"CPA\"); never years, numbers or phrases like \"5 years\" or \"senior level\", then an OR group of up to 4 locations in double quotes taken from the search area, and finally -jobs -hiring -recruiter. " +
    "Keep each under 30 words. Spread the locations of the search area across the queries so together they cover it, and vary the title groups and terms so the queries don't repeat each other. Never include the hiring company's name. Use Google syntax: \"A\" OR \"B\" inside parentheses. " +
    "technical: true for software, data, IT, engineering, security, DevOps, ML/AI, product design and similar roles. " +
    `sites: only when technical (otherwise []): up to 4 queries on the sites that suit this role, from: ${siteList}. Each query starts with that site's prefix, then quoted skills/titles and a location term; under 25 words. ` +
    "github: only when technical and code matters for the role (otherwise null): location = the main city or country to search, language = the role's main programming language as GitHub names it (e.g. 'Python', 'TypeScript', 'Go'), keywords = 0 to 2 plain words likely in names or profiles (usually '').";
  const text = jobBrief(job, false) +
    `\n\nParallel titles: ${titles.join("; ") || "(none)"}` +
    `\nSearch area: ${area?.summary || job.location || job.country || "(not set)"}` +
    (area?.locations?.length ? `\nPlaces in the search area: ${area.locations.slice(0, 40).join("; ")}` : "") +
    (lessons.length ? `\n\nLessons from past candidates for this role (add as checklist items when they apply):\n${lessons.map((l) => "- " + l).join("\n")}` : "");
  const out = await askAI(sys, text, 3000);
  const fix = (q: unknown, prefix: string) => {
    let s = clip(q, 400).replace(/\bsite:\S+/gi, "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    s = `${prefix} ${s}`;
    return s.split(" ").slice(0, 34).join(" ");
  };
  const sites = (Array.isArray(out?.sites) ? out.sites : [])
    .filter((x: any) => x && SITES[x.site as SiteKey] && x.site !== "linkedin")
    .map((x: any) => ({ site: x.site as SiteKey, query: fix(x.query, SITES[x.site as SiteKey].prefix) })).filter((x: any) => x.query).slice(0, 4);
  return {
    technical: !!out?.technical,
    checklist: [...new Set((Array.isArray(out?.checklist) ? out.checklist : []).map((c: unknown) => clip(c, 80)).filter(Boolean))].slice(0, 8) as string[],
    linkedin: [...new Set((Array.isArray(out?.linkedin) ? out.linkedin : []).map((q: unknown) => fix(q, SITES.linkedin.prefix)).filter(Boolean))].slice(0, 8) as string[],
    sites: out?.technical ? sites : [],
    github: out?.technical && out?.github && (out.github.location || out.github.language) ? out.github : null,
  };
}

type Person = Hit & { key: string; site: SiteKey; query: string };

export async function runXray(admin: any, jobId: string, s: Settings) {
  const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).single();
  if (!job) throw new Error("Job not found");
  // Searched where the job is (its own country), like every other outside search.
  const area = await searchArea(admin, job, jobCountryNames(job));
  const titles = [...new Set([job.role_title, ...(Array.isArray(job.parallel_titles) ? job.parallel_titles : [])].filter(Boolean))].slice(0, 8) as string[];
  const { data: ls } = await admin.from("screening_lessons").select("lesson,kind").eq("job_id", jobId).eq("active", true).in("kind", ["client_reject", "internal_reject"]).limit(6);
  const p = await plan(job, area, (ls || []).map((l: any) => l.lesson), titles);
  if (!p.linkedin.length && !p.sites.length && !p.github) throw new Error("The AI couldn't write searches for this job");

  // 2. Search, until there are enough new people to choose from.
  const perJob = s.xrayPerJob;
  const want = Math.min(perJob * 2, 90);
  const { data: existing } = await admin.from("prospects").select("external_id").eq("job_id", jobId);
  const seen = new Set((existing || []).map((x: any) => String(x.external_id || "")));
  const { data: cands } = await admin.from("candidates").select("linkedin_url").not("linkedin_url", "is", null);
  const inPronext = new Set((cands || []).map((c: any) => profileOf(c.linkedin_url)?.key).filter(Boolean));
  const people = new Map<string, Person>();
  const used: Record<string, number> = {};
  const errors: string[] = [];
  const skip = new Set<string>();
  let dropped = 0, searched = 0;
  const add = (h: Hit, query: string) => {
    const pr = profileOf(h.url);
    if (!pr) return;
    if (seen.has(pr.key) || inPronext.has(pr.key)) { dropped++; return; }
    const cur = people.get(pr.key);
    if (cur) { if (!cur.snippet && h.snippet) people.set(pr.key, { ...cur, ...h, url: pr.key, key: pr.key, site: pr.site, query }); return; }
    people.set(pr.key, { ...h, url: pr.key, key: pr.key, site: pr.site, query });
  };
  const queries = [...p.linkedin.map((q) => ({ q, site: "linkedin" as SiteKey })), ...p.sites.map((x) => ({ q: x.query, site: x.site }))].slice(0, MAX_QUERIES);
  // LinkedIn first, then the technical sites; stop early once there are plenty.
  for (const { q } of queries) {
    if (people.size >= want) break;
    const r = await searchWeb(admin, q, skip);
    errors.push(...r.errors);
    if (!r.engine) { if (skip.size >= 4) break; continue; }
    searched++;
    used[r.engine] = (used[r.engine] || 0) + 1;
    for (const h of r.hits) add(h, q);
  }
  if (p.github && people.size < want) {
    try {
      const hits = await githubUsers(p.github, 30);
      used.github = (used.github || 0) + 1;
      for (const h of hits) add(h, `GitHub users: ${[p.github.keywords, p.github.location, p.github.language].filter(Boolean).join(", ")}`);
    } catch (e) { errors.push(errMsg(e).slice(0, 200)); }
  }
  if (!people.size) {
    const why = searched ? `The searches found nobody new (${dropped} already on this job or in ProNext).` : "No search could run: " + ([...new Set(errors)].join("; ") || "no engine available");
    await setXray(admin, jobId, { state: "done", found: 0, searched, used, technical: p.technical, checklist: p.checklist, queries: queries.map((x) => x.q), note: why });
    return { ok: true, found: 0, message: why };
  }

  // 4. Review what each result shows, in batches (two at a time).
  const list = [...people.values()].slice(0, Math.min(people.size, perJob + 15));
  const sys = "You are a recruitment researcher reviewing search-engine results for people's public profiles (LinkedIn and technical sites) against one job. " +
    "You only see each result's title line and short snippet, not the full profile. Reply with STRICT JSON only: " +
    "{\"people\": [{\"i\": number, \"name\": string, \"headline\": string, \"company\": string, \"location\": string, \"client_history\": \"current\" | \"past\" | \"none\", \"business\": boolean, \"overview\": string, \"checklist\": [{\"item\": string, \"status\": \"met\" | \"unconfirmed\" | \"not met\", \"evidence\": string}], \"gaps\": string[], \"fit\": number, \"verdict\": \"Good fit\" | \"Possible fit\" | \"Not a fit\"}]}, one entry per person. " +
    "name, headline (their current title) and company (current employer) come ONLY from the result ('' when not shown). " +
    "location: where they live or work NOW: the 'Location:' part of a LinkedIn snippet, or the place shown next to their current role. Never a past job's city, a school, or an employer's head office; '' when not shown. " +
    "client_history: 'current' when the result shows them working at the hiring company now, 'past' when it shows they worked there before, otherwise 'none'. " +
    "business: true when the result is a business, company, agency, brand or group page rather than one person, or when the person runs their own business (founder, co-founder, owner, CEO / managing director of their own company, self-employed agency owner); otherwise false. " +
    "overview: 1 to 2 short sentences on what the result shows about them that matters for this job. " +
    "checklist: exactly the job's checklist items given, in the same order and wording. 'met' only when the result clearly shows it; 'not met' only when the result clearly contradicts it (based somewhere else, a different field, clearly more junior or senior); otherwise 'unconfirmed'. evidence: a few words from the result, '' if none. " +
    "gaps: up to 4 short items: what is 'not met' first, then the most important 'unconfirmed' must-haves to check with them. " +
    "fit: a percentage from 0 to 100 (never a 0-10 score) for how promising they are to approach: matching title, seniority and field count most; each 'unconfirmed' item lowers it a little, each 'not met' a lot. " +
    "verdict: 'Good fit' only when title, seniority and field match, at least half the checklist is 'met' and nothing is 'not met'. 'Not a fit' when any of the first three checklist items (the core must-haves) is 'not met', when the field, level or title clearly doesn't match, when their current location is outside the search area, when they work for the hiring company now, or when business is true. Otherwise 'Possible fit'. " +
    "A search result can never prove everything, so never say 'Perfect fit'. For a GitHub result, judge technical skills from their bio, languages, repositories and followers.";
  const head = jobBrief(job, false) + `\nHiring company (people who work there now are 'Not a fit'): ${job.client || "(not given)"}` +
    `\nSearch area (where candidates must be based now): ${area?.summary || job.location || job.country || "(not set)"}` +
    `\n\nJob checklist:\n${p.checklist.map((c) => "- " + c).join("\n")}\n\nPeople (i | site | result title | snippet):\n`;
  const byKey = new Map<string, any>();
  const batches: Person[][] = [];
  for (let i = 0; i < list.length; i += 10) batches.push(list.slice(i, i + 10));
  const review = async (b: Person[]) => {
    const out = await askAI(sys, head + b.map((x, i) => `${i} | ${SITES[x.site].label} | ${x.title || "(no title)"} | ${x.snippet || "(no snippet)"} | ${x.url}`).join("\n"), 6000);
    for (const r of fitsToPercent(Array.isArray(out?.people) ? out.people : [])) { const who = b[Number(r.i)]; if (who) byKey.set(who.key, r); }
  };
  for (let i = 0; i < batches.length; i += 2) {
    const res = await Promise.allSettled(batches.slice(i, i + 2).map(review));
    for (const r of res) if (r.status === "rejected") errors.push(errMsg(r.reason).slice(0, 200));
  }

  // 5. Keep the best and save them next to Apollo's prospects. Checked here as well as by the AI:
  //    their CURRENT location is in the search area (read from the result's "Location:" line when it
  //    has one), the core must-haves aren't contradicted and at least one is shown, they don't work
  //    at the hiring company now, and they're a person, not a business or a business owner.
  // Someone is dropped only when their location clearly names a different country from the role's;
  // a place we can't place (a city, "Greater ... Area") is kept and shown as not confirmed.
  const allowed = new Set(jobCountryNames(job).map((x) => String(x || "").toLowerCase().trim()).filter(Boolean));
  const ALIAS: Record<string, string> = { "usa": "united states", "u.s.": "united states", "uk": "united kingdom", "england": "united kingdom", "scotland": "united kingdom", "wales": "united kingdom", "uae": "united arab emirates" };
  // Longest names first and whole words only, so "Nigeria" isn't read as "Niger".
  const countries = [...new Set(Object.values(COUNTRY_NAMES).map((x) => String(x).toLowerCase()))].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)
    .map((c) => ({ c, re: new RegExp("(^|[^a-z])" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^a-z])") }));
  const countryIn = (loc: string) => {
    const l = " " + loc.toLowerCase().replace(/[()]/g, " ") + " ";
    for (const [a, c] of Object.entries(ALIAS)) if (new RegExp("[\\s,]" + a.replace(/\./g, "\\.") + "[\\s,]").test(l)) return c;
    return (countries.find((x) => x.re.test(l)) || { c: "" }).c;
  };
  const inArea = (loc: string) => { if (!allowed.size) return true; const c = countryIn(loc); return !c || allowed.has(c); };
  const OWNER = /\b(founder|co-?founder|owner|proprietor|self[- ]employed|ceo\s*(&|and|\/)?\s*founder|managing director at (my|own))\b/i;
  const kept = list
    .map((x) => {
      const r = byKey.get(x.key);
      if (!r) return { x, r };
      const fromSnippet = (String(x.snippet || "").match(/(?:Location|Lives in|Based in)\s*[:：]\s*([^·|\n]{2,80})/i) || [])[1];
      const loc = clip(fromSnippet || r.location, 120).trim();
      return { x, r: { ...r, location: loc, locationSource: fromSnippet ? "profile" : loc ? "result" : "" } };
    })
    .filter(({ r }) => r && r.verdict !== "Not a fit" && Number(r.fit) >= 40)
    .filter(({ r }) => !sameCompany(r.company, job.client) && r.client_history !== "current")
    .filter(({ r }) => r.business !== true && !OWNER.test(String(r.headline || "")))
    .filter(({ r }) => !r.location || inArea(r.location))
    .filter(({ r }) => {
      const cl = Array.isArray(r.checklist) ? r.checklist : [];
      return !cl.slice(0, 3).some((c: any) => c?.status === "not met") && (!cl.length || cl.some((c: any) => c?.status === "met"));
    })
    .sort((a, b) => Number(b.r.fit) - Number(a.r.fit))
    .slice(0, perJob);
  const VERDICTS = ["Good fit", "Possible fit"];
  const rows = kept.map(({ x, r }) => {
    const name = clip(r.name, 120) || clip(x.title.split(/\s[-–|·]\s/)[0], 120);
    const parts = name.split(/\s+/);
    const checklist = (Array.isArray(r.checklist) ? r.checklist : []).slice(0, 10).map((c: any) => ({
      item: clip(c?.item, 100), status: ["met", "unconfirmed", "not met"].includes(String(c?.status)) ? String(c.status) : "unconfirmed", evidence: clip(c?.evidence, 140),
    }));
    return {
      job_id: jobId, source: x.site, external_id: x.key,
      first_name: parts[0] || null, last_name: parts.slice(1).join(" ") || null, full_name: name || null,
      title: clip(r.headline, 160) || null, company: clip(r.company, 120) || null, location: clip(r.location, 120) || null,
      linkedin_url: x.site === "linkedin" ? x.key : null,
      fit: Math.max(0, Math.min(100, Math.round(Number(r.fit) || 0))), verdict: VERDICTS.includes(r.verdict) ? r.verdict : "Possible fit",
      fit_reason: clip(r.overview, 300) || null, status: "found",
      data: { xray: true, profile_url: x.key, site: x.site, engine: x.engine, client_history: r.client_history === "past" ? "past" : "none", location_source: r.locationSource || "", overview: clip(r.overview, 400), checklist, gaps: (Array.isArray(r.gaps) ? r.gaps : []).slice(0, 4).map((g: unknown) => clip(g, 120)), snippet: clip(x.snippet, 500), result_title: clip(x.title, 200), query: x.query },
    };
  });
  let inserted: any[] = [];
  if (rows.length) {
    const { data, error } = await admin.from("prospects").upsert(rows, { onConflict: "job_id,external_id", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(error.message);
    inserted = data || [];
  }
  // GitHub people often show a public email on their profile: picked up now, free.
  let ghEmails = 0;
  if (rows.some((r) => r.source === "github")) {
    try {
      const { data: ag } = await admin.from("agency_settings").select("agency_name").limit(1).maybeSingle();
      ghEmails = (await findGithubEmails(admin, { jobId }, s, String(ag?.agency_name || "").trim())).found;
    } catch (e) { errors.push(errMsg(e).slice(0, 200)); }
  }
  const bySite: Record<string, number> = {};
  for (const r of rows) bySite[r.source] = (bySite[r.source] || 0) + 1;
  const usage = await searchUsage(admin).catch(() => ({}));
  await setXray(admin, jobId, {
    state: "done", found: inserted.length, reviewed: byKey.size, searched, used, bySite, ghEmails, technical: p.technical, checklist: p.checklist,
    queries: queries.map((x) => x.q), usage, ...(errors.length ? { warnings: [...new Set(errors)].slice(0, 5) } : {}),
  });
  return { ok: true, found: inserted.length, reviewed: byKey.size, searched, message: `X-ray found ${inserted.length} ${inserted.length === 1 ? "person" : "people"} worth a look (reviewed ${byKey.size} from ${searched} free searches).` };
}
