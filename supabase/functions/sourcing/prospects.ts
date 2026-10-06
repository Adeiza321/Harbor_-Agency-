// Outside candidates for one job (Apollo), only after the bench has been checked.
//   1. search (free): the job's parallel titles, in the job's location (or country if remote),
//      people with a verified work email only
//   2. AI ranks the search results on title, seniority and employer; only the best get revealed
//   3. reveal emails (1 Apollo credit each) up to the per-job limit; drop anyone unsubscribed,
//      already in Pronext, or outside the target regions
//   4. AI checks each revealed profile against the job; keeps Perfect/Good fits
//   5. AI writes each person a short email; saved as prospects for review (or queued if auto)

import { askAI } from "./ai.ts";
import { searchPeople, matchById, apolloKey, type ApolloPerson } from "./apollo.ts";
import { COUNTRY_NAMES, countryCode, jobCountryCode, regionOf, targetCodes } from "./regions.ts";
import { emailHash, normEmail } from "./send.ts";
import { anonymizeJd, fitsToPercent, historyEmployers, sameCompany, workedAt, type Settings } from "./common.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function jobBrief(job: any, includePay: boolean) {
  const pay = includePay && (job.min_pay || job.max_pay) && !job.commission_only
    ? `\nPay: ${job.min_pay || "?"} to ${job.max_pay || "?"} ${job.currency || ""} ${String(job.salary_period || "Yearly").toLowerCase()}` : "";
  return `Job: ${job.role_title}\nLocation: ${job.location || "?"}${job.work_setup ? " (" + job.work_setup + ")" : ""}${job.employment_type ? "\nEmployment: " + job.employment_type : ""}${pay}\n` +
    `Description:\n${String(job.description || "").slice(0, 3500)}`;
}

export type SearchArea = { mode: "commute" | "region" | "timezone" | "country"; locations: string[]; summary: string; key: string; at: string };
// US states by main time zone, so a time zone preference always covers every state in it.
const US_TZ_STATES: Record<string, string[]> = {
  eastern: ["Connecticut", "Delaware", "District of Columbia", "Florida", "Georgia", "Indiana", "Maine", "Maryland", "Massachusetts", "Michigan", "New Hampshire", "New Jersey", "New York", "North Carolina", "Ohio", "Pennsylvania", "Rhode Island", "South Carolina", "Vermont", "Virginia", "West Virginia", "Kentucky"],
  central: ["Alabama", "Arkansas", "Illinois", "Iowa", "Kansas", "Louisiana", "Minnesota", "Mississippi", "Missouri", "Nebraska", "North Dakota", "Oklahoma", "South Dakota", "Tennessee", "Texas", "Wisconsin"],
  mountain: ["Arizona", "Colorado", "Idaho", "Montana", "New Mexico", "Utah", "Wyoming"],
  pacific: ["California", "Nevada", "Oregon", "Washington"],
  alaska: ["Alaska"], hawaii: ["Hawaii"],
};
async function areaKey(job: any) {
  const raw = ["v2", job.work_setup, job.location, job.country, String(job.description || "").slice(0, 4000)].join("|");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Where to look for people. On-site and hybrid jobs: the job's city (and any other office the
// description names) plus places within about an hour's commute. A job located only by state or
// region: that whole state. Remote jobs: the states in the time zones the description prefers,
// or the whole country when it states none. Worked out once by the AI and kept on the job
// (recomputed only if the location, setup or description changes). No Apollo credits are used.
export async function searchArea(admin: any, job: any, fallbackCountries: string[]): Promise<SearchArea | null> {
  const key = await areaKey(job);
  const cached = job.sourcing?.area;
  if (cached?.key === key && Array.isArray(cached.locations) && cached.locations.length) return cached;
  const sys = "You decide where a recruiter should search for candidates for one job, for a people-search tool that matches on place names. Reply with STRICT JSON only: " +
    "{\"remote\": boolean, \"offices\": string[], \"stateOnly\": string, \"places\": [{\"place\": string, \"minutes\": number}], \"timeZones\": string[], \"regions\": string[], \"country\": string}. " +
    "remote: true if the job is fully remote, judged from the work setup and also the location or description (e.g. 'Fully remote (US)'). Hybrid and on-site are not remote. " +
    "If NOT remote: offices = the job's office cities, written 'City, State' in the US (full state name) or 'City, Country' elsewhere (the job's location, plus any other office the description says the role can be based in). " +
    "If the location is only a state or region with no city (e.g. 'Virginia'), set stateOnly to that state's full name and leave offices and places empty. " +
    "places = towns and cities people realistically commute from to any of the offices, with minutes = typical one-way drive time in normal traffic; include only real places within 60 minutes; fewer is fine, never pad the list; at most 12 per office. " +
    "If remote: timeZones = the time zones the description prefers or requires, as lowercase words from: eastern, central, mountain, pacific, alaska, hawaii (US), or the zone names used in that country; [] if none stated. " +
    "regions = only for a remote job outside the US with a time zone preference: the states/provinces/regions of that country in those zones (full names). " +
    "country = the hiring country's full name.";
  const text = `Job: ${job.role_title}\nWork setup: ${job.work_setup || "(not set)"}\nLocation: ${job.location || "(not set)"}\nHiring country: ${job.country || fallbackCountries.join(", ") || "(not set)"}\nDescription:\n${String(job.description || "").slice(0, 4000)}`;
  let out: any = null;
  try { out = await askAI(sys, text, 1500); } catch (e) { console.error("search area", String((e as Error)?.message || e)); }
  if (!out) return null;
  const clean = (xs: unknown) => [...new Set((Array.isArray(xs) ? xs : []).map((x) => String(x || "").trim()).filter(Boolean))] as string[];
  const country = String(out.country || job.country || "").trim();
  const isUS = /^(us|usa|united states)/i.test(country);
  let area: Omit<SearchArea, "key" | "at"> | null = null;
  if (out.remote) {
    const zones = clean(out.timeZones).map((z) => z.toLowerCase().replace(/ time$/, ""));
    const states = isUS ? [...new Set(zones.flatMap((z) => US_TZ_STATES[z] || []))] : clean(out.regions);
    const zoneText = zones.map((z) => z.charAt(0).toUpperCase() + z.slice(1)).join(" and ");
    area = states.length
      ? { mode: "timezone", locations: states, summary: `Remote: ${zoneText} time zone${zones.length > 1 ? "s" : ""} (${states.length} ${isUS ? "states" : "regions"})` }
      : country ? { mode: "country", locations: [country], summary: `Remote: anywhere in ${country}` } : null;
  } else if (String(out.stateOnly || "").trim()) {
    const st = String(out.stateOnly).trim();
    area = { mode: "region", locations: [st], summary: `All of ${st}` };
  } else {
    const offices = clean(out.offices);
    const near = (Array.isArray(out.places) ? out.places : [])
      .filter((p: any) => p && String(p.place || "").trim() && Number(p.minutes) > 0 && Number(p.minutes) <= 60)
      .map((p: any) => String(p.place).trim());
    const locations = [...new Set([...offices, ...near])].slice(0, 40);
    if (locations.length) area = { mode: "commute", locations, summary: `${offices.join(" and ") || locations[0]}${near.length ? ` and ${near.length} place${near.length > 1 ? "s" : ""} within an hour's commute` : ""}` };
  }
  if (!area || !area.locations.length) return null;
  const full: SearchArea = { ...area, summary: area.summary.slice(0, 200), key, at: new Date().toISOString() };
  job.sourcing = { ...(job.sourcing || {}), area: full };
  await admin.from("jobs").update({ sourcing: job.sourcing }).eq("id", job.id);
  return full;
}

export async function sourceExternal(admin: any, jobId: string, s: Settings, opts: { force?: boolean; checkOnly?: boolean } = {}) {
  if (!apolloKey()) return { ok: false, notConnected: "apollo", message: "Apollo isn't connected yet. Add the APOLLO_API_KEY secret to search outside Pronext." };
  const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).single();
  if (!job) throw new Error("Job not found");
  const record = async (external: Record<string, unknown>) => {
    await admin.from("jobs").update({ sourcing: { ...(job.sourcing || {}), state: "done", external: { at: new Date().toISOString(), ...external } } }).eq("id", jobId);
  };

  const good = Number(job.sourcing?.internal?.goodFits || 0);
  if (!opts.force && good >= s.minInternalFits) {
    await record({ skipped: `The bench already has ${good} strong fits` });
    return { ok: true, skipped: true, message: `Your bench already has ${good} strong fits, so no outside search was needed.` };
  }

  const allowed = targetCodes(s.regions);
  const code = jobCountryCode(job);
  if (code && !allowed.includes(code)) {
    await record({ skipped: "Job is outside the target regions" });
    return { ok: true, skipped: true, message: "This job is outside your target regions (Outreach > Setup)." };
  }

  const titles = [...new Set([job.role_title, ...(Array.isArray(job.parallel_titles) ? job.parallel_titles : [])].filter(Boolean))].slice(0, 8);
  const remote = String(job.work_setup || "").toLowerCase() === "remote";
  const countryName = code ? COUNTRY_NAMES[code] : "";
  // Commutable cities for on-site/hybrid, preferred time zones for remote (see searchArea);
  // falls back to the plain location or country if that can't be worked out.
  const area = await searchArea(admin, job, allowed.map((c) => COUNTRY_NAMES[c]).filter(Boolean));
  const locations = area ? area.locations : remote
    ? (countryName ? [countryName] : allowed.map((c) => COUNTRY_NAMES[c]).filter(Boolean))
    : [job.location || countryName].filter(Boolean);
  if (!locations.length) { await record({ error: "The job has no location or country" }); return { ok: false, message: "Add a location or country to the job first." }; }
  // Checks passed: an outside search is needed. With checkOnly nothing is spent; the caller
  // asks an Admin to approve the Apollo credits first.
  if (opts.checkOnly) return { ok: true, needed: true, jobTitle: job.role_title, client: job.client, area: area?.summary || "" };

  // 1. Search
  const { hits, total } = await searchPeople({ titles, locations, perPage: 100 });
  const { data: existing } = await admin.from("prospects").select("external_id,status").or(`job_id.eq.${jobId},status.eq.unsubscribed`);
  const seen = new Set((existing || []).map((x: any) => x.external_id));
  // Never approach people who work for the client: they'd be pitched their own employer's job.
  const fresh = hits.filter((h) => h.has_email && !seen.has(h.id) && !sameCompany(h.company, job.client));
  if (!fresh.length) { await record({ searched: total, ranked: 0, revealed: 0, kept: 0 }); return { ok: true, found: 0, message: "Apollo found nobody new for this job." }; }

  // 2. Rank on what the search shows (free), so credits go only to the likeliest fits.
  const rankSys = "You are a recruitment researcher. From the list, pick the people most likely to fit the job on title, seniority and employer type. " +
    "Reply with STRICT JSON only: {\"picks\": [{\"i\": number, \"score\": number}]} with score 0-100, best first, only score 55 or more, at most " + (s.prospectsPerJob * 2) + ".";
  const list = fresh.slice(0, 100).map((h, i) => `${i} | ${h.title} | ${h.company}`).join("\n");
  const ranked = await askAI(rankSys, jobBrief(job, false) + "\n\nPeople (index | title | employer):\n" + list, 3000);
  const picks = (Array.isArray(ranked?.picks) ? ranked.picks : []).map((p: any) => fresh[Number(p.i)]).filter(Boolean);

  // 3. Reveal emails for the best, within the per-job limit.
  const { data: candEmails } = await admin.from("candidates").select("email").not("email", "is", null);
  const inPronext = new Set((candEmails || []).map((c: any) => normEmail(c.email)));
  const people: ApolloPerson[] = [];
  let revealed = 0;
  for (const h of picks) {
    if (people.length >= s.prospectsPerJob || revealed >= s.prospectsPerJob * 2) break;
    let p: ApolloPerson | null = null;
    try { p = await matchById(h.id); revealed++; } catch (e) { console.error("apollo match", String((e as Error)?.message || e)); break; }
    await sleep(700);
    if (!p?.email || p.email_status !== "verified") continue;
    if (inPronext.has(normEmail(p.email))) continue;
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(p.email)).maybeSingle();
    if (sup) continue;
    const pc = countryCode(p.country);
    if (pc && !allowed.includes(pc)) continue;
    // Nor anyone who has worked there before (from their full employment history).
    if (workedAt([p.company, ...historyEmployers(p.history)], job.client)) continue;
    people.push(p);
  }
  if (!people.length) { await record({ searched: total, ranked: picks.length, revealed, kept: 0 }); return { ok: true, found: 0, message: "No new people with verified emails matched." }; }

  // 4. Fit check on the full profile.
  const fitSys = "You are a recruitment analyst. For each person, judge fit for the job from their title, employer, location and work history: " +
    "must-have experience, seniority and location/work setup. Reply with STRICT JSON only: {\"results\": [{\"id\": string, \"fit\": number (a percentage from 0 to 100, e.g. 85; never a 0-10 score), \"verdict\": \"Perfect fit\" | \"Good fit\" | \"Possible fit\" | \"Not a fit\", \"reason\": string}]}. " +
    "reason: one short sentence naming the deciding points. Be strict: 'Good fit' only when most must-haves are clearly shown.";
  const profiles = people.map((p) => `id=${p.id} | ${p.title} at ${p.company} | ${[p.city, p.state, p.country].filter(Boolean).join(", ")} | history: ${p.history || "?"}`).join("\n");
  const fits = await askAI(fitSys, jobBrief(job, false) + "\n\nPeople:\n" + profiles, 4000);
  const byId: Record<string, any> = {};
  for (const r of fitsToPercent(Array.isArray(fits?.results) ? fits.results : [])) byId[String(r.id)] = r;
  const keep = people.filter((p) => { const r = byId[p.id]; return r && (["Perfect fit", "Good fit"].includes(r.verdict) || Number(r.fit) >= 70); });
  if (!keep.length) { await record({ searched: total, ranked: picks.length, revealed, kept: 0 }); return { ok: true, found: 0, message: `Checked ${people.length} people; none were a strong enough fit.` }; }

  // 5. Draft a short, personal email for each.
  const mailSys = "You write short, honest recruiting emails to professionals who have not heard from us before. Reply with STRICT JSON only: " +
    "{\"emails\": [{\"id\": string, \"subject\": string, \"body\": string}]}. Rules: subject under 60 characters, no clickbait. Body 90-140 words, plain text, in this order: " +
    "(1) 'Hi <first name>,' " +
    "(2) introduce the sender in one short sentence: their first name, their title if given, and the agency name if given (e.g. 'I'm Ahmed, a recruiter at Pronext.'). " +
    "(3) say we're recruiting for the role (title, seniority, location or remote, and pay if given) and came across their profile in a professional-contacts database while searching for people with their experience (never claim we met, were referred, or saw them on LinkedIn). " +
    "NEVER name the hiring company: describe it instead (e.g. 'a US fintech') from the description. " +
    "(4) say we think they'd be a good fit because ... and give the specific reasons from their title, employer and work history (one or two sentences). " +
    "(5) the line 'Here's the full job description:' and, on the next line, exactly {{JOB_DESCRIPTION}} (it is replaced with the description; don't summarise it yourself). " +
    "(6) the line: 'If it feels like a good fit, click here to let me know you're interested: {{INTERESTED_LINK}} (or just reply to this email).' " +
    "(7) a sign-off line with only the sender's first name. No postscript, no footer, no unsubscribe text (added separately). Keep {{JOB_DESCRIPTION}} and {{INTERESTED_LINK}} exactly as written. The 90-140 words don't include the job description.";
  const who = keep.map((p) => `id=${p.id} | first name: ${p.first_name} | ${p.title} at ${p.company} | ${p.history.slice(0, 300)}`).join("\n");
  const { data: ag } = await admin.from("agency_settings").select("agency_name").limit(1).maybeSingle();
  const sender = `Sender first name: ${(s.senderName || "").split(" ")[0] || "the recruiter"}\nSender title: ${s.senderTitle || "(not given)"}\nAgency name: ${String(ag?.agency_name || "").trim() || "(not given)"}`;
  const mails = await askAI(mailSys, jobBrief(job, s.includePay) + `\n\n${sender}\n\nPeople:\n` + who, 6000);
  const mailById: Record<string, any> = {};
  for (const m of Array.isArray(mails?.emails) ? mails.emails : []) mailById[String(m.id)] = m;

  const rows = keep.map((p) => {
    const r = byId[p.id] || {}, m = mailById[p.id] || {};
    const cc = countryCode(p.country);
    return {
      job_id: jobId, source: "apollo", external_id: p.id,
      first_name: p.first_name, last_name: p.last_name, full_name: p.name || `${p.first_name} ${p.last_name}`.trim(),
      title: p.title, company: p.company, location: [p.city, p.state].filter(Boolean).join(", "), country: cc || p.country, region: regionOf(cc),
      linkedin_url: p.linkedin_url, email: p.email, email_status: p.email_status,
      fit: Math.max(0, Math.min(100, Math.round(Number(r.fit) || 0))), verdict: String(r.verdict || ""), fit_reason: String(r.reason || "").slice(0, 300),
      subject: String(m.subject || `${job.role_title} opportunity`).slice(0, 120),
      // The full description goes in the email itself, with the client's name taken out.
      body: String(m.body || "").slice(0, 3000).replace("{{JOB_DESCRIPTION}}", anonymizeJd(job.description, job.client).slice(0, 6000) || "(see the link below)"),
      status: "found", data: { history: p.history, domain: p.domain },
    };
  });
  const { data: inserted, error } = await admin.from("prospects").upsert(rows, { onConflict: "job_id,external_id", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(error.message);
  await record({ searched: total, ranked: picks.length, revealed, kept: rows.length });
  return { ok: true, found: rows.length, ids: (inserted || []).map((x: any) => x.id), revealed, message: `Found ${rows.length} strong outside ${rows.length === 1 ? "match" : "matches"} (${revealed} Apollo credits used).` };
}
