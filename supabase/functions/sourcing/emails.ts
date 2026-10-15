// Emails for people found by the X-ray search, who are saved without one.
//   GitHub profiles: the email the person made public on their GitHub profile (free, automatic).
//   LinkedIn profiles: ContactOut first (contactout.ts, CONTACTOUT_API_KEY), by their exact profile
//     address: a verified work email, else a personal one. When it has nothing usable, Apollo:
//     Apollo looks the person up by their exact profile address and returns their
//     verified work email, or a personal email when there's no verified work one (1 Apollo credit per email found). This runs automatically, without an
//     approval: every 10 minutes for the best X-ray people (fit >= outreach.xrayEmailMinFit), never more
//     than outreach.xrayEmailsPerDay lookups a day (the daily cap stands in for the approval).
//     Every address found by either is kept in data.emails_found. outreach.xrayEmailsPerDay caps the
//     people looked up per day, whichever source answers.
//     Then People Data Labs (pdl.ts, PDL_API_KEY) by the same profile, for anyone still without one:
//     1 PDL credit per person it has an email for, never more than outreach.pdlEmailsPerDay a day.
// Only verified work emails or Apollo-found personal emails are kept. Each person with an email gets the same short, personal draft as
// Apollo's own prospects, ready for the usual approve-and-send flow (nothing is sent from here).

import { askAI } from "./ai.ts";
import { apolloKey, bestEmail, matchByLinkedIn } from "./apollo.ts";
import { jobBrief, searchArea } from "./prospects.ts";
import { splitByArea } from "./area_check.ts";
import { countryCode, jobCountryNames, regionOf } from "./regions.ts";
import { contactoutByLinkedIn, contactoutKey } from "./contactout.ts";
import { bestPdlEmail, pdlByLinkedIn, pdlKey } from "./pdl.ts";
import { emailHash } from "./send.ts";
import { anonymizeJd, sameCompany, type Settings } from "./common.ts";

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const okEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/noreply|no-reply|users\.noreply\.github\.com/i.test(e);

// Prospects from an X-ray search that still need an email. ids: only these (else the whole job).
async function needing(admin: any, o: { jobId?: string | null; ids?: string[] }) {
  let q = admin.from("prospects").select("*").is("email", null).eq("status", "found").neq("source", "apollo");
  q = o.ids && o.ids.length ? q.in("id", o.ids) : q.eq("job_id", o.jobId || "00000000-0000-0000-0000-000000000000");
  const { data } = await q.limit(200);
  return (data || []) as any[];
}

// How many would use Apollo (LinkedIn without email, not already tried), for the approval.
export async function emailsToFind(admin: any, o: { jobId?: string | null; ids?: string[] }) {
  const list = await needing(admin, o);
  const tried = (p: any) => !!p.data?.email_lookup?.apollo;
  return {
    total: list.length,
    apollo: list.filter((p) => p.linkedin_url && !tried(p)).length,
    github: list.filter((p) => p.source === "github" && !p.data?.email_lookup?.github).length,
    ids: list.map((p) => p.id),
  };
}

async function githubEmail(profileUrl: string): Promise<string> {
  const login = String(profileUrl || "").replace(/^https?:\/\/(www\.)?github\.com\//i, "").split("/")[0];
  if (!login) return "";
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "ProNext" };
  const t = (Deno.env.get("GITHUB_TOKEN") || "").trim();
  if (t) h.Authorization = "Bearer " + t;
  const r = await fetch("https://api.github.com/users/" + encodeURIComponent(login), { headers: h });
  if (!r.ok) return "";
  const u = await r.json().catch(() => ({}));
  const e = String(u?.email || "").trim();
  return okEmail(e) ? e : "";
}

// Free part only: GitHub public emails. Safe to run straight after an X-ray search.
export async function findGithubEmails(admin: any, o: { jobId?: string | null; ids?: string[] }, s: Settings, agencyName: string) {
  const list = (await needing(admin, o)).filter((p) => p.source === "github" && !p.data?.email_lookup?.github);
  const found: string[] = [];
  for (const p of list) {
    let email = "";
    try { email = await githubEmail(p.data?.profile_url || p.external_id); } catch { /* try the next */ }
    const lookup = { ...(p.data?.email_lookup || {}), github: new Date().toISOString() };
    if (email && !(await suppressed(admin, email))) {
      await admin.from("prospects").update({ email, email_status: "public", data: { ...(p.data || {}), email_lookup: lookup, email_source: "GitHub profile" } }).eq("id", p.id);
      found.push(p.id);
    } else await admin.from("prospects").update({ data: { ...(p.data || {}), email_lookup: lookup } }).eq("id", p.id);
    await sleep(150);
  }
  if (found.length) await draftEmails(admin, found, s, agencyName);
  return { checked: list.length, found: found.length };
}

async function suppressed(admin: any, email: string) {
  const { data } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(email)).maybeSingle();
  return !!data;
}

// People whose location we just learned (or all found people on open roles, for the sweep): those
// clearly too far from the office are moved to Skipped with the reason. Returns their ids.
export async function skipTooFar(admin: any, people: { id: string; job_id: string; location: string }[], dry = false) {
  const out: string[] = [];
  const report: { id: string; location: string; why: string }[] = [];
  const byJob = new Map<string, typeof people>();
  for (const p of people) if (p.location) byJob.set(p.job_id, [...(byJob.get(p.job_id) || []), p]);
  for (const [jobId, list] of byJob) {
    const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).maybeSingle();
    if (!job || /remote/i.test(String(job.work_setup || "")) && !/hybrid/i.test(String(job.work_setup || "")) && !job.country) continue;
    const area = await searchArea(admin, job, jobCountryNames(job)).catch(() => null);
    const { dropped } = await splitByArea(admin, job, area, list, (p) => p.location);
    for (const { p, why } of dropped) {
      report.push({ id: p.id, location: p.location, why });
      if (dry) { out.push(p.id); continue; }
      const { data: cur } = await admin.from("prospects").select("data").eq("id", p.id).maybeSingle();
      await admin.from("prospects").update({ status: "rejected", data: { ...(cur?.data || {}), skipped: { reason: why, by: "location check", at: new Date().toISOString() } } })
        .eq("id", p.id).eq("status", "found");
      out.push(p.id);
    }
  }
  if (dry) (out as any).report = report;
  return out;
}

// People Data Labs lookups used today (counted from the prospects tried today).
async function pdlUsedToday(admin: any) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count } = await admin.from("prospects").select("id", { count: "exact", head: true }).gte("data->email_lookup->>pdl", since.toISOString());
  return count || 0;
}

// People Data Labs by LinkedIn profile, for X-ray people still without an email (within today's
// allowance). The client's own staff and unsubscribed addresses are left out, like Apollo's.
export async function pdlEmails(admin: any, ids: string[], s: Settings, agencyName: string) {
  if (!pdlKey() || !ids.length || s.pdlEmailsPerDay <= 0) return { tried: 0, found: 0, ids: [] as string[], errors: [] as string[] };
  const left = Math.max(0, s.pdlEmailsPerDay - (await pdlUsedToday(admin)));
  if (!left) return { tried: 0, found: 0, ids: [] as string[], errors: [] as string[], limit: true };
  const { data: rows } = await admin.from("prospects").select("*,jobs(client)").in("id", ids).is("email", null).eq("status", "found").not("linkedin_url", "is", null).limit(200);
  const list = (rows || []).filter((p: any) => !p.data?.email_lookup?.pdl).slice(0, left);
  const found: string[] = [], errors: string[] = [];
  for (const p of list) {
    const lookup = { ...(p.data?.email_lookup || {}), pdl: new Date().toISOString() };
    let m: any = null;
    try { m = await pdlByLinkedIn(p.linkedin_url); }
    catch (e) { errors.push(String((e as Error)?.message || e).slice(0, 160)); await admin.from("prospects").update({ data: { ...(p.data || {}), email_lookup: lookup } }).eq("id", p.id); if (/credit|refused|rate/i.test(errors[errors.length - 1])) break; continue; }
    const best = bestPdlEmail(m);
    const atClient = !!m && (sameCompany(m.company, p.jobs?.client) || false);
    const good = !!best.email && okEmail(best.email) && !atClient && !(await suppressed(admin, best.email));
    const patch: Record<string, unknown> = { data: { ...(p.data || {}), email_lookup: lookup,
      ...(m ? { emails_found: { work: m.work_email ? [m.work_email] : [], personal: m.personal_emails }, ...(m.phones.length ? { phones: m.phones } : {}) } : {}),
      ...(good ? { email_source: "People Data Labs (from their LinkedIn profile)", history: p.data?.history || m.history } : {}) } };
    if (good) Object.assign(patch, { email: best.email, email_status: best.status, first_name: p.first_name || m.first_name || null, last_name: p.last_name || m.last_name || null,
      title: p.title || m.title || null, company: p.company || m.company || null, location: p.location || [m.city, m.region].filter(Boolean).join(", ") || null });
    await admin.from("prospects").update(patch).eq("id", p.id);
    if (good) found.push(p.id);
    await sleep(250);
  }
  if (found.length) await draftEmails(admin, found, s, agencyName);
  return { tried: list.length, found: found.length, ids: found, errors };
}

// The paid part (after approval) plus the free part: every X-ray person on the job (or the ids).
export async function findEmails(admin: any, o: { jobId?: string | null; ids?: string[] }, s: Settings, agencyName: string) {
  const gh = await findGithubEmails(admin, o, s, agencyName);
  const co = !!contactoutKey(), ap = !!apolloKey();
  const tried = (p: any) => p.data?.email_lookup || {};
  // Anyone on LinkedIn that a connected source hasn't tried yet.
  const list = (await needing(admin, o)).filter((p) => p.linkedin_url && ((co && !tried(p).contactout) || (ap && !tried(p).apollo)));
  if (list.length && !co && !ap) return { ok: false, message: "No email source is connected. Add the CONTACTOUT_API_KEY or APOLLO_API_KEY secret to look up emails." };
  // Each person's own job (a run can span several jobs), to leave out the client's own staff.
  const jobIds = [...new Set(list.map((p) => p.job_id))];
  const { data: jobRows } = jobIds.length ? await admin.from("jobs").select("id,client").in("id", jobIds) : { data: [] };
  const clientOf = new Map((jobRows || []).map((j: any) => [j.id, j.client]));
  let coFound = 0, coTried = 0, apFound = 0, apTried = 0, credits = 0, noMatch = 0, unverified = 0;
  let coDown = false, apDown = false;
  const found: string[] = [];
  const errors: string[] = [];
  const learned: { id: string; job_id: string; location: string }[] = [];
  for (const p of list) {
    const lookup: Record<string, string> = { ...tried(p) };
    let best = { email: "", status: "" }, good = false, via = "", m: any = null;
    let extra: { work: string[]; personal: string[] } | null = null;
    let seenAt = "";   // where a source says they are, when we didn't know
    // 1. ContactOut first, by their LinkedIn profile.
    if (co && !coDown && !lookup.contactout) {
      coTried++;
      lookup.contactout = new Date().toISOString();
      try {
        const r = await contactoutByLinkedIn(p.linkedin_url);
        if (r.work.length || r.personal.length) extra = { work: r.work, personal: r.personal };
        if (r.location) seenAt = r.location;
        if (r.email && !(await suppressed(admin, r.email))) { best = { email: r.email, status: r.status }; good = true; via = "ContactOut (from their LinkedIn profile)"; coFound++; }
      } catch (e) {
        errors.push(String((e as Error)?.message || e).slice(0, 160));
        // Out of credits or the key refused: stop asking ContactOut this run (and don't mark them tried).
        if (/credit|quota|limit|401|402|403|429/i.test(errors[errors.length - 1])) { coDown = true; delete lookup.contactout; coTried--; }
      }
    }
    // 2. Apollo when ContactOut had nothing usable.
    if (!good && ap && !apDown && !lookup.apollo) {
      try {
        m = await matchByLinkedIn(p.linkedin_url);
        apTried++;
        lookup.apollo = new Date().toISOString();
        // Verified work email first; a personal email when there's no verified work one.
        const b = bestEmail(m);
        if (m?.email || b.email) credits++;
        const atClient = !!m && sameCompany(m.company, clientOf.get(p.job_id));
        if (m) extra = { work: [...new Set([...(extra?.work || []), ...(m.email ? [m.email] : [])])], personal: [...new Set([...(extra?.personal || []), ...(m.personal_emails || [])])] };
        if (m && !seenAt) seenAt = [m.city, m.state, m.country].filter(Boolean).join(", ");
        if (b.email && okEmail(b.email) && !atClient && !(await suppressed(admin, b.email)) && !(m.email && m.email !== b.email && await suppressed(admin, m.email))) {
          best = b; good = true; via = "Apollo (from their LinkedIn profile)"; apFound++;
        }
        if (!m && !good) noMatch++;
        if (m && !good) unverified++;
      } catch (e) {
        errors.push(String((e as Error)?.message || e).slice(0, 160));
        if (/rate|credit|402|403/i.test(errors[errors.length - 1])) apDown = true;
      }
    }
    if (coDown && (apDown || !ap) && !good && !lookup.apollo) break; // nothing left to ask today
    const cc = countryCode(m?.country || "");
    const patch: Record<string, unknown> = { data: { ...(p.data || {}), email_lookup: lookup, ...(good ? { email_source: via, history: p.data?.history || m?.history } : {}), ...(extra && (extra.work.length || extra.personal.length) ? { emails_found: extra } : {}) } };
    if (good) Object.assign(patch, {
      email: best.email, email_status: best.status,
      first_name: p.first_name || m?.first_name || null, last_name: p.last_name || m?.last_name || null, full_name: p.full_name || m?.name || null,
      title: p.title || m?.title || null, company: p.company || m?.company || null,
      location: p.location || [m?.city, m?.state].filter(Boolean).join(", ") || null, country: cc || m?.country || p.country || null, region: cc ? regionOf(cc) : (p.region || null),
    });
    if (!p.location && seenAt) { patch.location = seenAt; learned.push({ id: p.id, job_id: p.job_id, location: seenAt }); }
    await admin.from("prospects").update(patch).eq("id", p.id);
    if (good) found.push(p.id);
    await sleep(400);
  }
  // Newly learned locations: anyone clearly too far from the office is skipped, not emailed.
  const tooFar = await skipTooFar(admin, learned);
  for (const id of tooFar) { const i = found.indexOf(id); if (i >= 0) found.splice(i, 1); }
  if (found.length) await draftEmails(admin, found, s, agencyName);
  // Still nothing from ContactOut or Apollo: People Data Labs, within its daily allowance.
  const pdl = await pdlEmails(admin, list.map((p) => p.id).filter((id) => !found.includes(id)), s, agencyName).catch((e) => ({ tried: 0, found: 0, ids: [] as string[], errors: [String((e as Error)?.message || e)] }));
  errors.push(...pdl.errors);
  found.push(...pdl.ids);
  const total = gh.found + found.length;
  const parts = [`Found ${total} email${total === 1 ? "" : "s"}`];
  if (coTried) parts.push(`${coFound} of ${coTried} through ContactOut`);
  if (apTried) parts.push(`${apFound} of ${apTried} more through Apollo (${credits} credit${credits === 1 ? "" : "s"} used)`);
  if (pdl.tried) parts.push(`${pdl.found} of ${pdl.tried} more through People Data Labs (${pdl.found} credit${pdl.found === 1 ? "" : "s"})`);
  if (gh.checked) parts.push(`${gh.found} of ${gh.checked} from public GitHub profiles (free)`);
  const why = [noMatch ? `${noMatch} not in Apollo` : "", unverified ? `${unverified} without a usable work or personal email` : "", coDown ? "ContactOut stopped (credits or limit)" : ""].filter(Boolean).join(", ");
  return { ok: true, found: total, contactout: coFound, apollo: apFound, pdl: pdl.found, github: gh.found, credits, ids: found,
    message: parts.join(": ").replace(": ", ". ") + (why ? `. Not found: ${why}.` : ".") + (total ? " Review and approve them under the job to send." : ""),
    ...(errors.length ? { warnings: [...new Set(errors)].slice(0, 3) } : {}) };
}

// Automatic: the best X-ray people without an email, across open jobs (or one job / some people when
// staff ask), within today's Apollo allowance; plus a draft for anyone who has an email but no note.
export async function autoFindEmails(admin: any, s: Settings, agencyName: string, o: { jobId?: string | null; ids?: string[] } = {}) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  // People looked up today by either source (one person = one lookup, whichever answered).
  const iso = since.toISOString();
  const { count: used } = await admin.from("prospects").select("id", { count: "exact", head: true })
    .or(`data->email_lookup->>apollo.gte.${iso},data->email_lookup->>contactout.gte.${iso}`);
  const left = Math.max(0, s.xrayEmailsPerDay - (used || 0));
  const co = !!contactoutKey(), ap = !!apolloKey();
  const untried = (p: any) => { const l = p.data?.email_lookup || {}; return (co && !l.contactout) || (ap && !l.apollo); };
  const manual = !!(o.jobId || (o.ids && o.ids.length));
  let q = admin.from("prospects").select("id,source,linkedin_url,fit,data,jobs!inner(status)").is("email", null).eq("status", "found").neq("source", "apollo")
    .neq("jobs.status", "Closed").order("fit", { ascending: false }).limit(200);
  if (o.ids && o.ids.length) q = q.in("id", o.ids); else if (o.jobId) q = q.eq("job_id", o.jobId);
  if (!manual) q = q.gte("fit", s.xrayEmailMinFit);
  const { data: rows, error } = await q;
  if (error) throw new Error(error.message);
  const github = (rows || []).filter((p: any) => p.source === "github" && !p.data?.email_lookup?.github).map((p: any) => p.id);
  const apollo = (rows || []).filter((p: any) => p.linkedin_url && untried(p)).map((p: any) => p.id).slice(0, Math.min(left, manual ? 40 : 12));
  const out: Record<string, unknown> = { leftToday: left, waiting: (rows || []).filter((p: any) => p.linkedin_url && untried(p)).length };
  if (github.length || apollo.length) Object.assign(out, await findEmails(admin, { ids: [...github, ...apollo] }, s, agencyName));
  else out.message = left <= 0 && out.waiting ? `Today's limit of ${s.xrayEmailsPerDay} email lookups is used up; the rest continue tomorrow.` : "No one is waiting for an email.";
  // People Apollo (and ContactOut) already tried without an email: People Data Labs, best fits first.
  if (pdlKey() && s.pdlEmailsPerDay > 0) {
    let pq = admin.from("prospects").select("id,fit,data,jobs!inner(status)").is("email", null).eq("status", "found").not("linkedin_url", "is", null)
      .not("data->email_lookup->>apollo", "is", null).is("data->email_lookup->>pdl", null).neq("jobs.status", "Closed").order("fit", { ascending: false }).limit(100);
    if (o.ids && o.ids.length) pq = pq.in("id", o.ids); else if (o.jobId) pq = pq.eq("job_id", o.jobId);
    if (!manual) pq = pq.gte("fit", s.xrayEmailMinFit);
    const { data: retry } = await pq;
    if (retry?.length) {
      const r = await pdlEmails(admin, retry.map((p: any) => p.id), s, agencyName).catch((e) => ({ tried: 0, found: 0, ids: [], errors: [String((e as Error)?.message || e)] }));
      out.pdl = { tried: r.tried, found: r.found, ...(r.errors.length ? { errors: r.errors.slice(0, 2) } : {}) };
      if (r.tried) out.message = String(out.message || "") + ` People Data Labs: ${r.found} of ${r.tried} found.`;
    }
  }
  // Emails found without a note yet (e.g. found by an earlier version): write the usual draft.
  const { data: undrafted } = await admin.from("prospects").select("id").neq("source", "apollo").not("email", "is", null).is("body", null).eq("status", "found").limit(20);
  if (undrafted?.length) { await draftEmails(admin, undrafted.map((r: any) => r.id), s, agencyName); out.drafted = undrafted.length; }
  return out;
}

// The same short, honest note Apollo prospects get, written from what the X-ray result showed.
export async function draftEmails(admin: any, ids: string[], s: Settings, agencyName: string) {
  const { data: rows } = await admin.from("prospects").select("*").in("id", ids);
  const byJob: Record<string, any[]> = {};
  for (const r of rows || []) (byJob[r.job_id] = byJob[r.job_id] || []).push(r);
  for (const [jobId, people] of Object.entries(byJob)) {
    const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).maybeSingle();
    if (!job) continue;
    const sys = "You write short, honest recruiting emails to professionals who have not heard from us before. Reply with STRICT JSON only: " +
      "{\"emails\": [{\"id\": string, \"subject\": string, \"body\": string}]}. Rules: subject under 60 characters, no clickbait. Body 60-110 words, plain text, in this order: " +
      "(1) 'Hi <first name>,' (2) introduce the sender in one short sentence: their first name, their title if given, and the agency name if given. " +
      "(3) say we're recruiting for the role (title and seniority) and came across their public professional profile while searching for people with their experience (never claim we met or were referred). If a person is marked 'emailed before about another role', say instead that we were in touch a while ago about a different role and this one looks a closer fit. " +
      "NEVER name the hiring company: describe it instead (e.g. 'a US fintech') from the description. Don't list the location, pay or requirements: they're shown under your note. " +
      "(4) say we think they'd be a good fit because ... with the specific reasons from their headline, employer and what their profile shows (one or two sentences). " +
      "(5) a sign-off line with only the sender's first name. No links, no job description, no postscript, no footer, no unsubscribe text (all added separately).";
    const sender = `Sender first name: ${(s.senderName || "").split(" ")[0] || "the recruiter"}\nSender title: ${s.senderTitle || "(not given)"}\nAgency name: ${agencyName || "(not given)"}`;
    const who = people.map((p) => `id=${p.id} | first name: ${p.first_name || ""} | ${p.title || ""} at ${p.company || ""} | ${clip(p.data?.overview || p.fit_reason, 300)} | ${clip(p.data?.history, 300)}${p.data?.pool?.contactedBefore ? " | emailed before about another role" : ""}`).join("\n");
    let out: any = null;
    try { out = await askAI(sys, jobBrief(job, s.includePay) + `\n\n${sender}\n\nPeople:\n` + who, 5000); } catch (e) { console.error("draft xray emails", String((e as Error)?.message || e)); continue; }
    for (const m of Array.isArray(out?.emails) ? out.emails : []) {
      const p = people.find((x) => x.id === String(m.id));
      if (!p) continue;
      await admin.from("prospects").update({ subject: clip(m.subject || `${job.role_title} opportunity`, 120), body: anonymizeJd(String(m.body || "").slice(0, 3000), job.client) }).eq("id", p.id);
    }
  }
}
