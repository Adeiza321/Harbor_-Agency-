// Emails for people found by the X-ray search, who are saved without one.
//   GitHub profiles: the email the person made public on their GitHub profile (free, automatic).
//   LinkedIn profiles: Apollo looks the person up by their exact profile address and returns their
//     verified work email, or a personal email when there's no verified work one (1 Apollo credit per email found). This runs automatically, without an
//     approval: every 10 minutes for the best X-ray people (fit >= outreach.xrayEmailMinFit), never more
//     than outreach.xrayEmailsPerDay lookups a day (the daily cap stands in for the approval).
//     When Apollo has nothing usable, ContactOut is tried by the same profile (contactout.ts, CONTACTOUT_API_KEY),
//     asking for work and personal emails anywhere; every address found is kept in data.emails_found.
// Only verified work emails or Apollo-found personal emails are kept. Each person with an email gets the same short, personal draft as
// Apollo's own prospects, ready for the usual approve-and-send flow (nothing is sent from here).

import { askAI } from "./ai.ts";
import { apolloKey, bestEmail, matchByLinkedIn } from "./apollo.ts";
import { jobBrief } from "./prospects.ts";
import { countryCode, regionOf } from "./regions.ts";
import { contactoutByLinkedIn, contactoutKey } from "./contactout.ts";
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

// The paid part (after approval) plus the free part: every X-ray person on the job (or the ids).
export async function findEmails(admin: any, o: { jobId?: string | null; ids?: string[] }, s: Settings, agencyName: string) {
  const gh = await findGithubEmails(admin, o, s, agencyName);
  const list = (await needing(admin, o)).filter((p) => p.linkedin_url && !p.data?.email_lookup?.apollo);
  if (list.length && !apolloKey()) return { ok: false, message: "Apollo isn't connected yet. Add the APOLLO_API_KEY secret to look up emails." };
  // Each person's own job (a run can span several jobs), to leave out the client's own staff.
  const jobIds = [...new Set(list.map((p) => p.job_id))];
  const { data: jobRows } = jobIds.length ? await admin.from("jobs").select("id,client").in("id", jobIds) : { data: [] };
  const clientOf = new Map((jobRows || []).map((j: any) => [j.id, j.client]));
  let coFound = 0, coTried = 0;
  const found: string[] = [];
  let credits = 0, noMatch = 0, unverified = 0;
  const errors: string[] = [];
  for (const p of list) {
    let m: any = null;
    try { m = await matchByLinkedIn(p.linkedin_url); }
    catch (e) { errors.push(String((e as Error)?.message || e).slice(0, 160)); if (/rate|credit|402|403/i.test(errors[errors.length - 1])) break; continue; }
    const lookup: Record<string, string> = { ...(p.data?.email_lookup || {}), apollo: new Date().toISOString() };
    // Verified work email first; a personal email when there's no verified work one.
    let best = bestEmail(m);
    if (m?.email || best.email) credits++;
    const atClient = !!m && sameCompany(m.company, clientOf.get(p.job_id));
    let good = !!best.email && okEmail(best.email) && !atClient && !(await suppressed(admin, best.email)) && !(m.email && m.email !== best.email && await suppressed(admin, m.email));
    let via = "Apollo (from their LinkedIn profile)";
    // Every address found, kept on the prospect (the one emailed is in prospects.email).
    let extra: { work: string[]; personal: string[] } | null = m ? { work: m.email ? [m.email] : [], personal: m.personal_emails || [] } : null;
    // Fallback: ContactOut, by the same LinkedIn profile, when Apollo had nothing usable.
    if (!good && !atClient && contactoutKey() && !p.data?.email_lookup?.contactout) {
      coTried++;
      lookup.contactout = new Date().toISOString();
      try {
        const co = await contactoutByLinkedIn(p.linkedin_url);
        if (co.work.length || co.personal.length) extra = { work: co.work, personal: co.personal };
        if (co.email && !(await suppressed(admin, co.email))) { best = { email: co.email, status: co.status }; good = true; via = "ContactOut (from their LinkedIn profile)"; coFound++; }
      } catch (e) { errors.push(String((e as Error)?.message || e).slice(0, 160)); }
    }
    if (!m && !good) noMatch++;
    if (m && !good) unverified++;
    const cc = countryCode(m?.country || "");
    const patch: Record<string, unknown> = { data: { ...(p.data || {}), email_lookup: lookup, ...(good ? { email_source: via, history: m?.history || p.data?.history } : {}), ...(extra && (extra.work.length || extra.personal.length) ? { emails_found: extra } : {}) } };
    if (good) Object.assign(patch, {
      email: best.email, email_status: best.status,
      first_name: p.first_name || m?.first_name || null, last_name: p.last_name || m?.last_name || null, full_name: p.full_name || m?.name || null,
      title: p.title || m?.title || null, company: p.company || m?.company || null,
      location: p.location || [m?.city, m?.state].filter(Boolean).join(", ") || null, country: cc || m?.country || p.country || null, region: cc ? regionOf(cc) : (p.region || null),
    });
    await admin.from("prospects").update(patch).eq("id", p.id);
    if (good) found.push(p.id);
    await sleep(600);
  }
  if (found.length) await draftEmails(admin, found, s, agencyName);
  const total = gh.found + found.length;
  const parts = [`Found ${total} email${total === 1 ? "" : "s"}`];
  if (list.length) parts.push(`${found.length - coFound} of ${list.length} LinkedIn ${list.length === 1 ? "person" : "people"} through Apollo (${credits} credit${credits === 1 ? "" : "s"} used)`);
  if (coTried) parts.push(`${coFound} of ${coTried} more through ContactOut`);
  if (gh.checked) parts.push(`${gh.found} of ${gh.checked} from public GitHub profiles (free)`);
  const why = [noMatch ? `${noMatch} not in Apollo` : "", unverified ? `${unverified} without a usable work or personal email` : ""].filter(Boolean).join(", ");
  return { ok: true, found: total, apollo: found.length - coFound, contactout: coFound, github: gh.found, credits, ids: found,
    message: parts.join(": ").replace(": ", ". ") + (why ? `. Not found: ${why}.` : ".") + (total ? " Review and approve them under the job to send." : ""),
    ...(errors.length ? { warnings: [...new Set(errors)].slice(0, 3) } : {}) };
}

// Automatic: the best X-ray people without an email, across open jobs (or one job / some people when
// staff ask), within today's Apollo allowance; plus a draft for anyone who has an email but no note.
export async function autoFindEmails(admin: any, s: Settings, agencyName: string, o: { jobId?: string | null; ids?: string[] } = {}) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count: used } = await admin.from("prospects").select("id", { count: "exact", head: true }).gte("data->email_lookup->>apollo", since.toISOString());
  const left = Math.max(0, s.xrayEmailsPerDay - (used || 0));
  const manual = !!(o.jobId || (o.ids && o.ids.length));
  let q = admin.from("prospects").select("id,source,linkedin_url,fit,data,jobs!inner(status)").is("email", null).eq("status", "found").neq("source", "apollo")
    .neq("jobs.status", "Closed").order("fit", { ascending: false }).limit(200);
  if (o.ids && o.ids.length) q = q.in("id", o.ids); else if (o.jobId) q = q.eq("job_id", o.jobId);
  if (!manual) q = q.gte("fit", s.xrayEmailMinFit);
  const { data: rows, error } = await q;
  if (error) throw new Error(error.message);
  const github = (rows || []).filter((p: any) => p.source === "github" && !p.data?.email_lookup?.github).map((p: any) => p.id);
  const apollo = (rows || []).filter((p: any) => p.linkedin_url && !p.data?.email_lookup?.apollo).map((p: any) => p.id).slice(0, Math.min(left, manual ? 40 : 12));
  const out: Record<string, unknown> = { leftToday: left, waiting: (rows || []).filter((p: any) => p.linkedin_url && !p.data?.email_lookup?.apollo).length };
  if (github.length || apollo.length) Object.assign(out, await findEmails(admin, { ids: [...github, ...apollo] }, s, agencyName));
  else out.message = left <= 0 && out.waiting ? `Today's limit of ${s.xrayEmailsPerDay} Apollo lookups is used up; the rest continue tomorrow.` : "No one is waiting for an email.";
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
