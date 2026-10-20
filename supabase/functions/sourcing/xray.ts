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
//
// Direction (optional, from a person or the AI assistant after they approve it): what to aim for
// in this run, e.g. other titles, places, must-haves, employers to target or avoid, and exact
// searches to add. The planner follows it on top of the job; it is kept on jobs.xray.guide.

import { askAI } from "./ai.ts";
import { jobBrief, searchArea } from "./prospects.ts";
import { jobCountryNames } from "./regions.ts";
import { fitsToPercent, type Settings } from "./common.ts";
import { broadPlace, judge, reviewHead, REVIEW_SYSTEM, type Judged } from "./xray_rules.ts";
import { splitByArea } from "./area_check.ts";
import { findGithubEmails } from "./emails.ts";
import { SITES, githubUsers, profileOf, searchEngines, searchUsage, searchWeb, type Hit, type SiteKey } from "./search.ts";

const errMsg = (e: unknown) => String((e as Error)?.message || e);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const MAX_QUERIES = 12;

async function setXray(admin: any, jobId: string, xray: Record<string, unknown>) {
  await admin.from("jobs").update({ xray: { ...xray, at: new Date().toISOString() } }).eq("id", jobId);
}

export type XrayGuide = { notes?: string; titles?: string[]; locations?: string[]; must_have?: string[]; target_companies?: string[]; exclude?: string[]; queries?: string[] };
// Cleans direction sent by a caller (any shape) into a small, safe XrayGuide, or null.
export function cleanGuide(g: any): XrayGuide | null {
  if (!g || typeof g !== "object") return null;
  const list = (v: unknown, n: number, len: number) => [...new Set((Array.isArray(v) ? v : typeof v === "string" ? v.split(/[;\n]/) : []).map((x) => clip(x, len)).filter(Boolean))].slice(0, n) as string[];
  const out: XrayGuide = {
    notes: clip(g.notes, 600) || undefined, titles: list(g.titles, 8, 80), locations: list(g.locations, 12, 80), must_have: list(g.must_have, 6, 80),
    target_companies: list(g.target_companies, 10, 80), exclude: list(g.exclude, 10, 80),
    queries: list(g.queries, 4, 300).filter((q) => /^site:\S+/i.test(q)),
  };
  for (const k of Object.keys(out) as (keyof XrayGuide)[]) if (!out[k] || (Array.isArray(out[k]) && !(out[k] as string[]).length)) delete out[k];
  return Object.keys(out).length ? out : null;
}

// Starts a run (the caller gets an answer straight away). There's no limit on how many run at
// once: each run works in short steps, each in its own call of this function (xray_step), saving
// where it got to on jobs.xray.cp and handing over to the next step before the server's time limit.
// So a long review never gets cut off, and many jobs can search at the same time.
export const XRAY_STALE_MS = 8 * 60e3;
const STEP_BUDGET_MS = 80e3;     // stop and hand over after this long in one step
const REVIEW_BATCH = 8;          // results per AI review call
const MAX_RESUMES = 4;           // a step that died (stale) is picked up again at most this often
export async function startXray(admin: any, jobId: string, s: Settings, by: string | null = null, guide: XrayGuide | null = null, _fromQueue = false) {
  const { data: job } = await admin.from("jobs").select("id,xray").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, message: "Job not found" };
  const e = searchEngines();
  if (!e.serper && !e.brave && !e.tavily && !e.gemini) return { ok: false, notConnected: "search", message: "No free search engine is connected yet. Add a TAVILY_API_KEY, SERPER_API_KEY, BRAVE_API_KEY or GEMINI_API_KEY secret in Supabase." };
  const x = job.xray || {};
  if (x.state === "running" && Date.now() - new Date(x.at || 0).getTime() < XRAY_STALE_MS) return { ok: true, running: true, message: "The X-ray search is already running for this job." };
  await setXray(admin, jobId, { state: "running", by, ...(guide ? { guide } : {}), progress: { step: "plan" } });
  try { await kickXray(admin, jobId); }
  catch (err) { await setXray(admin, jobId, { state: "error", by, error: errMsg(err).slice(0, 300), ...(guide ? { guide } : {}) }); return { ok: false, message: errMsg(err) }; }
  void s;
  return { ok: true, started: true, message: "X-ray search started" + (guide ? " with your direction" : "") + ". Results appear under this job in a few minutes." };
}

// A valid ops token, so a step can call the next one (and the search can be started by a person).
async function opsToken(admin: any) {
  const { data } = await admin.from("ops_tokens").select("token").gt("expires_at", new Date(Date.now() + 15 * 60e3).toISOString())
    .order("expires_at", { ascending: false }).limit(1).maybeSingle();
  return String(data?.token || "");
}
// Asks this function (a fresh call, with its own time limit) to run the job's next X-ray step.
export async function kickXray(admin: any, jobId: string) {
  const tok = await opsToken(admin);
  if (!tok) throw new Error("The search couldn't continue (no ops token)");
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const res = await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/sourcing", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + anon, apikey: anon, "x-harbor-ops": tok },
    body: JSON.stringify({ action: "xray_step", jobId }),
  });
  if (!res.ok) throw new Error("The search couldn't continue (" + res.status + ")");
}

// On-site / hybrid searches: whole countries or regions in quotes are dropped from a query; when no
// nearby place is left, the office city is searched instead.
export function narrowSearchPlaces(q: string, officeCity: string, _nearby: string[] = []) {
  const quoted = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const broad = quoted.filter((t) => broadPlace(t) || /^(uk|usa|us|u\.s\.|gb|great britain|britain)$/i.test(t.trim()));
  if (!broad.length) return q;
  let r = q;
  // A broad place that stood on its own, or was the only place in its ( … OR … ) group, leaves the
  // query with no place at all: the office city goes in its stead.
  const standalone = broad.some((t) => { const i = q.indexOf(`"${t}"`); const before = q.slice(0, i); return (before.match(/\(/g) || []).length <= (before.match(/\)/g) || []).length; });
  for (const t of broad) r = r.split(`"${t}"`).join("");
  const emptied = /\(\s*(OR\s*)*\)/.test(r);
  r = r.replace(/\s+/g, " ").replace(/\(\s*(OR\s+)+/g, "(").replace(/(\s+OR)+\s*\)/g, ")").replace(/"\s+(OR\s+)+"/g, '" OR "').replace(/\(\s*(OR\s*)*\)/g, "").replace(/\s+/g, " ").trim();
  if ((standalone || emptied) && officeCity.length > 2 && !broadPlace(officeCity) && !r.toLowerCase().includes(`"${officeCity.toLowerCase()}"`))
    r = /\s-jobs\b/.test(r) ? r.replace(/\s-jobs\b/, ` "${officeCity}" -jobs`) : `${r} "${officeCity}"`;
  return r.replace(/\s+/g, " ").trim();
}

type Plan = { technical: boolean; checklist: string[]; linkedin: string[]; sites: { site: SiteKey; query: string }[]; github: { location?: string; language?: string; keywords?: string } | null };

function guideText(g: XrayGuide | null) {
  if (!g) return "";
  const l = (label: string, xs?: string[]) => (xs?.length ? `\n- ${label}: ${xs.join("; ")}` : "");
  return "\n\nDIRECTION FOR THIS RUN from the recruiter (follow it; it overrides your own choices where they differ):" +
    (g.notes ? `\n- ${g.notes}` : "") + l("Titles to search (use these as the title variants)", g.titles) + l("Places to search (use these as the locations)", g.locations) +
    l("Must-haves to search for and check", g.must_have) + l("Target people who work or worked at", g.target_companies) + l("Leave out (add as -\"term\" in queries)", g.exclude);
}

async function plan(job: any, area: any, lessons: string[], titles: string[], guide: XrayGuide | null = null): Promise<Plan> {
  const siteList = (Object.keys(SITES) as SiteKey[]).filter((k) => k !== "linkedin").map((k) => `${k} (${SITES[k].label}, query starts "${SITES[k].prefix}")`).join("; ");
  const sys = "You are an expert technical and executive sourcer who writes Google X-ray searches to find people's public profiles for one job. Reply with STRICT JSON only: " +
    "{\"technical\": boolean, \"checklist\": string[], \"linkedin\": string[], \"sites\": [{\"site\": string, \"query\": string}], \"github\": {\"location\": string, \"language\": string, \"keywords\": string} | null}. " +
    "checklist: 5 to 8 of the job's most important must-haves, each a few words that a profile headline or summary could show (e.g. '8+ yrs technical accounting', 'Big 4 Advisory background', 'Senior Manager level', 'Based in Pacific or Mountain time zone'). Always include the seniority/title level and the location requirement. Add the lessons from past candidates when they apply. " +
    "linkedin: 4 to 8 search queries. Each MUST start with site:linkedin.com/in, then an OR group of 2 to 4 title variants in double quotes (the job title and its parallel titles, as people write them in headlines), " +
    "then at most 2 must-have terms in double quotes that people actually write in a headline or summary: a core skill, tool, standard or certification (e.g. \"ServiceNow\", \"ASC 606\", \"CPA\"); never years, numbers or phrases like \"5 years\" or \"senior level\", then an OR group of up to 4 locations in double quotes taken from the search area (for on-site and hybrid roles: only towns, cities or boroughs from the search area, never a whole country, nation, state or region like \"UK\", \"England\" or \"Texas\"), and finally -jobs -hiring -recruiter. " +
    "Keep each under 30 words. Spread the locations of the search area across the queries so together they cover it, and vary the title groups and terms so the queries don't repeat each other. Never include the hiring company's name. Use Google syntax: \"A\" OR \"B\" inside parentheses. " +
    "technical: true for software, data, IT, engineering, security, DevOps, ML/AI, product design and similar roles. " +
    `sites: only when technical (otherwise []): up to 4 queries on the sites that suit this role, from: ${siteList}. Each query starts with that site's prefix, then quoted skills/titles and a location term; under 25 words. ` +
    "github: only when technical and code matters for the role (otherwise null): location = the main city or country to search, language = the role's main programming language as GitHub names it (e.g. 'Python', 'TypeScript', 'Go'), keywords = 0 to 2 plain words likely in names or profiles (usually '').";
  const text = jobBrief(job, false) +
    `\n\nParallel titles: ${titles.join("; ") || "(none)"}` +
    `\nSearch area: ${area?.summary || job.location || job.country || "(not set)"}` +
    (area?.locations?.length ? `\nPlaces in the search area: ${area.locations.slice(0, 40).join("; ")}` : "") +
    (lessons.length ? `\n\nLessons from past candidates for this role (add as checklist items when they apply):\n${lessons.map((l) => "- " + l).join("\n")}` : "") +
    guideText(guide);
  const out = await askAI(sys, text, 3000);
  // On-site and hybrid roles: a whole country or region as a search place ("UK", "England",
  // "United States", "Texas") pulls in people from hundreds of miles away, so it's taken out and,
  // if no nearby place is left, the office itself is searched instead.
  const onsite = !(/remote/i.test(String(job.work_setup || "")) && !/hybrid/i.test(String(job.work_setup || "")));
  const officeCity = String(job.location || "").split(",")[0].trim();
  const nearby = [officeCity, ...((guide?.locations || []) as string[]), ...((area?.locations || []) as string[])];
  const narrowPlaces = (q: string) => narrowSearchPlaces(q, officeCity, nearby);
  const fix = (q: unknown, prefix: string) => {
    let s = clip(q, 400).replace(/\bsite:\S+/gi, "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    if (onsite) s = narrowPlaces(s);
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

// Scheduled (every 2 minutes): queued searches (from before steps existed) are started, and a
// run whose step died (no progress for 8 minutes) carries on from its last saved point, a few times
// at most, before it's marked as stopped.
export async function stepXrayQueue(admin: any, s: Settings) {
  const { data: rows } = await admin.from("jobs").select("id,status,xray").in("xray->>state", ["running", "queued"]);
  const now = Date.now();
  let stopped = 0, started = 0, resumed = 0;
  for (const j of rows || []) {
    const x = j.xray || {};
    if (x.state === "queued" && j.status !== "Closed") { await startXray(admin, j.id, s, x.by || null, x.guide || null, true); started++; continue; }
    if (x.state !== "running" || now - new Date(x.at || 0).getTime() <= XRAY_STALE_MS) continue;
    const tries = Number(x.resumes || 0);
    if (tries < MAX_RESUMES) {
      await setXray(admin, j.id, { ...x, resumes: tries + 1 });
      try { await kickXray(admin, j.id); resumed++; continue; } catch (_) { /* falls through to stopped */ }
    }
    await setXray(admin, j.id, { ...x, state: "error", cp: undefined, error: "It stopped before finishing. Run it again." });
    stopped++;
  }
  return { stopped, started, resumed };
}

// One step of a run (called by xray_step). Errors end the run with the reason shown on the job.
export async function runXrayStep(admin: any, jobId: string, s: Settings) {
  try { await xrayStep(admin, jobId, s); }
  catch (err) {
    console.error("xray", jobId, errMsg(err));
    const { data: j } = await admin.from("jobs").select("xray").eq("id", jobId).maybeSingle();
    const x = j?.xray || {};
    await setXray(admin, jobId, { state: "error", error: errMsg(err).slice(0, 300), ...(x.by ? { by: x.by } : {}), ...(x.guide ? { guide: x.guide } : {}) });
  }
}

// Plan and search (first step), then review the results in batches, saving after each so the next
// step carries on, then keep the best and save them as prospects.
async function xrayStep(admin: any, jobId: string, s: Settings) {
  const t0 = Date.now();
  const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).single();
  if (!job) throw new Error("Job not found");
  const x0 = job.xray || {};
  if (x0.state !== "running") return;
  const guide: XrayGuide | null = x0.guide || null, by = x0.by || null, resumes = x0.resumes || 0;
  let cp: any = x0.cp || null;
  const save = (extra: Record<string, unknown>) => setXray(admin, jobId, { state: "running", by, resumes, ...(guide ? { guide } : {}), ...(cp ? { cp } : {}), ...extra });
  // Live progress for the app's progress bar: { step: plan | search | review, done, total, found }.
  const prog = (o: Record<string, unknown>) => save({ progress: o }).catch(() => {});
  // Searched where the job is (its own country), like every other outside search.
  const area = await searchArea(admin, job, jobCountryNames(job));
  const perJob = s.xrayPerJob;
  if (!cp) {
  await prog({ step: "plan" });
  const titles = [...new Set([job.role_title, ...(Array.isArray(job.parallel_titles) ? job.parallel_titles : [])].filter(Boolean))].slice(0, 8) as string[];
  const { data: ls } = await admin.from("screening_lessons").select("lesson,kind").eq("job_id", jobId).eq("active", true).in("kind", ["client_reject", "internal_reject"]).limit(6);
  const p = await plan(job, area, (ls || []).map((l: any) => l.lesson), titles, guide);
  // Exact searches from the direction run first (LinkedIn ones count as LinkedIn).
  if (guide?.queries?.length) {
    for (const q of [...guide.queries].reverse()) {
      if (/^site:linkedin\.com/i.test(q)) p.linkedin.unshift(q);
      else { const site = (Object.keys(SITES) as SiteKey[]).find((k) => k !== "linkedin" && q.toLowerCase().startsWith(SITES[k].prefix.toLowerCase())); if (site) p.sites.unshift({ site, query: q }); else p.linkedin.unshift(q); }
    }
  }
  if (!p.linkedin.length && !p.sites.length && !p.github) throw new Error("The AI couldn't write searches for this job");

  // 2. Search, until there are enough new people to choose from.
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
  await prog({ step: "search", done: 0, total: queries.length, found: 0 });
  for (const [qi, { q }] of queries.entries()) {
    if (people.size >= want) break;
    if (qi) await prog({ step: "search", done: qi, total: queries.length, found: people.size });
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
    await setXray(admin, jobId, { state: "done", found: 0, searched, used, technical: p.technical, checklist: p.checklist, queries: queries.map((x) => x.q), note: why, ...(guide ? { guide } : {}) });
    return { ok: true, found: 0, message: why };
  }

  // Saved for the review steps: who was found, and what the plan and searches were.
  const found = [...people.values()].slice(0, Math.min(people.size, perJob + 15));
  cp = { stage: "review", technical: p.technical, checklist: p.checklist, queries: queries.map((x) => x.q), used, searched,
    errors: [...new Set(errors)].slice(0, 10), list: found, reviewed: [], next: 0 };
  await prog({ step: "review", done: 0, total: Math.ceil(found.length / REVIEW_BATCH), found: found.length });
  }

  // 4. Review what each result shows, in batches (two at a time), saving after each pair. Close to
  //    the time limit, the next step takes over from where this one stopped.
  const list: Person[] = cp.list || [];
  const searched: number = cp.searched || 0, used: Record<string, number> = cp.used || {};
  const errors: string[] = [...(cp.errors || [])];
  const head = reviewHead(job, area, cp.checklist || []);
  const byKey = new Map<string, any>(cp.reviewed || []);
  const batches: Person[][] = [];
  for (let i = 0; i < list.length; i += REVIEW_BATCH) batches.push(list.slice(i, i + REVIEW_BATCH));
  const review = async (b: Person[]) => {
    const out = await askAI(REVIEW_SYSTEM, head + b.map((x, i) => `${i} | ${SITES[x.site].label} | ${x.title || "(no title)"} | ${x.snippet || "(no snippet)"} | ${x.url}`).join("\n"), 8000);
    for (const r of fitsToPercent(Array.isArray(out?.people) ? out.people : [])) { const who = b[Number(r.i)]; if (who) byKey.set(who.key, r); }
  };
  for (let i = cp.next || 0; i < batches.length; i += 2) {
    if (i > (cp.next || 0) && Date.now() - t0 > STEP_BUDGET_MS) {
      cp = { ...cp, reviewed: [...byKey.entries()], next: i, errors: [...new Set(errors)].slice(0, 10) };
      await save({ progress: { step: "review", done: i, total: batches.length, found: list.length } });
      await kickXray(admin, jobId);
      return;
    }
    cp = { ...cp, reviewed: [...byKey.entries()], next: i };
    await prog({ step: "review", done: i, total: batches.length, found: list.length });
    const res = await Promise.allSettled(batches.slice(i, i + 2).map(review));
    for (const r of res) if (r.status === "rejected") errors.push(errMsg(r.reason).slice(0, 200));
  }

  // 5. Keep the best and save them next to Apollo's prospects (rules in xray_rules.ts, shared with
  //    the xray-recheck function): company pages, people at the client now, people outside the role's
  //    country or commute area, and anyone a core must-have clearly rules out are dropped; someone
  //    running their own practice in the same field is kept with a note to check.
  const judged = list
    .map((x) => { const r = byKey.get(x.key); return { x, r, j: r ? judge(job, x, r) : null }; })
    .filter((k): k is { x: Person; r: any; j: Judged } => !!k.j && k.j.keep);
  // Then the place itself, checked against the office in code (the AI review often leaves a
  // location it can see as "unknown"): anyone clearly too far is dropped, vague places get a note.
  let tooFar = 0;
  let placed = judged;
  try {
    const { kept: ok, dropped } = await splitByArea(admin, job, area, judged, (k) => k.j.location);
    tooFar = dropped.length;
    placed = ok.map(({ p, note, hold }) => (note ? { ...p, hold, j: { ...p.j, gaps: [note, ...p.j.gaps].slice(0, 5) } } : p));
  } catch (e) { errors.push("area check: " + errMsg(e).slice(0, 160)); }
  const kept = placed.sort((a, b) => b.j.fit - a.j.fit).slice(0, perJob);
  const rows = kept.map(({ x, r, j, hold }: any) => {
    const name = clip(r.name, 120) || clip(x.title.split(/\s[-–|·]\s/)[0], 120);
    const parts = name.split(/\s+/);
    return {
      job_id: jobId, source: x.site, external_id: x.key,
      first_name: parts[0] || null, last_name: parts.slice(1).join(" ") || null, full_name: name || null,
      title: clip(r.headline, 160) || null, company: clip(r.company, 120) || null, location: j.location || null,
      linkedin_url: x.site === "linkedin" ? x.key : null,
      fit: j.fit, verdict: j.verdict,
      fit_reason: clip(r.overview, 300) || null, status: "found",
      data: { xray: true, profile_url: x.key, site: x.site, engine: x.engine, client_history: j.clientHistory, location_source: j.locationSource, location_hold: hold || null, remote_worker: j.remote, own_practice: j.ownPractice, overview: clip(r.overview, 400), checklist: j.checklist, gaps: j.gaps, snippet: clip(x.snippet, 500), result_title: clip(x.title, 200), query: x.query },
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
  // Where each person was found: site and search engine ("linkedin:tavily": 12).
  const byEngine: Record<string, number> = {};
  for (const r of rows) { const k = r.source + ":" + String((r.data as any)?.engine || ""); byEngine[k] = (byEngine[k] || 0) + 1; }
  const usage = await searchUsage(admin).catch(() => ({}));
  await setXray(admin, jobId, {
    state: "done", found: inserted.length, reviewed: byKey.size, tooFar, searched, used, bySite, byEngine, ghEmails, technical: !!cp.technical, checklist: cp.checklist || [],
    queries: cp.queries || [], usage, by, ...(guide ? { guide } : {}), ...(errors.length ? { warnings: [...new Set(errors)].slice(0, 5) } : {}),
  });
  return { ok: true, found: inserted.length, reviewed: byKey.size, searched, message: `X-ray found ${inserted.length} ${inserted.length === 1 ? "person" : "people"} worth a look (reviewed ${byKey.size} from ${searched} free searches${tooFar ? `; ${tooFar} left out for being too far from the office` : ""}).` };
}
