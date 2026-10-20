// The client machine, candidate first.
//   fetchLeads (daily): new postings for the titles our candidates fit (Active file, or anyone who
//     agreed to be pitched), in the target countries, direct employers only -> leads to check.
//   processLead (a few per run): match the posting against those candidates; keep it only if at
//     least one is a Good fit. Each fit becomes an offer (lead_offers) and the lead waits
//     ('awaiting'): a recruiter sends the candidate the role WITHOUT the employer's name
//     (sendOffers), the candidate says yes and confirms their details on their candidate page.
//   pitchLead (once someone has confirmed): find the hiring contact (the poster from the job feed,
//     email via Apollo) and write an anonymous email pitch and LinkedIn note about the confirmed
//     candidates only -> 'new', ready to approve and send like before.
// Candidates are never named or tied to their current employer in a pitch.

import { askAI } from "./ai.ts";
import { searchJobs, theirstackKey } from "./theirstack.ts";
import { apolloKey, matchByName } from "./apollo.ts";
import { countryCode, regionOf, targetCodes } from "./regions.ts";
import { emailHash } from "./send.ts";
import { button, emailShell, esc, loadBrand, sendBrevo } from "./brand.ts";
import { portalBase } from "./queue.ts";
import { anonSummary, candEmployers, candTitles, fitsToPercent, isBusy, scrub, titlesMatch, workedAt, type Settings } from "./common.ts";

// Who we look for roles for: everyone in the Active file (they applied before and are free now),
// plus anyone who agreed to be pitched. They're asked before anything goes to an employer, so an
// email address is needed (and they mustn't have unsubscribed).
export async function pitchableCandidates(admin: any) {
  const { data } = await admin.from("candidates")
    .select("id,name,status,email,email_opt_out,current_title,current_company,parallel_titles,experience,location,notice,skills,strengths,industries,pitch_consent,is_draft,resume_path,cv_path,candidate_jobs(stage,candidate_response)")
    .eq("is_draft", false).or("pitch_consent.eq.true,status.eq.Active file");
  return (data || []).filter((c: any) => !isBusy(c) && c.status !== "Rejected" && c.email && !c.email_opt_out && candTitles(c).length);
}

export async function fetchLeads(admin: any, s: Settings) {
  if (!theirstackKey()) return { ok: false, notConnected: "theirstack", message: "The job feed isn't connected yet. Add the THEIRSTACK_API_KEY secret." };
  const cands = await pitchableCandidates(admin);
  if (!cands.length) return { ok: true, fetched: 0, message: "No candidates in the Active file (or who agreed to be pitched) with an email and a known job title, so there's nothing to look for yet." };
  // The titles our bench fits, most common first.
  const freq: Record<string, number> = {};
  for (const c of cands) for (const t of candTitles(c)) freq[t] = (freq[t] || 0) + 1;
  const titles = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 30);
  const postings = await searchJobs({ titles, countries: targetCodes(s.regions), maxAgeDays: s.leads.maxAgeDays, limit: s.leads.postingsPerDay });
  let added = 0;
  for (const p of postings) {
    const cc = countryCode(p.country);
    const { error } = await admin.from("leads").insert({
      source: "theirstack", external_id: p.id, company: p.company, company_domain: p.domain, job_title: p.title,
      location: p.location, country: cc || p.country, region: regionOf(cc), url: p.url, posted_at: p.posted_at,
      description: p.description, salary: p.salary, status: "pending", data: { hiring_team: p.hiring_team, remote: p.remote },
    });
    if (!error) added++;               // duplicates hit the unique external_id and are skipped
  }
  return { ok: true, fetched: postings.length, added, message: `Checked ${postings.length} new postings; ${added} new.` };
}

export async function processLead(admin: any, lead: any, s: Settings) {
  // Never pitch a candidate to a company they work for or have worked for.
  const cands = (await pitchableCandidates(admin)).filter((c: any) => !workedAt(candEmployers(c), lead.company));
  const pool = cands.map((c: any) => ({ c, score: titlesMatch([lead.job_title], candTitles(c)) }))
    .filter((x: any) => x.score >= 0.6).sort((a: any, b: any) => b.score - a.score).slice(0, 3).map((x: any) => x.c);
  const ignore = async (why: string) => { await admin.from("leads").update({ status: "ignored", notes: why }).eq("id", lead.id); return { ok: true, kept: false, why }; };
  if (!pool.length) return ignore("No candidate on file matches this title");

  // Fit check: the posting against each candidate's anonymous profile.
  const fitSys = "You are a recruitment analyst at an agency. For each candidate, judge fit for this job posting on must-have experience, seniority, skills, industry and location/work setup. " +
    "Reply with STRICT JSON only: {\"results\": [{\"n\": number, \"fit\": number (a percentage from 0 to 100, e.g. 85; never a 0-10 score), \"verdict\": \"Perfect fit\" | \"Good fit\" | \"Possible fit\" | \"Not a fit\", \"reason\": string, \"bullets\": string[]}]}. " +
    "reason: one short sentence. bullets: 3 short selling points for the hiring manager, each under 15 words, anonymous (no names, no employer names; say e.g. 'Big 4-trained').";
  const posting = `Job: ${lead.job_title} at ${lead.company}\nLocation: ${lead.location || "?"} (${lead.country || "?"})${lead.salary ? "\nPay: " + lead.salary : ""}\nDescription:\n${String(lead.description || "").slice(0, 4000)}`;
  const list = pool.map((c: any, i: number) => `n=${i} | ${anonSummary(c)}`).join("\n");
  const fits = await askAI(fitSys, posting + "\n\nCandidates:\n" + list, 3000);
  const kept = fitsToPercent(Array.isArray(fits?.results) ? fits.results : [])
    .map((r: any) => ({ r, c: pool[Number(r.n)] })).filter((x: any) => x.c && ["Perfect fit", "Good fit"].includes(x.r.verdict))
    .sort((a: any, b: any) => (Number(b.r.fit) || 0) - (Number(a.r.fit) || 0));
  if (!kept.length) return ignore("Our candidates weren't a strong enough fit");
  const matches = kept.map((x: any) => ({
    candidate_id: x.c.id, verdict: x.r.verdict, fit: Math.round(Number(x.r.fit) || 0), reason: scrub(String(x.r.reason || ""), [x.c]).slice(0, 300),
    bullets: (Array.isArray(x.r.bullets) ? x.r.bullets : []).slice(0, 3).map((b: unknown) => scrub(String(b), [x.c]).slice(0, 140)),
  }));

  // Ask the candidates first: one offer each, waiting for a recruiter to send it.
  for (const m of matches) {
    await admin.from("lead_offers").upsert({ lead_id: lead.id, candidate_id: m.candidate_id, fit: m.fit, verdict: m.verdict, reason: m.reason, bullets: m.bullets },
      { onConflict: "lead_id,candidate_id", ignoreDuplicates: true });
  }
  await admin.from("leads").update({ status: "awaiting", matches }).eq("id", lead.id);
  return { ok: true, kept: true, awaiting: matches.length };
}

// Once at least one candidate has said yes and confirmed their details: the hiring contact and
// the anonymous pitch, about the confirmed candidates only.
export async function pitchLead(admin: any, lead: any, s: Settings) {
  const { data: offers } = await admin.from("lead_offers").select("candidate_id,fit,verdict,reason,bullets").eq("lead_id", lead.id).eq("status", "confirmed");
  if (!offers?.length) return { ok: true, pitched: false };
  const { data: cs } = await admin.from("candidates").select("id,name,current_company").in("id", offers.map((o: any) => o.candidate_id));
  const kept = offers.map((o: any) => ({ c: (cs || []).find((c: any) => c.id === o.candidate_id) || { id: o.candidate_id }, r: o }));
  const matches = offers.map((o: any) => ({ candidate_id: o.candidate_id, verdict: o.verdict, fit: o.fit, reason: o.reason, bullets: o.bullets || [] }));
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

  // Pitch: short email and a LinkedIn note, both anonymous.
  const pitchSys = "You write short, specific business-development messages for a recruitment agency to a hiring manager who just posted a job. Reply with STRICT JSON only: " +
    "{\"subject\": string, \"body\": string, \"linkedin\": string}. Rules: never name the candidate or their current employer. " +
    "subject under 60 characters, referencing their role. body 80-130 words, plain text, start 'Hi <first name>,' (or 'Hi there,' if unknown), mention their open role by title, " +
    "present the candidate(s) anonymously using the selling points given, offer to send an anonymised profile, and end the body with: " +
    "'Interested? Click here: {{INTERESTED_LINK}} or just reply.' then a sign-off with only the sender's first name. No footer or unsubscribe text (added separately). " +
    "linkedin: under 280 characters, friendly, same offer, no links.";
  const pts = matches.map((m: any, i: number) => `Candidate ${i + 1} (${m.verdict}): ${m.bullets.join("; ")}`).join("\n");
  const pitch = await askAI(pitchSys, `${posting.slice(0, 1500)}\n\nHiring contact first name: ${poster?.first_name || "unknown"}${poster?.role ? " (" + poster.role + ")" : ""}\nSender first name: ${(s.senderName || "").split(" ")[0] || "the recruiter"}\n\nOur candidates:\n${pts}`, 2000);
  const kc = kept.map((x: any) => x.c);
  await admin.from("leads").update({
    status: "new", matches,
    contact_name: poster?.full_name || null, contact_first_name: poster?.first_name || null, contact_role: poster?.role || null,
    contact_linkedin: poster?.linkedin_url || null, contact_email: contactEmail || null, contact_email_status: emailStatus || null, channel,
    pitch_subject: scrub(String(pitch?.subject || ""), kc).slice(0, 120), pitch_body: scrub(String(pitch?.body || ""), kc).slice(0, 3000),
    linkedin_message: scrub(String(pitch?.linkedin || ""), kc).slice(0, 300),
  }).eq("id", lead.id);
  return { ok: true, kept: true, channel };
}

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
