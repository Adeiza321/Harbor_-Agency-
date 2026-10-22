// The must-have check for people found in Apollo, done BEFORE deciding who to keep, by the same
// rules as X-ray (xray_rules.ts):
//   * one list of 5 to 8 must-haves per role: the role's X-ray checklist when X-ray has planned one,
//     otherwise taken from the job's own requirements (saved on jobs.sourcing.musts so everyone on
//     the role is checked against the same list). The first three are the core must-haves.
//   * evidence: what Apollo has (title, employer, location, work history with what they did, their
//     LinkedIn headline) plus the public snippet a search engine shows from their LinkedIn profile
//     (one free search, same engines as X-ray; LinkedIn itself is never opened). After an Admin
//     approves it, People Data Labs' full profile for anyone still unconfirmed on a core must-have
//     (profilecheck.ts).
//   * a must-have is "not met" only when something shown contradicts it; not shown = "unconfirmed".
//   * kept only with a fit of KEEP_FIT% or more, not "Not a fit", and no core must-have not met.
//     Anyone else is skipped with the reason (status rejected, data.skipped), so Apollo credits are
//     never spent on them again.
// Apollo people found before this check existed are checked by recheckApollo (every 10 minutes,
// a batch at a time) on roles that are Open or On hold.
import { askAI } from "./ai.ts";
import { jobBrief } from "./prospects.ts";
import { profileOf, searchWeb } from "./search.ts";
import { fitsToPercent } from "./common.ts";

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const KEEP_FIT = 70;
export const MUSTS_V = 2;   // data.musts_v: checked by this version (before deciding, with LinkedIn)

export async function roleMustHaves(admin: any, job: any): Promise<string[]> {
  const fromXray: string[] = Array.isArray(job?.xray?.checklist) ? job.xray.checklist.filter(Boolean) : [];
  if (fromXray.length) return fromXray.slice(0, 8);
  const saved: string[] = Array.isArray(job?.sourcing?.musts) ? job.sourcing.musts.filter(Boolean) : [];
  if (saved.length) return saved.slice(0, 8);
  const out = await askAI(
    "From this job, list its 5 to 8 most important hiring requirements (must-haves), each a few words a profile could show: experience, level, skills, certifications, location or work setup. Most important first. Reply with STRICT JSON only: {\"musts\": string[]}.",
    jobBrief(job, false), 800);
  const musts = [...new Set((Array.isArray(out?.musts) ? out.musts : []).map((m: unknown) => clip(m, 80)).filter(Boolean))].slice(0, 8) as string[];
  if (musts.length) {
    const { data: row } = await admin.from("jobs").select("sourcing").eq("id", job.id).maybeSingle();
    await admin.from("jobs").update({ sourcing: { ...(row?.sourcing || {}), musts, musts_at: new Date().toISOString() } }).eq("id", job.id);
  }
  return musts;
}

export type LinkedInSnippet = { headline: string; snippet: string; engine: string; at: string };
// The public snippet a search engine shows for their exact LinkedIn profile: a search for the
// profile itself, then (if that doesn't find it) for their name and employer. Free searches only.
export async function linkedinSnippet(admin: any, url: string, name?: string | null, company?: string | null): Promise<LinkedInSnippet | null> {
  const pr = profileOf(url);
  if (!pr || pr.site !== "linkedin") return null;
  const slug = decodeURIComponent(pr.key.split("/in/")[1] || "").replace(/\/+$/, "");
  const nm = clip(name, 80).replace(/"/g, ""), co = clip(company, 80).replace(/"/g, "");
  // Always with their name in it: some engines (Tavily) refuse a search that is only site: terms.
  const queries = [slug && nm ? `site:linkedin.com/in/${slug} "${nm}"` : "", nm ? `site:linkedin.com/in "${nm}"${co ? ` "${co}"` : ""}` : ""].filter(Boolean);
  for (const q of queries) {
    const r = await searchWeb(admin, q);
    const h = r.hits.find((x) => profileOf(x.url)?.key === pr.key);
    if (h && (h.title || h.snippet)) return { headline: clip(h.title, 220), snippet: clip(h.snippet, 700), engine: h.engine, at: new Date().toISOString() };
    if (!r.engine) break;   // no free search left right now
  }
  return null;
}

export type CheckPerson = {
  id: string; title?: string | null; company?: string | null; location?: string | null; history?: string | null; headline?: string | null;
  linkedin?: { headline?: string; snippet?: string } | null;
  profile?: { headline?: string; summary?: string; skills?: string[]; history?: string; education?: string } | null;
};
export type CheckItem = { item: string; status: "met" | "not met" | "unconfirmed"; evidence: string };
export type Assessed = {
  overview: string; checklist: CheckItem[]; gaps: string[]; fit: number; verdict: string; reason: string;
  keep: boolean; why: string; coreMissing: string[]; coreUnconfirmed: string[];
};

const SYS = "You are a recruitment analyst checking people found in a contacts database (Apollo) against one job. For each person you get what the database has " +
  "(current title, employer, location, work history with what they did there, LinkedIn headline), and when found, the snippet a search engine shows from their public " +
  "LinkedIn profile, and sometimes their full profile (summary, skills, education, every job). Use ONLY what these show; never assume. Reply with STRICT JSON only: " +
  "{\"results\": [{\"id\": string, \"overview\": string, \"checklist\": [{\"item\": string, \"status\": \"met\" | \"unconfirmed\" | \"not met\", \"evidence\": string}], \"gaps\": string[], " +
  "\"fit\": number, \"verdict\": \"Perfect fit\" | \"Good fit\" | \"Possible fit\" | \"Not a fit\", \"reason\": string}]}. " +
  "overview: one or two plain sentences on who they are (current role, employer, relevant background) and how they line up with the job. " +
  "checklist: exactly the must-haves given, in the same order and wording. 'met' only when what they show clearly shows it. 'not met' ONLY when something shown contradicts it " +
  "(based somewhere else, a different field, clearly more junior or senior, or explicitly lacking it). Something simply not shown is ALWAYS 'unconfirmed', never 'not met'. " +
  "evidence: a few words from what they show, or '' when unconfirmed. " +
  "gaps: up to 3 short items: what is 'not met' first, then the most important 'unconfirmed' must-haves to confirm with them. " +
  "fit: a percentage from 0 to 100 (never a 0-10 score) for how promising they are to approach, judged on what they DO show: matching title, seniority, field, employer type and location count most. " +
  "'unconfirmed' items do not lower it; each 'not met' item lowers it a lot. " +
  "verdict: 'Not a fit' when any of the first three must-haves (the core ones) is 'not met', or the field, level or title clearly doesn't match. 'Good fit' or 'Perfect fit' only when title, seniority and field match and nothing is 'not met'. " +
  "reason: one short sentence naming the deciding points.";

function personText(p: CheckPerson) {
  const parts = [`id=${p.id}`, `Apollo: ${p.title || "?"} at ${p.company || "?"} | ${p.location || "?"}`];
  if (p.headline) parts.push(`LinkedIn headline (Apollo): ${clip(p.headline, 220)}`);
  if (p.history) parts.push(`Work history: ${clip(p.history, 900)}`);
  if (p.linkedin && (p.linkedin.headline || p.linkedin.snippet)) parts.push(`Public LinkedIn result: ${clip(p.linkedin.headline, 220)} | ${clip(p.linkedin.snippet, 700)}`);
  if (p.profile) {
    const f = p.profile;
    parts.push(`Full profile: ${[f.headline && "headline: " + clip(f.headline, 200), f.summary && "summary: " + clip(f.summary, 600), f.skills?.length && "skills: " + f.skills.slice(0, 25).join(", "),
      f.education && "education: " + clip(f.education, 300), f.history && "jobs: " + clip(f.history, 1500)].filter(Boolean).join(" | ")}`);
  }
  return parts.join("\n  ");
}

// The keep rule, in code (the AI's verdict alone never keeps anyone).
export function decide(checklist: CheckItem[], fit: number, verdict: string, reason: string) {
  const core = checklist.slice(0, 3);
  const coreMissing = core.filter((c) => c.status === "not met").map((c) => c.item);
  const coreUnconfirmed = core.filter((c) => c.status === "unconfirmed").map((c) => c.item);
  let why = "";
  if (coreMissing.length) why = "Misses a core must-have: " + coreMissing.join(", ");
  else if (verdict === "Not a fit") why = clip(reason, 200) || "Not a fit for this role";
  else if (fit < KEEP_FIT) why = `Fit ${fit}% is under ${KEEP_FIT}%`;
  return { keep: !why, why, coreMissing, coreUnconfirmed };
}

// Checks people against the role's must-haves, five at a time. Anyone whose batch failed (AI
// unavailable) is left out of the result, so the caller can check them again later.
export async function assessPeople(admin: any, job: any, people: CheckPerson[]): Promise<Map<string, Assessed>> {
  const out = new Map<string, Assessed>();
  if (!people.length) return out;
  const musts = await roleMustHaves(admin, job);
  for (let i = 0; i < people.length; i += 5) {
    const batch = people.slice(i, i + 5);
    let res: any = null;
    try {
      res = await askAI(SYS, jobBrief(job, false) + `\n\nMust-haves (the first three are the core ones):\n${musts.map((m) => "- " + m).join("\n") || "(none listed: judge on the job description)"}` +
        `\n\nPeople:\n${batch.map(personText).join("\n")}`, 9000);
    } catch (e) { console.error("must-haves batch", String((e as Error)?.message || e)); continue; }
    const rows = fitsToPercent(Array.isArray(res?.results) ? res.results : []);
    const byId = new Map(rows.map((r: any) => [String(r.id), r]));
    for (const p of batch) {
      const r: any = byId.get(p.id);
      if (!r) continue;
      const given = Array.isArray(r.checklist) ? r.checklist : [];
      const checklist: CheckItem[] = musts.map((m, k) => {
        const x = given.find((g: any) => clip(g?.item, 80).toLowerCase() === m.toLowerCase()) || given[k] || {};
        const st = (["met", "not met", "unconfirmed"].includes(x.status) ? x.status : "unconfirmed") as CheckItem["status"];
        return { item: m, status: st, evidence: st === "unconfirmed" ? "" : clip(x.evidence, 120) };
      });
      const fit = Math.max(0, Math.min(100, Math.round(Number(r.fit) || 0)));
      const verdict = ["Perfect fit", "Good fit", "Possible fit", "Not a fit"].includes(r.verdict) ? r.verdict : "Possible fit";
      const reason = clip(r.reason, 300);
      out.set(p.id, {
        overview: clip(r.overview, 400), checklist, gaps: (Array.isArray(r.gaps) ? r.gaps : []).map((g: unknown) => clip(g, 140)).filter(Boolean).slice(0, 3),
        fit, verdict, reason, ...decide(checklist, fit, verdict, reason),
      });
    }
  }
  return out;
}

// What a check saves on the prospect's data.
export function checkedData(a: Assessed, linkedin: LinkedInSnippet | null | undefined, by: string) {
  return {
    overview: a.overview, checklist: a.checklist, gaps: a.gaps, ...(linkedin ? { linkedin } : {}),
    core_unconfirmed: a.coreUnconfirmed, musts_v: MUSTS_V, musts_checked_at: new Date().toISOString(), musts_by: by,
  };
}
export const skippedData = (why: string, by: string) => ({ skipped: { by, reason: why, at: new Date().toISOString() } });

// Apollo people not yet checked this way, on roles that are Open or On hold: a batch per run.
// Waiting to be emailed and failing the check: skipped with the reason. Already emailed: their
// card gets the checklist (and the fit is updated), nothing else changes.
export async function recheckApollo(admin: any, max = 20, jobId?: string) {
  const { data: jobs } = jobId ? await admin.from("jobs").select("id").eq("id", jobId) : await admin.from("jobs").select("id").in("status", ["Open", "On hold"]);
  const jobIds = (jobs || []).map((j: any) => j.id);
  if (!jobIds.length) return { checked: 0, skipped: 0, remaining: 0, holdIds: [] as { jobId: string; ids: string[] }[] };
  const { data: rows } = await admin.from("prospects").select("id,job_id,status,title,company,location,linkedin_url,full_name,data")
    .eq("source", "apollo").is("data->>musts_v", null).in("job_id", jobIds).order("created_at", { ascending: false }).limit(max);
  const byJob = new Map<string, any[]>();
  for (const r of rows || []) byJob.set(r.job_id, [...(byJob.get(r.job_id) || []), r]);
  let checked = 0, skipped = 0;
  const holdIds: { jobId: string; ids: string[] }[] = [];
  for (const [jid, people] of byJob) {
    const { data: job } = await admin.from("jobs").select("*").eq("id", jid).maybeSingle();
    if (!job) continue;
    const li = new Map<string, LinkedInSnippet | null>();
    for (const p of people) li.set(p.id, p.data?.linkedin || (p.linkedin_url ? await linkedinSnippet(admin, p.linkedin_url, p.full_name, p.company).catch(() => null) : null));
    let res: Map<string, Assessed>;
    try {
      res = await assessPeople(admin, job, people.map((p) => ({ id: p.id, title: p.title, company: p.company, location: p.location, history: p.data?.history, headline: p.data?.headline, linkedin: li.get(p.id) })));
    } catch (e) { console.error("apollo recheck", jid, String((e as Error)?.message || e)); continue; }
    const hold: string[] = [];
    for (const p of people) {
      const a = res.get(p.id);
      if (!a) {
        // Snippet found but the AI couldn't check them this time: keep the snippet for next time.
        if (li.get(p.id) && !p.data?.linkedin) await admin.from("prospects").update({ data: { ...(p.data || {}), linkedin: li.get(p.id) } }).eq("id", p.id);
        continue;
      }
      checked++;
      const data = { ...(p.data || {}), ...checkedData(a, li.get(p.id), "catch-up") };
      const waiting = p.status === "found";
      if (waiting && !a.keep) {
        await admin.from("prospects").update({ status: "rejected", fit: a.fit, verdict: a.verdict, fit_reason: a.reason || null, data: { ...data, ...skippedData(a.why, "must-have check") } }).eq("id", p.id);
        skipped++;
        continue;
      }
      await admin.from("prospects").update({ fit: a.fit, verdict: a.verdict, fit_reason: a.reason || null, data }).eq("id", p.id);
      if (waiting && a.coreUnconfirmed.length) hold.push(p.id);
    }
    if (hold.length) holdIds.push({ jobId: jid, ids: hold });
  }
  const { count } = await admin.from("prospects").select("id", { count: "exact", head: true }).eq("source", "apollo").is("data->>musts_v", null).in("job_id", jobIds);
  return { checked, skipped, remaining: count ?? 0, holdIds };
}
