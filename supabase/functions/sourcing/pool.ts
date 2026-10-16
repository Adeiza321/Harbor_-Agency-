// Talent pool: people sourced for roles that have since closed (prospects.status = 'archived', see
// migration 20261012h_talent_pool.sql). When a new role goes live (or someone clicks "Search outside"
// on it), the pool is checked before any outside search:
//   1. same country as the new role (their own, or the closed role's when theirs isn't known)
//   2. a matching title: their headline, or the title of the role they were found for
//   3. not opted out since, not already on this role, not already a ProNext candidate
//   4. the AI checks the best 30 against the new role; good and possible fits (60%+) are added to
//      the role as "Needs approval", with a fresh draft for anyone with an email
// Nothing is sent and no credits are used: approval works exactly as for any other sourced person.

import { askAI } from "./ai.ts";
import { draftEmails } from "./emails.ts";
import { jobBrief, searchArea } from "./prospects.ts";
import { splitByArea } from "./area_check.ts";
import { countryCode, jobCountryCode, jobCountryNames, regionOf } from "./regions.ts";
import { profileOf } from "./search.ts";
import { emailHash, normEmail } from "./send.ts";
import { fitsToPercent, sameCompany, titlesMatch, type Settings } from "./common.ts";

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const MAX_CHECK = 30;
const MIN_FIT = 60;
// Kept from the earlier role: who they are and how we reached them; not that role's checklist.
const KEEP = ["xray", "profile_url", "site", "engine", "snippet", "result_title", "history", "domain", "email_lookup", "email_source", "emails_found"];

export async function matchPool(admin: any, job: any, s: Settings, agencyName: string) {
  const code = jobCountryCode(job);
  if (!code) return { ok: true, matched: 0, message: "Add a hiring country to this job to check the talent pool." };
  const titles = [job.role_title, ...(Array.isArray(job.parallel_titles) ? job.parallel_titles : [])].filter(Boolean).map(String);

  const { data: pool, error } = await admin.from("prospects")
    .select("id,job_id,source,external_id,first_name,last_name,full_name,title,company,location,country,linkedin_url,email,email_status,fit_reason,data,contacted_at,archived_at,jobs(role_title,country,location)")
    .eq("status", "archived").neq("job_id", job.id).order("archived_at", { ascending: false }).limit(1000);
  if (error) throw new Error(error.message);
  if (!pool?.length) return { ok: true, matched: 0, checked: 0, message: "The talent pool is empty." };

  const { data: here } = await admin.from("prospects").select("external_id").eq("job_id", job.id);
  const seen = new Set((here || []).map((x: any) => String(x.external_id || "")));
  // Anyone who is now a ProNext candidate is found by the bench check instead.
  const { data: cands } = await admin.from("candidates").select("email,linkedin_url");
  const candEmails = new Set((cands || []).map((c: any) => normEmail(c.email || "")).filter(Boolean));
  const candProfiles = new Set((cands || []).map((c: any) => profileOf(c.linkedin_url || "")?.key).filter(Boolean));

  const short: { p: any; score: number }[] = [];
  for (const p of pool) {
    const key = String(p.external_id || "");
    if (!key || seen.has(key)) continue;
    seen.add(key); // newest entry per person only
    const pc = countryCode(p.country) || jobCountryCode(p.jobs || {});
    if (pc !== code) continue;
    if (sameCompany(p.company, job.client)) continue;
    if (p.email && candEmails.has(normEmail(p.email))) continue;
    if (p.linkedin_url && candProfiles.has(profileOf(p.linkedin_url)?.key)) continue;
    const score = titlesMatch(titles, [p.title, p.jobs?.role_title].filter(Boolean));
    if (score >= 0.6) short.push({ p, score });
  }
  short.sort((a, b) => b.score - a.score);
  const picks: any[] = [];
  for (const { p } of short) {
    if (picks.length >= MAX_CHECK) break;
    if (p.email) {
      const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(p.email)).maybeSingle();
      if (sup) continue;
    }
    picks.push(p);
  }
  const record = async (pool: Record<string, unknown>) => {
    const { data: cur } = await admin.from("jobs").select("sourcing").eq("id", job.id).maybeSingle();
    await admin.from("jobs").update({ sourcing: { ...(cur?.sourcing || {}), pool: { at: new Date().toISOString(), ...pool } } }).eq("id", job.id);
  };
  if (!picks.length) { await record({ checked: 0, matched: 0 }); return { ok: true, matched: 0, checked: 0, message: "No one in the talent pool matches this role." }; }

  const sys = "You are a recruitment analyst. These people were found for an earlier, similar role that has closed. Judge how well each fits this NEW job from what we know: " +
    "their current title, employer, location, work history and the earlier role they were found for. Reply with STRICT JSON only: " +
    "{\"results\": [{\"i\": number, \"fit\": number (a percentage from 0 to 100; never a 0-10 score), \"verdict\": \"Good fit\" | \"Possible fit\" | \"Not a fit\", \"reason\": string}]}. " +
    "reason: one short sentence on why they fit this job, or what is missing. Be strict about seniority, field and location; 'Not a fit' when they clearly don't match or work for the hiring company.";
  const list = picks.map((p, i) => `${i} | ${p.title || "?"} at ${p.company || "?"} | ${p.location || p.country || "?"} | found for: ${p.jobs?.role_title || "?"} | ${clip(p.data?.history || p.data?.snippet || p.fit_reason, 300)}`).join("\n");
  const out = await askAI(sys, jobBrief(job, false) + `\nHiring company: ${job.client || "(not given)"}\n\nPeople (i | title at employer | location | earlier role | background):\n` + list, 4000);
  const rows: any[] = [];
  for (const r of fitsToPercent(Array.isArray(out?.results) ? out.results : [])) {
    const p = picks[Number(r.i)];
    if (!p || r.verdict === "Not a fit" || Number(r.fit) < MIN_FIT) continue;
    const kept: Record<string, unknown> = {};
    for (const k of KEEP) if (p.data && p.data[k] !== undefined) kept[k] = p.data[k];
    const cc = countryCode(p.country);
    rows.push({
      job_id: job.id, source: p.source, external_id: p.external_id,
      first_name: p.first_name, last_name: p.last_name, full_name: p.full_name, title: p.title, company: p.company, location: p.location,
      country: p.country, region: cc ? regionOf(cc) : null, linkedin_url: p.linkedin_url, email: p.email, email_status: p.email_status,
      fit: Math.max(0, Math.min(100, Math.round(Number(r.fit) || 0))), verdict: r.verdict === "Good fit" ? "Good fit" : "Possible fit",
      fit_reason: clip(r.reason, 300) || null, status: "found",
      data: { ...kept, overview: clip(r.reason, 400), pool: { fromProspect: p.id, fromJob: p.job_id, fromRole: p.jobs?.role_title || p.data?.archived_role || null, contactedBefore: !!p.contacted_at, at: new Date().toISOString() } },
    });
  }
  // Where they are, checked against the new role's office (on-site / hybrid) or country (remote).
  if (rows.length) {
    const area = await searchArea(admin, job, jobCountryNames(job)).catch(() => null);
    const { kept: ok } = await splitByArea(admin, job, area, rows, (r: any) => r.location || "");
    rows.splice(0, rows.length, ...ok.map(({ p, note, hold }) => (note ? { ...p, data: { ...p.data, gaps: [note], location_hold: hold || null } } : p)));
  }
  let ids: string[] = [];
  if (rows.length) {
    const { data, error: e2 } = await admin.from("prospects").upsert(rows, { onConflict: "job_id,external_id", ignoreDuplicates: true }).select("id,email");
    if (e2) throw new Error(e2.message);
    ids = (data || []).map((x: any) => x.id);
    const withEmail = (data || []).filter((x: any) => x.email).map((x: any) => x.id);
    if (withEmail.length) await draftEmails(admin, withEmail, s, agencyName);
  }
  await record({ checked: picks.length, matched: ids.length });
  return { ok: true, matched: ids.length, checked: picks.length, ids,
    message: ids.length ? `${ids.length} ${ids.length === 1 ? "person" : "people"} from the talent pool added to this role for approval.` : `Checked ${picks.length} from the talent pool; none fit this role well enough.` };
}
