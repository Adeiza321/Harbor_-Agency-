// Outside candidates for one job (Apollo), only after the bench has been checked.
//   1. search (free): the job's parallel titles, in the job's location (or country if remote),
//      people with a verified work email only
//   2. AI ranks the search results on title, seniority and employer; only the best get revealed
//   3. reveal emails (1 Apollo credit each) up to the per-job limit; drop anyone unsubscribed,
//      already in Harbor, or outside the target regions
//   4. AI checks each revealed profile against the job; keeps Perfect/Good fits
//   5. AI writes each person a short email; saved as prospects for review (or queued if auto)

import { askAI } from "./ai.ts";
import { searchPeople, matchById, apolloKey, type ApolloPerson } from "./apollo.ts";
import { COUNTRY_NAMES, countryCode, jobCountryCode, regionOf, targetCodes } from "./regions.ts";
import { emailHash, normEmail } from "./send.ts";
import type { Settings } from "./common.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function jobBrief(job: any, includePay: boolean) {
  const pay = includePay && (job.min_pay || job.max_pay) && !job.commission_only
    ? `\nPay: ${job.min_pay || "?"} to ${job.max_pay || "?"} ${job.currency || ""} ${String(job.salary_period || "Yearly").toLowerCase()}` : "";
  return `Job: ${job.role_title}\nLocation: ${job.location || "?"}${job.work_setup ? " (" + job.work_setup + ")" : ""}${job.employment_type ? "\nEmployment: " + job.employment_type : ""}${pay}\n` +
    `Description:\n${String(job.description || "").slice(0, 3500)}`;
}

export async function sourceExternal(admin: any, jobId: string, s: Settings, opts: { force?: boolean } = {}) {
  if (!apolloKey()) return { ok: false, notConnected: "apollo", message: "Apollo isn't connected yet. Add the APOLLO_API_KEY secret to search outside Harbor." };
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
  const locations = remote
    ? (countryName ? [countryName] : allowed.map((c) => COUNTRY_NAMES[c]).filter(Boolean))
    : [job.location || countryName].filter(Boolean);
  if (!locations.length) { await record({ error: "The job has no location or country" }); return { ok: false, message: "Add a location or country to the job first." }; }

  // 1. Search
  const { hits, total } = await searchPeople({ titles, locations, perPage: 100 });
  const { data: existing } = await admin.from("prospects").select("external_id,status").or(`job_id.eq.${jobId},status.eq.unsubscribed`);
  const seen = new Set((existing || []).map((x: any) => x.external_id));
  const fresh = hits.filter((h) => h.has_email && !seen.has(h.id));
  if (!fresh.length) { await record({ searched: total, ranked: 0, revealed: 0, kept: 0 }); return { ok: true, found: 0, message: "Apollo found nobody new for this job." }; }

  // 2. Rank on what the search shows (free), so credits go only to the likeliest fits.
  const rankSys = "You are a recruitment researcher. From the list, pick the people most likely to fit the job on title, seniority and employer type. " +
    "Reply with STRICT JSON only: {\"picks\": [{\"i\": number, \"score\": number}]} with score 0-100, best first, only score 55 or more, at most " + (s.prospectsPerJob * 2) + ".";
  const list = fresh.slice(0, 100).map((h, i) => `${i} | ${h.title} | ${h.company}`).join("\n");
  const ranked = await askAI(rankSys, jobBrief(job, false) + "\n\nPeople (index | title | employer):\n" + list, 3000);
  const picks = (Array.isArray(ranked?.picks) ? ranked.picks : []).map((p: any) => fresh[Number(p.i)]).filter(Boolean);

  // 3. Reveal emails for the best, within the per-job limit.
  const { data: candEmails } = await admin.from("candidates").select("email").not("email", "is", null);
  const inHarbor = new Set((candEmails || []).map((c: any) => normEmail(c.email)));
  const people: ApolloPerson[] = [];
  let revealed = 0;
  for (const h of picks) {
    if (people.length >= s.prospectsPerJob || revealed >= s.prospectsPerJob * 2) break;
    let p: ApolloPerson | null = null;
    try { p = await matchById(h.id); revealed++; } catch (e) { console.error("apollo match", String((e as Error)?.message || e)); break; }
    await sleep(700);
    if (!p?.email || p.email_status !== "verified") continue;
    if (inHarbor.has(normEmail(p.email))) continue;
    const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(p.email)).maybeSingle();
    if (sup) continue;
    const pc = countryCode(p.country);
    if (pc && !allowed.includes(pc)) continue;
    people.push(p);
  }
  if (!people.length) { await record({ searched: total, ranked: picks.length, revealed, kept: 0 }); return { ok: true, found: 0, message: "No new people with verified emails matched." }; }

  // 4. Fit check on the full profile.
  const fitSys = "You are a recruitment analyst. For each person, judge fit for the job from their title, employer, location and work history: " +
    "must-have experience, seniority and location/work setup. Reply with STRICT JSON only: {\"results\": [{\"id\": string, \"fit\": number, \"verdict\": \"Perfect fit\" | \"Good fit\" | \"Possible fit\" | \"Not a fit\", \"reason\": string}]}. " +
    "reason: one short sentence naming the deciding points. Be strict: 'Good fit' only when most must-haves are clearly shown.";
  const profiles = people.map((p) => `id=${p.id} | ${p.title} at ${p.company} | ${[p.city, p.state, p.country].filter(Boolean).join(", ")} | history: ${p.history || "?"}`).join("\n");
  const fits = await askAI(fitSys, jobBrief(job, false) + "\n\nPeople:\n" + profiles, 4000);
  const byId: Record<string, any> = {};
  for (const r of Array.isArray(fits?.results) ? fits.results : []) byId[String(r.id)] = r;
  const keep = people.filter((p) => { const r = byId[p.id]; return r && (["Perfect fit", "Good fit"].includes(r.verdict) || Number(r.fit) >= 70); });
  if (!keep.length) { await record({ searched: total, ranked: picks.length, revealed, kept: 0 }); return { ok: true, found: 0, message: `Checked ${people.length} people; none were a strong enough fit.` }; }

  // 5. Draft a short, personal email for each.
  const mailSys = "You write short, honest recruiting emails to professionals who have not heard from us before. Reply with STRICT JSON only: " +
    "{\"emails\": [{\"id\": string, \"subject\": string, \"body\": string}]}. Rules: subject under 60 characters, no clickbait. Body 70-120 words, plain text, " +
    "start 'Hi <first name>,', say in one line why their background fits (from their title/history), describe the role (title, seniority, location or remote, and pay if given), " +
    "NEVER name the hiring company (say e.g. 'a US fintech' from the description), then ask if they're open to a quick chat and end the body with the line: " +
    "'If you're interested, click here: {{INTERESTED_LINK}} or just reply to this email.' Then a sign-off line with only the sender's first name. No postscript, no footer, no unsubscribe text (added separately).";
  const who = keep.map((p) => `id=${p.id} | first name: ${p.first_name} | ${p.title} at ${p.company} | ${p.history.slice(0, 300)}`).join("\n");
  const mails = await askAI(mailSys, jobBrief(job, s.includePay) + `\n\nSender first name: ${(s.senderName || "").split(" ")[0] || "the recruiter"}\n\nPeople:\n` + who, 6000);
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
      subject: String(m.subject || `${job.role_title} opportunity`).slice(0, 120), body: String(m.body || "").slice(0, 3000),
      status: "found", data: { history: p.history, domain: p.domain },
    };
  });
  const { data: inserted, error } = await admin.from("prospects").upsert(rows, { onConflict: "job_id,external_id", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(error.message);
  await record({ searched: total, ranked: picks.length, revealed, kept: rows.length });
  return { ok: true, found: rows.length, ids: (inserted || []).map((x: any) => x.id), revealed, message: `Found ${rows.length} strong outside ${rows.length === 1 ? "match" : "matches"} (${revealed} Apollo credits used).` };
}
