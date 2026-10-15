// New people for one job from People Data Labs (paid: 1 credit per person returned; an Admin
// approves it like an Apollo search).
//   1. search: the job's title and parallel titles, in the job's search area (commutable cities for
//      on-site / hybrid roles, the state, or the preferred time-zone states for remote roles, else the
//      country), only people PDL has an email for, the client's own staff left out
//   2. drop anyone already found for this job, already in ProNext, unsubscribed, or who has worked
//      at the client
//   3. AI checks each full profile (current title, employer, place, work history, skills) against
//      the job's must-haves: what the profile doesn't show is "unconfirmed", not "not met"; keeps
//      Perfect / Good fits (or 65%+), with the unconfirmed must-haves as "Gaps to check"
//   4. saved as prospects (source "pdl") with the usual short, personal draft, for approval

import { askAI } from "./ai.ts";
import { pdlKey, pdlSearch, bestPdlEmail, type PdlPerson } from "./pdl.ts";
import { jobBrief, searchArea } from "./prospects.ts";
import { draftEmails } from "./emails.ts";
import { COUNTRY_NAMES, countryCode, jobCountryCode, jobCountryNames, regionOf } from "./regions.ts";
import { emailHash, normEmail } from "./send.ts";
import { fitsToPercent, sameCompany, workedAt, type Settings } from "./common.ts";

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function sourcePdl(admin: any, jobId: string, s: Settings, agencyName: string, opts: { checkOnly?: boolean } = {}) {
  if (!pdlKey()) return { ok: false, notConnected: "pdl", message: "People Data Labs isn't connected yet. Add the PDL_API_KEY secret first." };
  const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).single();
  if (!job) throw new Error("Job not found");
  if (job.status === "Closed") return { ok: false, message: "This role is closed." };
  const code = jobCountryCode(job);
  const country = code ? COUNTRY_NAMES[code] : "";
  if (!country) return { ok: false, message: "Add a hiring country to this job first. People are only searched in the job's own country." };
  const titles = [...new Set([job.role_title, ...(Array.isArray(job.parallel_titles) ? job.parallel_titles : [])].filter(Boolean))].slice(0, 8);
  const area = await searchArea(admin, job, jobCountryNames(job));
  const remote = String(job.work_setup || "").toLowerCase() === "remote";
  // Cities for a commute area (the first part of "Croydon, London"); states for state-wide or
  // time-zone areas; otherwise the whole country.
  const cities = area?.mode === "commute" ? area.locations.map((l) => l.split(",")[0].trim()) : [];
  const regions = area && (area.mode === "region" || area.mode === "timezone") ? area.locations : [];
  const where = area?.summary || (remote ? "Remote: anywhere in " + country : country);
  if (opts.checkOnly) return { ok: true, needed: true, jobTitle: job.role_title, client: job.client, area: where };

  const record = async (pdl: Record<string, unknown>) => {
    const { data: cur } = await admin.from("jobs").select("sourcing").eq("id", jobId).single();
    await admin.from("jobs").update({ sourcing: { ...(cur?.sourcing || {}), pdl: { at: new Date().toISOString(), ...pdl } } }).eq("id", jobId);
  };

  // 1. Search
  const { people, total } = await pdlSearch({ titles, country, cities, regions, excludeCompany: job.client, size: s.pdlPerSearch });
  const credits = people.length;
  if (people.some((p) => p.contactsHidden)) {
    await record({ searched: total, returned: credits, kept: 0, error: "Your People Data Labs plan hides emails (free plan)" });
    return { ok: false, credits, message: "People Data Labs found people but your plan hides their emails (the free plan does). Upgrade the PDL plan to use it for outreach." };
  }

  // 2. Leave out people already found, already in ProNext, unsubscribed, or ex-client staff.
  const { data: existing } = await admin.from("prospects").select("external_id,linkedin_url,email").eq("job_id", jobId);
  const seenIds = new Set((existing || []).map((x: any) => x.external_id));
  const seenLi = new Set((existing || []).map((x: any) => String(x.linkedin_url || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "")).filter(Boolean));
  const seenMail = new Set((existing || []).map((x: any) => normEmail(x.email || "")).filter(Boolean));
  const { data: candRows } = await admin.from("candidates").select("email,linkedin_url").or("email.not.is.null,linkedin_url.not.is.null");
  const inPronext = new Set((candRows || []).flatMap((c: any) => [c.email ? normEmail(c.email) : "", c.linkedin_url ? String(c.linkedin_url).toLowerCase().replace(/^https?:\/\/(www\.)?/, "") : ""]).filter(Boolean));
  const fresh: { p: PdlPerson; email: string; status: string }[] = [];
  let dropped = 0;
  for (const p of people) {
    const best = bestPdlEmail(p);
    const li = p.linkedin_url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "");
    const mail = normEmail(best.email);
    if (!best.email || seenIds.has("pdl:" + p.id) || (li && (seenLi.has(li) || inPronext.has(li))) || seenMail.has(mail) || inPronext.has(mail)) { dropped++; continue; }
    if (sameCompany(p.company, job.client) || workedAt([p.company, ...p.employers], job.client)) { dropped++; continue; }
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(best.email)).limit(1);
    if (sup?.length) { dropped++; continue; }
    fresh.push({ p, email: best.email, status: best.status });
  }
  if (!fresh.length) {
    await record({ searched: total, returned: credits, kept: 0, where });
    return { ok: true, found: 0, credits, message: total ? `People Data Labs returned ${credits} ${credits === 1 ? "person" : "people"}, all already found, in ProNext or ruled out (${credits} credits used).` : "People Data Labs has nobody matching this role in the search area (no credits used)." };
  }

  // 3. Fit check on the full profile.
  const checklist: string[] = Array.isArray(job.xray?.checklist) ? job.xray.checklist : [];
  const fitSys = "You are a strict, honest recruitment analyst. For each person, judge fit for the job from their current title, employer, location, work history, skills and years of experience. " +
    "Missing information is 'unconfirmed', never 'not met': only rule someone out for what the profile clearly shows (a different field or seniority, or living outside the job's area for an on-site role). " +
    "Reply with STRICT JSON only: {\"results\": [{\"id\": string, \"fit\": number (a percentage 0-100), \"verdict\": \"Perfect fit\" | \"Good fit\" | \"Possible fit\" | \"Not a fit\", " +
    "\"overview\": string (two sentences on who they are and how they match), \"gaps\": string[] (must-haves the profile doesn't confirm, short), \"reason\": string (one sentence naming the deciding points)}]}. " +
    "'Good fit' only when most must-haves are clearly shown.";
  const head = jobBrief(job, false) + (checklist.length ? "\nMust-haves to check: " + checklist.join("; ") : "");
  const lines = fresh.map(({ p }) => `id=${p.id} | ${p.title} at ${p.company} | ${[p.city, p.region, p.country].filter(Boolean).join(", ")} | ${p.years != null ? p.years + " yrs experience | " : ""}history: ${clip(p.history, 600) || "?"} | skills: ${p.skills.slice(0, 15).join(", ") || "?"}`).join("\n");
  const out = await askAI(fitSys, head + "\n\nPeople:\n" + lines, 8000);
  const byId: Record<string, any> = {};
  for (const r of fitsToPercent(Array.isArray(out?.results) ? out.results : [])) byId[String(r.id)] = r;
  const keep = fresh.filter(({ p }) => { const r = byId[p.id]; return r && (["Perfect fit", "Good fit"].includes(r.verdict) || Number(r.fit) >= 65); });
  if (!keep.length) {
    await record({ searched: total, returned: credits, kept: 0, where });
    return { ok: true, found: 0, credits, message: `Checked ${fresh.length} people from People Data Labs; none were a strong enough fit (${credits} credits used).` };
  }

  // 4. Save and draft.
  const rows = keep.map(({ p, email, status }) => {
    const r = byId[p.id] || {};
    const cc = countryCode(p.country);
    return {
      job_id: jobId, source: "pdl", external_id: "pdl:" + p.id,
      first_name: p.first_name || null, last_name: p.last_name || null, full_name: p.name || `${p.first_name} ${p.last_name}`.trim(),
      title: p.title || null, company: p.company || null, location: [p.city, p.region].filter(Boolean).join(", ") || p.location || null,
      country: cc || p.country || null, region: cc ? regionOf(cc) : null,
      linkedin_url: p.linkedin_url || null, email, email_status: status,
      fit: Math.max(0, Math.min(100, Math.round(Number(r.fit) || 0))), verdict: String(r.verdict || ""), fit_reason: clip(r.reason, 300),
      status: "found",
      data: { history: clip(p.history, 1200), overview: clip(r.overview, 600), gaps: (Array.isArray(r.gaps) ? r.gaps : []).map((g: unknown) => clip(g, 120)).slice(0, 6),
        skills: p.skills.slice(0, 15), years: p.years, phones: p.phones, email_source: "People Data Labs", pdl: { id: p.id } },
    };
  });
  const { data: inserted, error } = await admin.from("prospects").upsert(rows, { onConflict: "job_id,external_id", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(error.message);
  const ids = (inserted || []).map((x: any) => x.id);
  if (ids.length) await draftEmails(admin, ids, s, agencyName);
  await record({ searched: total, returned: credits, kept: ids.length, where });
  return { ok: true, found: ids.length, ids, credits, message: `People Data Labs: ${ids.length} strong ${ids.length === 1 ? "match" : "matches"} added for approval, out of ${credits} returned (${credits} credits used${dropped ? `; ${dropped} already found, in ProNext or ruled out` : ""}).` };
}
