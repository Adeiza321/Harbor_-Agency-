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
import { cleanRecentJobs, placeFromJobs, possibleText, splitByArea } from "./area_check.ts";
import { findGithubEmails } from "./emails.ts";
import { SITES, githubUsers, profileOf, searchEngines, searchUsage, searchWeb, type Hit, type SiteKey } from "./search.ts";

const errMsg = (e: unknown) => String((e as Error)?.message || e);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const MAX_QUERIES = 12;

// What went wrong, in one plain sentence for the job page (the technical detail goes to the logs).
export function friendlyXrayError(raw: unknown): string {
  const m = String((raw as Error)?.message ?? raw ?? "");
  if (/X-ray AI budget/.test(m)) return m;
  if (/out of credit|credit balance|insufficient|billing|payment required|\b402\b/i.test(m)) return "The AI is out of credit, so the people found couldn't be reviewed. Top up the AI credits, then search again.";
  if (/\b429\b|quota|rate.?limit|too many requests|exceeded/i.test(m)) return "A search service is busy or has used up today's free searches. Try again in an hour.";
  if (/cut off|max_tokens|truncat/i.test(m)) return "The AI's answer was cut short, so a few people may not have been reviewed.";
  if (/timeout|timed out|aborted|took too long/i.test(m)) return "A search took too long to answer and was skipped.";
  if (/ops token|couldn't continue/i.test(m)) return "The search couldn't carry on to its next step. Search again.";
  if (/couldn't write searches/i.test(m)) return "The AI couldn't work out searches for this job. Add more detail to the job description, then search again.";
  if (/no (free )?search engine|no engine available|not connected/i.test(m)) return "No search engine is connected, so nothing could be searched. Ask an Admin to add a search key in Supabase.";
  if (/job not found/i.test(m)) return "This job no longer exists.";
  if (/\b5\d\d\b|overloaded|unavailable|bad gateway|fetch failed|network/i.test(m)) return "A service ProNext relies on was briefly unavailable. Search again in a few minutes.";
  return "The search hit a problem and stopped. Search again in a few minutes.";
}
const friendlyList = (xs: unknown[]) => [...new Set(xs.map(friendlyXrayError))].slice(0, 5);
const RECRUITER_DAILY_SEARCHES = 5;

async function setXray(admin: any, jobId: string, xray: Record<string, unknown>) {
  await admin.from("jobs").update({ xray: { ...xray, at: new Date().toISOString() } }).eq("id", jobId);
}
// A running search saves only while it is still the job's current run: once it's stopped (by a
// person or as stuck) or handed to a fresh copy, the old one's next save finds nothing to update
// and it ends there, so a stopped search can't switch itself back on.
class XrayStopped extends Error { constructor() { super("This search was stopped"); } }
async function saveRun(admin: any, jobId: string, run: string, xray: Record<string, unknown>) {
  const { data } = await admin.from("jobs").update({ xray: { ...xray, at: new Date().toISOString() } })
    .eq("id", jobId).eq("xray->>state", "running").eq("xray->>run", run).select("id");
  if (!data?.length) throw new XrayStopped();
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
export const XRAY_STALE_MS = 5 * 60e3;
// Stuck searches (checked every 2 minutes by stepXrayQueue):
//   no sign of life for 5 minutes   the step died: carried on from its last saved point (a few times)
//   no progress for 10 minutes      still "alive" but going nowhere: also restarted from its last
//                                   saved point, then stopped if it keeps happening
//   running for over an hour        stopped (a normal search takes under 15 minutes)
// A search stopped while reviewing keeps the best of the people it had already reviewed.
const XRAY_NO_PROGRESS_MS = 10 * 60e3;
const XRAY_MAX_RUN_MS = 60 * 60e3;
const STEP_BUDGET_MS = 80e3;     // stop and hand over after this long in one step
const REVIEW_BATCH = 8;          // results per AI review call
const MAX_RESUMES = 4;           // a step that died (stale) is picked up again at most this often
// Spending guards. A run makes at most this many AI calls (plan + reviews), and X-ray stops for the
// day once its AI spend reaches the daily budget (XRAY_DAILY_USD secret, default $2), so a stuck or
// repeated search can never drain the credits. These apply to recruiters' and automatic searches
// only: a search an Admin or Rec Ops starts has neither (marked staff: true on the job's xray).
// The lowest fit X-ray brings in (the shared rules drop under 40; 40-59 was mostly skipped by hand).
const XRAY_MIN_FIT = 60;
const MAX_AI_CALLS_PER_RUN = 12;
const XRAY_DAILY_USD = () => Math.max(0, Number(Deno.env.get("XRAY_DAILY_USD") || 2));
async function xraySpentToday(admin: any) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { data } = await admin.from("ai_usage").select("cost_usd").eq("feature", "xray_search").gte("created_at", since.toISOString()).limit(5000);
  return (data || []).reduce((n: number, r: any) => n + (Number(r.cost_usd) || 0), 0);
}
const budgetMsg = () => `Today's X-ray AI budget ($${XRAY_DAILY_USD()}) is used up, so new searches wait until tomorrow. An Admin can raise it with the XRAY_DAILY_USD setting.`;
export async function startXray(admin: any, jobId: string, s: Settings, by: string | null = null, guide: XrayGuide | null = null, _fromQueue = false) {
  const { data: job } = await admin.from("jobs").select("id,status,xray").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, message: "This job no longer exists." };
  const e = searchEngines();
  if (!e.serper && !e.brave && !e.tavily && !e.gemini) return { ok: false, notConnected: "search", message: "No search engine is connected yet, so X-ray can't run. Ask an Admin to add a search key (Tavily, Serper, Brave or Gemini) in Supabase." };
  const { data: who } = by ? await admin.from("profiles").select("role").eq("id", by).maybeSingle() : { data: null };
  const recruiter = who?.role === "recruiter";
  // Searches an Admin or Rec Ops starts have no daily budget and no AI call cap (recruiters' and
  // automatic searches keep them). Their spend still shows in the AI costs.
  const staff = who?.role === "admin" || who?.role === "recops";
  const x = job.xray || {};
  const busy = x.state === "running" && Date.now() - new Date(x.at || 0).getTime() < XRAY_STALE_MS;
  if (recruiter && !_fromQueue) {
    // A recruiter's searches are tracked (and capped) one by one, so they can wait their turn.
    const since = new Date(); since.setUTCHours(0, 0, 0, 0);
    const { count } = await admin.from("xray_requests").select("id", { count: "exact", head: true }).eq("requested_by", by).gte("created_at", since.toISOString());
    const { data: open } = await admin.from("xray_requests").select("id,started_at").eq("job_id", jobId).eq("requested_by", by).is("finished_at", null).maybeSingle();
    if (open) return { ok: true, queued: !open.started_at, running: !!open.started_at, message: open.started_at ? "Your X-ray search is already running for this role." : "Your X-ray search is waiting for another search on this role to finish. It starts by itself." };
    if ((count || 0) >= RECRUITER_DAILY_SEARCHES) return { ok: false, message: `You've run ${RECRUITER_DAILY_SEARCHES} X-ray searches today, the daily limit. You can search again tomorrow.` };
    const { error: qErr } = await admin.from("xray_requests").insert({ job_id: jobId, requested_by: by, ...(busy ? {} : { started_at: new Date().toISOString() }) });
    if (qErr) return { ok: false, message: "We couldn't start your search. Try again in a minute." };
    if (busy) return { ok: true, queued: true, message: "Another search is running on this role. Yours starts by itself as soon as it finishes, usually within a few minutes." };
  } else if (busy) return { ok: true, running: true, message: "The X-ray search is already running for this job." };
  if (!staff && (await xraySpentToday(admin)) >= XRAY_DAILY_USD()) {
    const msg = budgetMsg();
    await finishRequest(admin, jobId, by, { error: msg });
    return { ok: false, message: msg };
  }
  // Each run has its own id: only steps carrying it may work on the job, so two copies of the same
  // search (a double start, a resumed step) can never run side by side and repeat the AI's work.
  const run = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await setXray(admin, jobId, { state: "running", run, by, startedAt: nowIso, movedAt: nowIso, fp: "plan", ...(staff ? { staff: true } : {}), ...(guide ? { guide } : {}), progress: { step: "plan" } });
  try { await kickXray(admin, jobId, run); }
  catch (err) {
    console.error("xray start", jobId, errMsg(err));
    const msg = friendlyXrayError(err);
    await setXray(admin, jobId, { state: "error", by, error: msg, ...(guide ? { guide } : {}) });
    await finishRequest(admin, jobId, by, { error: msg });
    return { ok: false, message: msg };
  }
  void s;
  return { ok: true, started: true, message: "X-ray search started" + (guide ? " with your direction" : "") + ". Results appear under this job in a few minutes." };
}

// A recruiter's search finished (or failed): close their request, then start whoever is waiting next.
async function finishRequest(admin: any, jobId: string, by: string | null, r: { found?: number; error?: string }) {
  if (!by) return;
  await admin.from("xray_requests").update({ finished_at: new Date().toISOString(), found: r.found ?? null, error: r.error ?? null })
    .eq("job_id", jobId).eq("requested_by", by).is("finished_at", null).not("started_at", "is", null);
}
export async function startNextRequest(admin: any, jobId: string, s: Settings) {
  const { data: next } = await admin.from("xray_requests").select("id,requested_by").eq("job_id", jobId).is("started_at", null).is("finished_at", null).order("created_at").limit(1).maybeSingle();
  if (!next) return false;
  const { data: claimed } = await admin.from("xray_requests").update({ started_at: new Date().toISOString() }).eq("id", next.id).is("started_at", null).select("id");
  if (!claimed?.length) return false;
  const r: any = await startXray(admin, jobId, s, next.requested_by, null, true);
  if (r.ok === false) await admin.from("xray_requests").update({ finished_at: new Date().toISOString(), error: r.message }).eq("id", next.id);
  return r.ok !== false;
}

// A valid ops token, so a step can call the next one (and the search can be started by a person).
async function opsToken(admin: any) {
  const { data } = await admin.from("ops_tokens").select("token").gt("expires_at", new Date(Date.now() + 15 * 60e3).toISOString())
    .order("expires_at", { ascending: false }).limit(1).maybeSingle();
  return String(data?.token || "");
}
// Asks this function (a fresh call, with its own time limit) to run the job's next X-ray step.
export async function kickXray(admin: any, jobId: string, run: string) {
  const tok = await opsToken(admin);
  if (!tok) throw new Error("The search couldn't continue (no ops token)");
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const res = await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/sourcing", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + anon, apikey: anon, "x-harbor-ops": tok },
    body: JSON.stringify({ action: "xray_step", jobId, run }),
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
  const { data: rows } = await admin.from("jobs").select("id,status,xray").in("xray->>state", ["running", "queued", "starting"]);
  const now = Date.now();
  let stopped = 0, started = 0, resumed = 0, fromRequests = 0;
  // Recruiters' searches waiting their turn on a role where nothing is running any more.
  const { data: waiting } = await admin.from("xray_requests").select("job_id").is("started_at", null).is("finished_at", null).limit(50);
  for (const jobId of [...new Set((waiting || []).map((w: any) => w.job_id))] as string[]) {
    const { data: j } = await admin.from("jobs").select("status,xray").eq("id", jobId).maybeSingle();
    if (!j || j.status === "Closed") { await admin.from("xray_requests").update({ finished_at: new Date().toISOString(), error: "The role closed before the search could run." }).eq("job_id", jobId).is("finished_at", null); continue; }
    const x = j.xray || {};
    if (x.state === "running" && now - new Date(x.at || 0).getTime() <= XRAY_STALE_MS) continue;
    if (await startNextRequest(admin, jobId, s)) fromRequests++;
  }
  // Requests left open by a run that ended without closing them (over an hour old).
  await admin.from("xray_requests").update({ finished_at: new Date().toISOString(), error: "The search stopped before finishing. Search again." })
    .is("finished_at", null).not("started_at", "is", null).lt("started_at", new Date(now - 60 * 60e3).toISOString());
  for (const j of rows || []) {
    const x = j.xray || {};
    if (x.state === "queued" && j.status !== "Closed") {
      // Claimed first, so two overlapping queue runs can't both start it.
      const { data: claimed } = await admin.from("jobs").update({ xray: { ...x, state: "starting", at: new Date().toISOString() } }).eq("id", j.id).eq("xray->>state", "queued").select("id");
      if (!claimed?.length) continue;
      await startXray(admin, j.id, s, x.by || null, x.guide || null, true); started++; continue;
    }
    if (x.state === "starting" && now - new Date(x.at || 0).getTime() > XRAY_STALE_MS) { await setXray(admin, j.id, { ...x, state: "error", error: "The search couldn't start. Search again." }); stopped++; continue; }
    if (x.state !== "running") continue;
    const silent = now - new Date(x.at || 0).getTime() > XRAY_STALE_MS;
    const idle = now - new Date(x.movedAt || x.startedAt || x.at || 0).getTime() > XRAY_NO_PROGRESS_MS;
    const tooLong = !!x.startedAt && now - new Date(x.startedAt).getTime() > XRAY_MAX_RUN_MS;
    if (!silent && !idle && !tooLong) continue;
    const tries = Number(x.resumes || 0);
    if (!tooLong && !x.wrapUp && tries < MAX_RESUMES) {
      const run = crypto.randomUUID();   // the old chain (if still alive) stops at its next save
      await setXray(admin, j.id, { ...x, run, resumes: tries + 1, movedAt: new Date().toISOString() });
      try { await kickXray(admin, j.id, run); resumed++; continue; } catch (_) { /* falls through to stopped */ }
    }
    const why = tooLong ? "it ran for over an hour" : idle && !silent ? "it stopped making progress" : "it kept getting cut off";
    console.error("xray stuck", j.id, why, JSON.stringify(x.progress || {}));
    await endXray(admin, j.id, s, x, `The search got stuck (${why}), so ProNext stopped it.`);
    stopped++;
  }
  return { stopped, started, resumed, fromRequests };
}

// Ends a running search: one that was reviewing keeps the best of the people it already reviewed
// (a last short step saves them); otherwise it's marked as stopped with the reason.
async function endXray(admin: any, jobId: string, s: Settings, x: any, reason: string) {
  const reviewed = Array.isArray(x.cp?.reviewed) ? x.cp.reviewed.length : 0;
  if (x.state === "running" && x.cp?.stage === "review" && reviewed > 0 && !x.wrapUp) {
    const run = crypto.randomUUID();
    await setXray(admin, jobId, { ...x, run, wrapUp: reason, movedAt: new Date().toISOString() });
    try { await kickXray(admin, jobId, run); return "kept"; } catch (_) { /* marked as stopped below */ }
  }
  const { cp: _cp, run: _run, wrapUp: _w, ...rest } = x;
  await setXray(admin, jobId, { ...rest, state: "error", error: reason, stopped: true });
  await finishRequest(admin, jobId, x.by || null, { error: reason });
  await startNextRequest(admin, jobId, s).catch(() => false);
  return "stopped";
}

// "Stop search" (Rec Ops / Admins on any search, a recruiter on their own).
export async function stopXray(admin: any, jobId: string, s: Settings, who: { id: string; role: string; full_name?: string | null }) {
  const { data: job } = await admin.from("jobs").select("id,xray").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, message: "This job no longer exists." };
  const x = job.xray || {};
  if (who.role === "recruiter") {
    // Their search still waiting its turn behind another one: just taken off the waiting list.
    const { data: w } = await admin.from("xray_requests").update({ finished_at: new Date().toISOString(), error: "Cancelled" })
      .eq("job_id", jobId).eq("requested_by", who.id).is("started_at", null).is("finished_at", null).select("id");
    if (w?.length) return { ok: true, stopped: true, message: "Your waiting search was cancelled." };
  }
  if (!["running", "queued", "starting"].includes(x.state)) return { ok: true, message: "No search is running for this job." };
  if (who.role === "recruiter" && x.by !== who.id) return { ok: false, message: "Only the person who started this search, Rec Ops or an Admin can stop it." };
  const name = String(who.full_name || "").trim().split(" ")[0] || "someone";
  const r = await endXray(admin, jobId, s, x, `Stopped by ${name}.`);
  return { ok: true, stopped: true, kept: r === "kept",
    message: r === "kept" ? "Search stopped. The best people it had already reviewed are being saved now." : "Search stopped." };
}

// One step of a run (called by xray_step). Errors end the run with the reason shown on the job.
export async function runXrayStep(admin: any, jobId: string, s: Settings, run = "") {
  try { await xrayStep(admin, jobId, s, run); }
  catch (err) {
    if (err instanceof XrayStopped) return;   // stopped or handed to a fresh copy: nothing to do
    console.error("xray", jobId, errMsg(err));
    const { data: j } = await admin.from("jobs").select("xray").eq("id", jobId).maybeSingle();
    const x = j?.xray || {};
    if (x.state !== "running" || (x.run && x.run !== run)) return;   // an old copy: leave the current run alone
    const msg = friendlyXrayError(err);
    await setXray(admin, jobId, { state: "error", error: msg, detail: errMsg(err).slice(0, 300), ...(x.by ? { by: x.by } : {}), ...(x.guide ? { guide: x.guide } : {}) });
    await finishRequest(admin, jobId, x.by || null, { error: msg });
    await startNextRequest(admin, jobId, s).catch(() => false);
  }
}

// Plan and search (first step), then review the results in batches, saving after each so the next
// step carries on, then keep the best and save them as prospects.
async function xrayStep(admin: any, jobId: string, s: Settings, run: string) {
  const t0 = Date.now();
  const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).single();
  if (!job) throw new Error("Job not found");
  const x0 = job.xray || {};
  if (x0.state !== "running") return;
  // Not this run's turn (an older copy of the search): stop without doing anything.
  if (!run || (x0.run && x0.run !== run)) return;
  const staff = !!x0.staff;   // started by an Admin or Rec Ops: no daily budget, no AI call cap
  if (!staff && !x0.wrapUp && (await xraySpentToday(admin)) >= XRAY_DAILY_USD()) throw new Error(budgetMsg());
  const guide: XrayGuide | null = x0.guide || null, by = x0.by || null, resumes = x0.resumes || 0;
  let cp: any = x0.cp || null;
  const startedAt = x0.startedAt || new Date().toISOString(), wrapUp: string | null = x0.wrapUp || null;
  // Progress, for spotting a search that's alive but going nowhere: movedAt changes only when the
  // step or count on the progress bar moves on.
  let fp = String(x0.fp || ""), movedAt = String(x0.movedAt || startedAt);
  const save = (extra: Record<string, unknown>) => {
    const p: any = extra.progress;
    if (p) { const f = `${p.step}:${p.done ?? ""}`; if (f !== fp) { fp = f; movedAt = new Date().toISOString(); } }
    return saveRun(admin, jobId, run, { state: "running", run, by, resumes, startedAt, movedAt, fp, ...(wrapUp ? { wrapUp } : {}), ...(staff ? { staff: true } : {}), ...(guide ? { guide } : {}), ...(cp ? { cp } : {}), ...extra });
  };
  // Live progress for the app's progress bar: { step: plan | search | review, done, total, found }.
  const prog = (o: Record<string, unknown>) => save({ progress: o }).catch((e) => { if (e instanceof XrayStopped) throw e; });
  // Searched where the job is (its own country), like every other outside search.
  const area = await searchArea(admin, job, jobCountryNames(job));
  const perJob = s.xrayPerJob;
  // 1. Plan (first step only): the searches and the must-have checklist, saved before searching.
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
    const queries = [...p.linkedin.map((q) => ({ q, site: "linkedin" as SiteKey })), ...p.sites.map((x) => ({ q: x.query, site: x.site }))].slice(0, MAX_QUERIES);
    cp = { stage: "search", technical: p.technical, checklist: p.checklist, github: p.github, queries, qi: 0, people: [], used: {}, errors: [], dropped: 0, searched: 0, githubDone: false };
    await prog({ step: "search", done: 0, total: queries.length, found: 0 });
  }

  // 2. Search, one query at a time, saving after each, until there are enough new people to choose
  //    from. Close to the time limit, the next step carries on from the next query.
  if (cp.stage === "search") {
    const want = Math.min(perJob * 2, 90);
    const queries: { q: string; site: SiteKey }[] = cp.queries || [];
    // Within a role, whoever finds someone first keeps them: anyone already found for this role (by
    // any search, Apollo included) or already in ProNext is never shown again.
    const { data: existing } = await admin.from("prospects").select("external_id,linkedin_url").eq("job_id", jobId);
    const seen = new Set<string>();
    for (const x of existing || []) { if (x.external_id) seen.add(String(x.external_id)); const k = x.linkedin_url ? profileOf(x.linkedin_url)?.key : null; if (k) seen.add(k); }
    const { data: cands } = await admin.from("candidates").select("linkedin_url").not("linkedin_url", "is", null);
    const inPronext = new Set((cands || []).map((c: any) => profileOf(c.linkedin_url)?.key).filter(Boolean));
    const people = new Map<string, Person>((cp.people || []).map((x: Person) => [x.key, x]));
    const used: Record<string, number> = cp.used || {};
    const errors: string[] = [...(cp.errors || [])];
    const skip = new Set<string>(cp.skip || []);
    let dropped = cp.dropped || 0, searched = cp.searched || 0;
    const add = (h: Hit, query: string) => {
      const pr = profileOf(h.url);
      if (!pr) return;
      if (seen.has(pr.key) || inPronext.has(pr.key)) { dropped++; return; }
      const cur = people.get(pr.key);
      if (cur) { if (!cur.snippet && h.snippet) people.set(pr.key, { ...cur, ...h, url: pr.key, key: pr.key, site: pr.site, query }); return; }
      people.set(pr.key, { ...h, url: pr.key, key: pr.key, site: pr.site, query });
    };
    const keep = () => ({ ...cp, people: [...people.values()], used, errors: [...new Set(errors)].slice(0, 10), skip: [...skip], dropped, searched });
    let qi = cp.qi || 0;
    for (; qi < queries.length; qi++) {
      if (people.size >= want || skip.size >= 4) break;
      if (qi > (cp.qi || 0) && Date.now() - t0 > STEP_BUDGET_MS) {
        cp = { ...keep(), qi };
        await save({ progress: { step: "search", done: qi, total: queries.length, found: people.size } });
        await kickXray(admin, jobId, run);
        return;
      }
      cp = { ...keep(), qi };
      await prog({ step: "search", done: qi, total: queries.length, found: people.size });
      const r = await searchWeb(admin, queries[qi].q, skip);
      errors.push(...r.errors);
      if (!r.engine) continue;
      searched++;
      used[r.engine] = (used[r.engine] || 0) + 1;
      for (const h of r.hits) add(h, queries[qi].q);
    }
    if (cp.github && !cp.githubDone && people.size < want) {
      try {
        const hits = await githubUsers(cp.github, 30);
        used.github = (used.github || 0) + 1;
        for (const h of hits) add(h, `GitHub users: ${[cp.github.keywords, cp.github.location, cp.github.language].filter(Boolean).join(", ")}`);
      } catch (e) { errors.push(errMsg(e).slice(0, 200)); }
    }
    if (!people.size) {
      const why = searched ? `The searches found nobody new (${dropped} already found for this role or already in ProNext).` : "No search could run. " + (errors.length ? friendlyList(errors).join(" ") : "No search engine was available.");
      await setXray(admin, jobId, { state: "done", found: 0, searched, used, technical: !!cp.technical, checklist: cp.checklist || [], queries: queries.map((x) => x.q), note: why, by, ...(guide ? { guide } : {}) });
      await finishRequest(admin, jobId, by, { found: 0 });
      await startNextRequest(admin, jobId, s).catch(() => false);
      return { ok: true, found: 0, message: why };
    }
    // Saved for the review steps: who was found, and what the plan and searches were.
    const found = [...people.values()].slice(0, Math.min(people.size, perJob + 15));
    cp = { stage: "review", technical: cp.technical, checklist: cp.checklist, queries: queries.map((x) => x.q), used, searched,
      errors: [...new Set(errors)].slice(0, 10), list: found, reviewed: [], next: 0 };
    await prog({ step: "review", done: 0, total: Math.ceil(found.length / REVIEW_BATCH), found: found.length });
    if (Date.now() - t0 > STEP_BUDGET_MS) { await save({ progress: { step: "review", done: 0, total: Math.ceil(found.length / REVIEW_BATCH), found: found.length } }); await kickXray(admin, jobId, run); return; }
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
    if (wrapUp) break;   // stopped: keep the best of those already reviewed
    if (i > (cp.next || 0) && Date.now() - t0 > STEP_BUDGET_MS) {
      cp = { ...cp, reviewed: [...byKey.entries()], next: i, errors: [...new Set(errors)].slice(0, 10) };
      await save({ progress: { step: "review", done: i, total: batches.length, found: list.length } });
      await kickXray(admin, jobId, run);
      return;
    }
    // Spending guard: never more than MAX_AI_CALLS_PER_RUN AI calls for one search.
    const calls = Number(cp.aiCalls || 1);
    if (!staff && calls >= MAX_AI_CALLS_PER_RUN) { errors.push("Stopped reviewing at the AI call limit for one search"); break; }
    const pair = batches.slice(i, i + 2);
    cp = { ...cp, reviewed: [...byKey.entries()], next: i, aiCalls: calls + pair.length };
    await prog({ step: "review", done: i, total: batches.length, found: list.length });
    const res = await Promise.allSettled(pair.map(review));
    for (const r of res) if (r.status === "rejected") errors.push(errMsg(r.reason).slice(0, 200));
    // Out of credit: stop now instead of failing on every remaining batch.
    if (res.every((r) => r.status === "rejected") && res.some((r: any) => /paused|credit/i.test(errMsg(r.reason)))) throw new Error("The AI is out of credit");
  }

  // 5. Keep the best and save them next to Apollo's prospects (rules in xray_rules.ts, shared with
  //    the xray-recheck function): company pages, people at the client now, people outside the role's
  //    country or commute area, and anyone a core must-have clearly rules out are dropped; someone
  //    running their own practice in the same field is kept with a note to check.
  // Stricter than the shared rules: only people worth a recruiter's time are brought in. A fit under
  // XRAY_MIN_FIT was mostly skipped by hand later, so they're left out here.
  const all = list.map((x) => { const r = byKey.get(x.key); return { x, r, j: r ? judge(job, x, r) : null }; })
    .filter((k): k is { x: Person; r: any; j: Judged } => !!k.j);
  const judged = all.filter((k) => k.j.keep && k.j.fit >= XRAY_MIN_FIT);
  // Left out only for where their profile says they are (another country, or too far): their recent
  // jobs get a say below, like everyone else whose profile place is too far.
  const LOC_ONLY = /^(Based in |Outside the commute area)/;
  const placeOnly = all.filter((k) => !k.j.keep && k.j.reasons.length === 1 && LOC_ONLY.test(k.j.reasons[0]) && Number(k.r?.fit) >= XRAY_MIN_FIT && cleanRecentJobs(k.r?.recent_jobs).some((x) => x.place));
  // Then the place, checked against the office in code (the AI review often leaves a location it
  // can see as "unknown"), with their two most recent non-remote jobs as a second source:
  //   - profile place in the area                                   -> kept
  //   - profile place too far, but a recent job is in the area      -> kept, possible location to double check
  //   - profile place too far, recent jobs far or unknown           -> left out
  //   - no / vague place, a recent job in the area                  -> kept, possible location to double check
  //   - no / vague place, recent jobs clearly far                   -> left out
  //   - no / vague place, nothing to go on                          -> kept only when a strong fit, to check
  let tooFar = 0, vagueWeak = 0;
  let placed: any[] = judged;
  try {
    const { kept: ok, dropped } = await splitByArea(admin, job, area, judged, (k) => k.j.location);
    const out: any[] = [];
    for (const { p } of dropped) {
      const pl = await placeFromJobs(admin, job, area, cleanRecentJobs(p.r?.recent_jobs));
      if (pl.status === "near") out.push({ ...p, hold: possibleText(pl) + " (their profile says " + p.j.location + ")", possible: pl, j: { ...p.j, gaps: [possibleText(pl), ...p.j.gaps].slice(0, 5) } });
      else tooFar++;
    }
    for (const p of placeOnly) {
      const pl = await placeFromJobs(admin, job, area, cleanRecentJobs(p.r?.recent_jobs));
      if (pl.status !== "near") continue;
      const fit = Math.max(0, Math.min(100, Math.round(Number(p.r.fit) || 0)));
      out.push({ ...p, hold: possibleText(pl) + " (their profile says " + (p.j.location || "somewhere else") + ")", possible: pl,
        j: { ...p.j, keep: true, fit, verdict: "Possible fit", gaps: [possibleText(pl), ...p.j.gaps].slice(0, 5) } });
    }
    for (const { p, note, hold } of ok) {
      if (!hold) { out.push(note ? { ...p, j: { ...p.j, gaps: [note, ...p.j.gaps].slice(0, 5) } } : p); continue; }
      const pl = await placeFromJobs(admin, job, area, cleanRecentJobs(p.r?.recent_jobs));
      if (pl.status === "near") out.push({ ...p, hold: possibleText(pl), possible: pl, j: { ...p.j, gaps: [possibleText(pl), ...p.j.gaps].slice(0, 5) } });
      else if (pl.status === "far") tooFar++;
      else if (p.j.fit >= 70) out.push({ ...p, hold, j: { ...p.j, gaps: [note, ...p.j.gaps].slice(0, 5) } });
      else vagueWeak++;
    }
    placed = out;
  } catch (e) { errors.push("area check: " + errMsg(e).slice(0, 160)); }
  const kept = placed.sort((a, b) => b.j.fit - a.j.fit).slice(0, perJob);
  const rows = kept.map(({ x, r, j, hold, possible }: any) => {
    const name = clip(r.name, 120) || clip(x.title.split(/\s[-–|·]\s/)[0], 120);
    const parts = name.split(/\s+/);
    return {
      job_id: jobId, source: x.site, external_id: x.key,
      first_name: parts[0] || null, last_name: parts.slice(1).join(" ") || null, full_name: name || null,
      title: clip(r.headline, 160) || null, company: clip(r.company, 120) || null, location: j.location || null,
      linkedin_url: x.site === "linkedin" ? x.key : null,
      fit: j.fit, verdict: j.verdict,
      fit_reason: clip(r.overview, 300) || null, status: "found", sourced_by: by,
      data: { xray: true, profile_url: x.key, site: x.site, engine: x.engine, client_history: j.clientHistory, location_source: j.locationSource, location_hold: hold || null, recent_jobs: cleanRecentJobs(r.recent_jobs), ...(possible ? { possible_location: { place: possible.place, company: possible.company, basis: possible.basis } } : {}), remote_worker: j.remote, own_practice: j.ownPractice, overview: clip(r.overview, 400), checklist: j.checklist, gaps: j.gaps, snippet: clip(x.snippet, 500), result_title: clip(x.title, 200), query: x.query },
    };
  });
  let inserted: any[] = [];
  if (rows.length) {
    const { data, error } = await admin.from("prospects").upsert(rows, { onConflict: "job_id,external_id", ignoreDuplicates: true }).select("id");
    if (error) throw new Error("Couldn't save the people found: " + error.message);
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
    state: "done", found: inserted.length, reviewed: byKey.size, tooFar, vagueWeak, searched, used, bySite, byEngine, ghEmails, technical: !!cp.technical, checklist: cp.checklist || [],
    queries: cp.queries || [], usage, by, ...(guide ? { guide } : {}), ...(errors.length ? { warnings: friendlyList(errors) } : {}),
    ...(wrapUp ? { early: `${wrapUp} Kept the best of the ${byKey.size} of ${list.length} profiles it had reviewed.` } : {}),
  });
  await finishRequest(admin, jobId, by, { found: inserted.length });
  await startNextRequest(admin, jobId, s).catch(() => false);
  return { ok: true, found: inserted.length, reviewed: byKey.size, searched, message: `X-ray found ${inserted.length} ${inserted.length === 1 ? "person" : "people"} worth a look (reviewed ${byKey.size} from ${searched} free searches${tooFar ? `; ${tooFar} left out for being too far from the office` : ""}${vagueWeak ? `; ${vagueWeak} left out with no location and only a possible fit` : ""}).` };
}
