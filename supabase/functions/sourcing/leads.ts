// The client machine, Active file first.
//   fetchLeads (daily, after an Admin approves the credits): candidate by candidate. For each Active
//     file candidate, new postings in the country they live in for their own job titles (direct
//     employers, not remote, never a company they work or worked at) -> leads found FOR that
//     candidate. The day's postings are shared out between candidates; when there are more
//     candidates than the day allows, it works through them in turn over the following days.
//   processLead (a few per run): the candidate it was found for, checked against the posting; kept
//     only if they're a Good or Perfect fit. Other Active file candidates in that country with the
//     same title are checked too and join the pitch if they fit (up to 5 in all).
//   pitchLead: the hiring contact (the poster from the job feed, email via Apollo) and an anonymous
//     email: up to 5 candidates, each as a blind resume behind a "View the candidates" button
//     (/?t=s-<client_token>), only candidates whose blind resume a Rec Ops/Admin has checked. A lead
//     whose matches have no checked blind resume yet waits ('awaiting') and is pitched once they do.
//   Candidates aren't asked about each role: they agreed to be put forward when they said Yes to
//   future roles or joined the Active file. They're never named or tied to an employer in a pitch.
//   The company's "We're interested" sends the contract automatically (stepContracts in index.ts).

import { askAI } from "./ai.ts";
import { searchJobs, theirstackKey } from "./theirstack.ts";
import { apolloKey, matchByName } from "./apollo.ts";
import { countryCode, locationCountry, regionOf } from "./regions.ts";
import { emailHash } from "./send.ts";
import { button, emailShell, esc, loadBrand, sendBrevo } from "./brand.ts";
import { portalBase } from "./queue.ts";
import { anonSummary, candEmployers, candTitles, fitsToPercent, isBusy, scrub, titlesMatch, workedAt, type Settings } from "./common.ts";

export const MAX_PER_PITCH = 5;

// Who we pitch: the Active file (not drafts, with a CV), and the country each one lives in.
export async function pitchableCandidates(admin: any) {
  const { data } = await admin.from("candidates")
    .select("id,name,status,email,current_title,current_company,parallel_titles,experience,location,notice,skills,strengths,industries,preferences,is_draft,resume_path,cv_path,blind_pages,blind_checked_at,open_to_roles,open_paused_until,candidate_jobs(stage,candidate_response)")
    .eq("is_draft", false).eq("status", "Active file");
  return (data || []).filter((c: any) => isOpen(c) && !isBusy(c) && (c.resume_path || c.cv_path) && candTitles(c).length && candCountry(c));
}
// "Open to new roles" on their candidate page: off means not for a year, unless they turn it back on.
export const isOpen = (c: any) => c?.open_to_roles !== false || (!!c?.open_paused_until && Date.parse(c.open_paused_until) < Date.now());
// The country a candidate lives in, as a code: from their job preferences, else the end of their location.
export function candCountry(c: any): string {
  const p = c?.preferences;
  if (p && p.currentCountry) { const k = countryCode(p.currentCountry); if (k) return k; }
  return locationCountry(c?.location);
}
export const blindReady = (c: any) => !!(c?.blind_pages && c?.blind_checked_at);

export async function fetchLeads(admin: any, s: Settings) {
  if (!theirstackKey()) return { ok: false, notConnected: "theirstack", message: "The job feed isn't connected yet. Add the THEIRSTACK_API_KEY secret." };
  const all = await pitchableCandidates(admin);
  if (!all.length) return { ok: true, fetched: 0, message: "No Active file candidates with a CV, a known job title and a known country, so there's nothing to look for yet." };
  // Share the day's postings out between candidates (at least 3 each). More candidates than that
  // allows: a different group each day, in turn (same order every day, starting further along).
  const total = Math.max(1, s.leads.postingsPerDay);
  const each = Math.max(3, Math.floor(total / all.length));
  const perDay = Math.max(1, Math.floor(total / each));
  const ordered = all.slice().sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
  const start = (Math.floor(Date.now() / 864e5) * perDay) % ordered.length;
  const today = perDay >= ordered.length ? ordered : Array.from({ length: perDay }, (_, k) => ordered[(start + k) % ordered.length]);
  let fetched = 0, added = 0, remote = 0, skipped = 0;
  const errors: string[] = [], found: string[] = [];
  for (const c of today) {
    const cc = candCountry(c);
    const titles = [...new Set(candTitles(c).map((t) => t.trim()).filter(Boolean))].slice(0, 10);
    let postings: any[] = [];
    try { postings = await searchJobs({ titles, countries: [cc], maxAgeDays: s.leads.maxAgeDays, limit: each }); }
    catch (e) {
      const m = String((e as Error)?.message || e);
      errors.push(firstName(c) + " (" + cc + "): " + m.slice(0, 300));
      if (/\b401\b/.test(m) || /\b402\b/.test(m) || (/\b403\b/.test(m) && !/free plan/i.test(m))) break;   // key or credits: stop for today
      continue;
    }
    fetched += postings.length;
    const employers = candEmployers(c);
    let mine = 0;
    for (const p of postings) {
      // Roles in the candidate's own country only: remote roles are left out, and never a company
      // they work or worked at.
      if (p.remote) { remote++; continue; }
      const pc = countryCode(p.country) || cc;
      if (pc !== cc) continue;
      if (workedAt(employers, p.company)) { skipped++; continue; }
      const { error } = await admin.from("leads").insert({
        source: "theirstack", external_id: p.id, company: p.company, company_domain: p.domain, job_title: p.title,
        location: p.location, country: pc, region: regionOf(pc), url: p.url, posted_at: p.posted_at,
        description: p.description, salary: p.salary, status: "pending",
        data: { hiring_team: p.hiring_team, remote: p.remote, for_candidate: c.id, for_titles: titles },
      });
      if (!error) { added++; mine++; }  // a posting already found (for anyone) hits the unique external_id and is skipped
    }
    found.push(firstName(c) + " " + mine);
  }
  if (!fetched && errors.length) throw new Error(errors[0]);
  const who = today.length === all.length ? `all ${all.length} Active file candidates` : `${today.length} of ${all.length} Active file candidates (the rest on the next days)`;
  return { ok: true, fetched, added, candidates: found,
    message: `Looked for roles for ${who}, up to ${each} each: ${fetched} new postings, ${added} new leads.${remote ? " " + remote + " remote roles left out." : ""}${skipped ? " " + skipped + " at a company the candidate worked for, left out." : ""}${errors.length ? " Some searches failed: " + errors.join("; ") : ""}` };
}
const firstName = (c: any) => String(c?.name || "").trim().split(/\s+/)[0] || "A candidate";

export async function processLead(admin: any, lead: any, s: Settings) {
  // The candidate it was found for, plus other Active file candidates in the posting's country with
  // a matching title; never anyone who works or worked at that company.
  const cc = countryCode(lead.country);
  const forId = lead.data?.for_candidate || null;
  const cands = (await pitchableCandidates(admin)).filter((c: any) => candCountry(c) === cc && !workedAt(candEmployers(c), lead.company));
  const target = forId ? cands.find((c: any) => c.id === forId) : null;
  const ignore = async (why: string) => { await admin.from("leads").update({ status: "ignored", notes: why }).eq("id", lead.id); return { ok: true, kept: false, why }; };
  if (forId && !target) return ignore("The candidate this role was found for is no longer free to put forward");
  const others = cands.filter((c: any) => c.id !== forId).map((c: any) => ({ c, score: titlesMatch([lead.job_title], candTitles(c)) }))
    .filter((x: any) => x.score >= 0.6).sort((a: any, b: any) => b.score - a.score).slice(0, target ? 7 : 8).map((x: any) => x.c);
  const pool = target ? [target, ...others] : others;
  if (!pool.length) return ignore("No Active file candidate in " + (lead.country || "that country") + " matches this title");

  // Fit check: the posting against each candidate's anonymous profile.
  const fitSys = "You are a recruitment analyst at an agency. For each candidate, judge fit for this job posting on must-have experience, seniority, skills, industry and location/work setup. " +
    "Reply with STRICT JSON only: {\"results\": [{\"n\": number, \"fit\": number (a percentage from 0 to 100, e.g. 85; never a 0-10 score), \"verdict\": \"Perfect fit\" | \"Good fit\" | \"Possible fit\" | \"Not a fit\", \"reason\": string, \"bullets\": string[]}]}. " +
    "reason: one short sentence. bullets: 3 short selling points for the hiring manager, each under 15 words, anonymous (no names, no employer names; say e.g. 'Big 4-trained').";
  const posting = `Job: ${lead.job_title} at ${lead.company}\nLocation: ${lead.location || "?"} (${lead.country || "?"})${lead.salary ? "\nPay: " + lead.salary : ""}\nDescription:\n${String(lead.description || "").slice(0, 4000)}`;
  const list = pool.map((c: any, i: number) => `n=${i} | ${anonSummary(c)}`).join("\n");
  const fits = await askAI(fitSys, posting + "\n\nCandidates:\n" + list, 3000);
  const kept = fitsToPercent(Array.isArray(fits?.results) ? fits.results : [])
    .map((r: any) => ({ r, c: pool[Number(r.n)] })).filter((x: any) => x.c && ["Perfect fit", "Good fit"].includes(x.r.verdict))
    .sort((a: any, b: any) => (target && a.c.id === target.id ? -1 : target && b.c.id === target.id ? 1 : (Number(b.r.fit) || 0) - (Number(a.r.fit) || 0))).slice(0, MAX_PER_PITCH);
  if (!kept.length) return ignore(target ? "Not a strong enough fit for " + firstName(target) : "Our Active file candidates weren't a strong enough fit");
  // Found for a candidate: kept only when it fits them.
  if (target && !kept.some((x: any) => x.c.id === target.id)) return ignore("Not a strong enough fit for " + firstName(target) + " (the role it was found for)");
  const matches = kept.map((x: any) => ({
    candidate_id: x.c.id, verdict: x.r.verdict, fit: Math.round(Number(x.r.fit) || 0), reason: scrub(String(x.r.reason || ""), [x.c]).slice(0, 300),
    bullets: (Array.isArray(x.r.bullets) ? x.r.bullets : []).slice(0, 3).map((b: unknown) => scrub(String(b), [x.c]).slice(0, 140)),
  }));
  await admin.from("leads").update({ status: "awaiting", matches }).eq("id", lead.id);
  const pr: any = await pitchLead(admin, { ...lead, matches }, s);
  return { ...pr, ok: true, kept: true };
}

// The hiring contact and the pitch, with every match whose blind resume is ready (checked). If none
// is ready yet, the lead waits ('awaiting', with a note) and stepLeads tries again later.
export async function pitchLead(admin: any, lead: any, s: Settings) {
  const all: any[] = Array.isArray(lead.matches) ? lead.matches : [];
  if (!all.length) return { ok: true, pitched: false };
  const { data: cs } = await admin.from("candidates").select("id,name,current_company,blind_pages,blind_checked_at,status").in("id", all.map((m: any) => m.candidate_id));
  const ready = all.filter((m: any) => { const c = (cs || []).find((x: any) => x.id === m.candidate_id); return c && blindReady(c) && c.status === "Active file"; }).slice(0, MAX_PER_PITCH);
  if (!ready.length) {
    const waiting = all.map((m: any) => (cs || []).find((x: any) => x.id === m.candidate_id)?.name).filter(Boolean);
    await admin.from("leads").update({ status: "awaiting", notes: "Waiting for a checked blind resume for: " + waiting.join(", ") + " (Candidates > Blind resumes)." }).eq("id", lead.id);
    return { ok: true, pitched: false, waitingForBlind: waiting.length };
  }
  const kc = ready.map((m: any) => (cs || []).find((x: any) => x.id === m.candidate_id) || { id: m.candidate_id });
  const posting = `Job: ${lead.job_title} at ${lead.company}\nLocation: ${lead.location || "?"} (${lead.country || "?"})${lead.salary ? "\nPay: " + lead.salary : ""}\nDescription:\n${String(lead.description || "").slice(0, 3000)}`;

  // Who to contact: the poster from the job feed; their work email from Apollo when available.
  const team: any[] = Array.isArray(lead.data?.hiring_team) ? lead.data.hiring_team : [];
  const poster = team.find((h) => /talent|recruit|hiring|people|hr\b|human/i.test(h.role || "")) || team[0] || null;
  let contactEmail = "", emailStatus = "";
  if (poster && apolloKey()) {
    const parts = String(poster.full_name || "").trim().split(/\s+/);
    try {
      const p = await matchByName(poster.first_name || parts[0] || "", parts.slice(1).join(" "), lead.company_domain || "", lead.company || "");
      if (p?.email && p.email_status === "verified") {
        const { data: sup } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(p.email)).maybeSingle();
        if (!sup) { contactEmail = p.email; emailStatus = p.email_status; }
      }
    } catch (e) { console.error("apollo contact", String((e as Error)?.message || e)); }
  }
  const channel = contactEmail ? "email" : poster?.linkedin_url ? "linkedin" : "none";

  // Pitch: short email and a LinkedIn note, both anonymous; the blind resumes sit behind the button.
  const n = ready.length;
  const pitchSys = "You write short, specific business-development messages for a recruitment agency to a hiring manager who just posted a job. Reply with STRICT JSON only: " +
    "{\"subject\": string, \"body\": string, \"linkedin\": string}. Rules: never name the candidates or their employers. " +
    `subject under 60 characters, referencing their role. body 70-120 words, plain text, start 'Hi <first name>,' (or 'Hi there,' if unknown), mention their open role by title, ` +
    `say we have ${n === 1 ? "a strong candidate" : n + " strong candidates"} for it right now and give one line per candidate using the selling points given (as a short list), ` +
    `then say their anonymised CV${n === 1 ? " is" : "s are"} ready to view at the button below, and that if they'd like to talk to any of them they can click 'We're interested' or just reply. ` +
    "End with a sign-off with only the sender's first name. No links, no footer or unsubscribe text (added separately). " +
    "linkedin: under 280 characters, friendly, same offer, no links.";
  const pts = ready.map((m: any, i: number) => `Candidate ${i + 1} (${m.verdict}): ${(m.bullets || []).join("; ")}`).join("\n");
  const pitch = await askAI(pitchSys, `${posting.slice(0, 1500)}\n\nHiring contact first name: ${poster?.first_name || "unknown"}${poster?.role ? " (" + poster.role + ")" : ""}\nSender first name: ${(s.senderName || "").split(" ")[0] || "the recruiter"}\n\nOur candidates:\n${pts}`, 2000);
  await admin.from("leads").update({
    status: "new", matches: all, notes: null,
    data: { ...(lead.data || {}), pitched: ready.map((m: any) => m.candidate_id) },
    contact_name: poster?.full_name || null, contact_first_name: poster?.first_name || null, contact_role: poster?.role || null,
    contact_linkedin: poster?.linkedin_url || null, contact_email: contactEmail || null, contact_email_status: emailStatus || null, channel,
    pitch_subject: scrub(String(pitch?.subject || ""), kc).slice(0, 120), pitch_body: scrub(String(pitch?.body || ""), kc).slice(0, 3000),
    linkedin_message: scrub(String(pitch?.linkedin || ""), kc).slice(0, 300),
  }).eq("id", lead.id);
  return { ok: true, pitched: true, kept: true, channel, candidates: n };
}

// The page the pitch's button opens: the candidates' blind resumes (no names), and "We're interested".
export const shortlistUrl = (clientToken: string) => `${portalBase()}/?t=s-${encodeURIComponent(clientToken)}`;

// Ask candidates about a matched role: an email with the role WITHOUT the employer's name or
// website, and Yes / No buttons that open their candidate page. Recruiter-approved, a few at a time.
export async function sendOffers(admin: any, ids: string[], sentBy: string | null) {
  const b = await loadBrand(admin);
  const out = { sent: 0, skipped: 0, errors: [] as string[] };
  const { data: offers } = await admin.from("lead_offers").select("id,token,status,lead_id,candidate_id").in("id", ids.slice(0, 25)).eq("status", "suggested");
  for (const o of offers || []) {
    try {
      const { data: c } = await admin.from("candidates").select("id,name,email,email_opt_out,portal_token,recruiter_id").eq("id", o.candidate_id).single();
      if (!c?.email || c.email_opt_out || !c.portal_token) { out.skipped++; await admin.from("lead_offers").update({ status: "skipped" }).eq("id", o.id); continue; }
      const { data: role } = await admin.rpc("offer_role_anon", { p_lead: o.lead_id });
      const { data: rec } = c.recruiter_id ? await admin.from("profiles").select("full_name").eq("id", c.recruiter_id).maybeSingle() : { data: null };
      const first = String(c.name || "").split(" ")[0] || "there";
      const recruiter = String(rec?.full_name || "").split(" ")[0] || "Your recruiter";
      const link = (r: string) => `${portalBase()}/?c=${encodeURIComponent(c.portal_token)}&offer=${encodeURIComponent(o.token)}&r=${r}`;
      const where = [role?.remote ? "Remote" : "", role?.location || "", role?.country || ""].filter(Boolean).join(" · ");
      const summary = String(role?.summary || "").replace(/\s+/g, " ").trim();
      const short = summary.length > 420 ? summary.slice(0, 420).replace(/\s+\S*$/, "") + "…" : summary;
      const subject = `A role that could suit you: ${role?.title || "new opportunity"}`;
      const html = emailShell(b, subject, `
        <div style="font-size:20px;margin-bottom:8px;">Hi ${esc(first)},</div>
        <div style="font-size:15px;line-height:1.6;">${esc(recruiter)} came across a role that matches your background and wanted to ask you first.</div>
        <div style="margin:18px 0;padding:16px 18px;border:1px solid #E4DED2;border-radius:12px;background:#FAF8F3;">
          <div style="font-size:17px;font-weight:700;">${esc(role?.title || "")}</div>
          ${where ? `<div style="font-size:14px;color:#56605A;margin-top:4px;">${esc(where)}</div>` : ""}
          ${role?.salary ? `<div style="font-size:14px;color:#56605A;margin-top:2px;">${esc(role.salary)}</div>` : ""}
          ${short ? `<div style="font-size:14px;line-height:1.55;margin-top:10px;">${esc(short)}</div>` : ""}
        </div>
        <div style="font-size:15px;line-height:1.6;">Nothing about you is shared with the employer unless you say yes. If you're interested, you'll get to check the details we have on file for you first.</div>
        ${button(b, link("yes"), "Yes, I'm interested")}
        <div style="margin-top:10px;font-size:14px;"><a href="${esc(link("no"))}" style="color:#56605A;">Not for me</a></div>`);
      const ok = await sendBrevo(b, { email: c.email, name: c.name }, subject, html);
      if (!ok) throw new Error("The email couldn't be sent (check the email settings)");
      await admin.from("lead_offers").update({ status: "sent", sent_at: new Date().toISOString(), sent_by: sentBy }).eq("id", o.id);
      await admin.from("candidate_timeline").insert({ candidate_id: c.id, title: "Asked about a matched role: " + (role?.title || ""), done: true });
      out.sent++;
    } catch (e) { out.errors.push(String((e as Error)?.message || e).slice(0, 160)); }
  }
  return out;
}

// The employer said yes too (after the candidate did): tell the candidate, still without naming
// the employer. Who it is shows on their candidate page, where the role now appears; their
// recruiter is copied.
export async function sendOfferMoving(admin: any, offerId: string) {
  const { data: o } = await admin.from("lead_offers").select("id,status,lead_id,candidate_id").eq("id", offerId).maybeSingle();
  if (!o || o.status !== "processing") return { sent: false, error: "This candidate isn't being processed for the role" };
  const { data: c } = await admin.from("candidates").select("id,name,email,email_opt_out,portal_token,recruiter_id").eq("id", o.candidate_id).single();
  if (!c?.email || c.email_opt_out || !c.portal_token) return { sent: false, error: "No email for them, or they unsubscribed" };
  const b = await loadBrand(admin);
  const { data: role } = await admin.rpc("offer_role_anon", { p_lead: o.lead_id });
  const { data: rec } = c.recruiter_id ? await admin.from("profiles").select("full_name,email").eq("id", c.recruiter_id).maybeSingle() : { data: null };
  const first = String(c.name || "").split(" ")[0] || "there";
  const recruiter = String(rec?.full_name || "").split(" ")[0] || "Your recruiter";
  const subject = `Good news about the ${role?.title || "role"} you said yes to`;
  const html = emailShell(b, subject, `
    <div style="font-size:20px;margin-bottom:8px;">Hi ${esc(first)},</div>
    <div style="font-size:15px;line-height:1.6;">Good news: the employer for the <b>${esc(role?.title || "role")}</b> you said yes to wants to move forward with you.</div>
    <div style="font-size:15px;line-height:1.6;margin-top:12px;">${esc(recruiter)} will be in touch about the next steps. The full details are on your candidate page.</div>
    ${button(b, `${portalBase()}/?c=${encodeURIComponent(c.portal_token)}`, "See the details")}`);
  const ok = await sendBrevo(b, { email: c.email, name: c.name }, subject, html, undefined, { cc: rec?.email ? [{ email: rec.email, name: rec.full_name }] : [] });
  if (ok) await admin.from("candidate_timeline").insert({ candidate_id: c.id, title: "Told the employer wants to move forward: " + (role?.title || ""), done: true });
  return { sent: ok, error: ok ? "" : "The email couldn't be sent (check the email settings)" };
}
