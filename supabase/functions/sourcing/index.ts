import { createClient } from "npm:@supabase/supabase-js@2";
import { recheckApollo } from "./musthaves.ts";
import { stopClosedRoleSequences } from "./closed.ts";
import { stepInactiveRecruiters } from "./accounts.ts";
import { holdForProfileCheck, releaseProfileHold, runProfileChecks } from "./profilecheck.ts";
import { holdReason } from "./queue.ts";
import { aiCharge } from "./ai.ts";
import { loadSettings, sendBlockers } from "./common.ts";
import { searchArea, sourceExternal } from "./prospects.ts";
import { jobCountryNames } from "./regions.ts";
import { fetchLeads, pitchLead, processLead, sendOfferMoving, sendOffers, shortlistUrl } from "./leads.ts";
import { offerAction, stepReminders } from "./pitch.ts";
import { composeProspect, finalBody, manualCompose, markManualSent, previewProspect, processQueue, queueLeads, queueProspects, sendLeadTest, sendTest } from "./queue.ts";
import { apolloKey, apolloSendCheck, sendViaApollo, stopInSequences } from "./apollo.ts";
import { theirstackKey } from "./theirstack.ts";
import { provider } from "./send.ts";
import { requestSpend } from "./approvals.ts";
import { cleanGuide, friendlyXrayError, runXrayStep, startXray, stepXrayQueue, stopXray, XRAY_STALE_MS } from "./xray.ts";
import { sourcedInterest, sweepSourcedInterest } from "./sourced.ts";
import { searchEngines, searchUsage, checkEngines } from "./search.ts";
import { autoFindEmails, draftEmails, findEmails, skipTooFar } from "./emails.ts";
import { matchPool } from "./pool.ts";
import { pdlKey } from "./pdl.ts";
import { contactoutKey } from "./contactout.ts";
import { areaErrors } from "./area_check.ts";
import { sourcePdl } from "./pdl_source.ts";
import { cleanTemplate, draftFromTemplate } from "./template.ts";

// The feature name each AI cost is filed under (Team audit), from the action that ran.
function aiFeatureName(action: string) {
  if (/xray/.test(action)) return "xray_search";
  if (/tick|search|source|apollo|pdl|pool/.test(action)) return "sourcing";
  if (/email|draft|template|approve/.test(action)) return "outreach_emails";
  if (/location/.test(action)) return "location_check";
  if (/lead/.test(action)) return "client_leads";
  return "sourcing";
}

// Sourcing and outreach for Pronext.
//   Candidate side: every job that goes live has its bench checked first (ai-screen bench_fits,
//   matching the job's parallel titles both ways). Then a free X-ray search (xray.ts) looks for
//   public profiles on LinkedIn and, for technical roles, GitHub and technical sites, through free
//   search engines only; and only if there are fewer strong fits than the setting does Pronext
//   search Apollo (paid, Admin approval), reveal verified emails for the best matches and draft emails.
//   People Data Labs (PDL_API_KEY, pdl.ts / pdl_source.ts): a paid people database searched for a job
//   on request (Admin approval), and a last email lookup for X-ray people (within a daily allowance).
//   Client side: a daily job feed (TheirStack) is matched against candidates who agreed to be
//   presented anonymously; the hiring contact gets an anonymous pitch by email, or a LinkedIn
//   note for a person to send (LinkedIn doesn't allow automated messages).
// Everything stays switched off until its key exists: APOLLO_API_KEY, THEIRSTACK_API_KEY, and a
// sender (Instantly or Gmail, see send.ts). Setup steps: supabase/SOURCING_SETUP.md.
//
// Staff call this with their login (Rec Ops/Admin). The scheduler calls it with an ops token.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-harbor-ops",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const errMsg = (e: unknown) => String((e as Error)?.message || e);

function connections() {
  return {
    anthropic: !!Deno.env.get("ANTHROPIC_API_KEY"),
    apollo: !!apolloKey(),
    contactout: !!contactoutKey(),
    pdl: !!pdlKey(),
    theirstack: !!theirstackKey(),
    sender: provider(),
    clientSender: provider("client"),
    search: searchEngines(),
  };
}

// Newly live jobs: check the bench (via ai-screen), then search outside if needed.
async function stepJobs(admin: any, s: any, opsKey: string, agencyName: string) {
  const { data: jobs } = await admin.from("jobs").select("id,sourcing").eq("status", "Open").in("sourcing->>state", ["pending", "internal_done"]).order("created_at").limit(1);
  const job = (jobs || [])[0];
  if (!job) return null;
  const state = job.sourcing?.state;
  if (state === "pending") {
    const res = await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/ai-screen", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_ANON_KEY"), apikey: Deno.env.get("SUPABASE_ANON_KEY")!, "x-harbor-ops": opsKey },
      body: JSON.stringify({ action: "bench_fits", jobId: job.id }),
    });
    const r = await res.json().catch(() => ({}));
    const { data: fresh } = await admin.from("jobs").select("sourcing").eq("id", job.id).single();
    const next = r?.ok ? "internal_done" : "done";
    await admin.from("jobs").update({ sourcing: { ...(fresh?.sourcing || {}), state: next, ...(r?.ok ? {} : { error: String(r?.error || res.status).slice(0, 200) }) } }).eq("id", job.id);
    return { job: job.id, step: "bench", ok: !!r?.ok, goodFits: r?.goodFits };
  }
  // internal_done: work out the search area (shown on the job page either way), then an outside
  // search only when the bench is short and Apollo is connected.
  try {
    const { data: full } = await admin.from("jobs").select("*").eq("id", job.id).single();
    if (full) { await searchArea(admin, full, jobCountryNames(full)); job.sourcing = full.sourcing; }
  } catch (e) { console.error("search area", errMsg(e)); }
  // The talent pool first: people found for closed roles who fit this one (free, no credits).
  try {
    const { data: full } = await admin.from("jobs").select("*").eq("id", job.id).single();
    if (full) await matchPool(admin, full, s, agencyName);
  } catch (e) { console.error("talent pool", errMsg(e)); }
  // Free X-ray search for every newly live job (runs in the background; nothing is spent).
  try {
    const { data: xr } = await admin.from("jobs").select("xray").eq("id", job.id).single();
    if (!xr?.xray) await startXray(admin, job.id, s, null);
  } catch (e) { console.error("xray start", errMsg(e)); }
  if (!apolloKey()) {
    await admin.from("jobs").update({ sourcing: { ...(job.sourcing || {}), state: "done", external: { at: new Date().toISOString(), skipped: "Apollo not connected" } } }).eq("id", job.id);
    return { job: job.id, step: "external", skipped: "apollo" };
  }
  // Apollo costs credits: check whether an outside search is needed, then ask an Admin.
  try {
    const chk: any = await sourceExternal(admin, job.id, s, { checkOnly: true });
    if (!chk.needed) return { job: job.id, step: "external", ...chk };
    const { data: cur } = await admin.from("jobs").select("sourcing").eq("id", job.id).single();
    job.sourcing = cur?.sourcing || job.sourcing;
    const { request } = await requestSpend(admin, "apollo_search", s, { jobId: job.id, title: `Search Apollo for outside candidates: ${chk.jobTitle}${chk.client ? ", " + chk.client : ""}` });
    await admin.from("jobs").update({ sourcing: { ...(job.sourcing || {}), state: "awaiting_approval", external: { requestedAt: new Date().toISOString(), requestId: request.id } } }).eq("id", job.id);
    return { job: job.id, step: "external", awaitingApproval: request.id };
  } catch (e) {
    await admin.from("jobs").update({ sourcing: { ...(job.sourcing || {}), state: "done", external: { at: new Date().toISOString(), error: errMsg(e).slice(0, 200) } } }).eq("id", job.id);
    return { job: job.id, step: "external", error: errMsg(e) };
  }
}

// Leads waiting to be checked: a few per run, to stay within time and rate limits. New postings are
// matched and pitched straight away; leads waiting for a checked blind resume are tried again.
// Apollo people not yet through the must-have check (found before it existed, or the AI was
// unavailable when they were found): a batch per run. Those that pass but whose core must-haves
// aren't shown anywhere free wait for a full-profile check (profilecheck.ts).
async function stepMusts(admin: any, s: any, max = 10, jobId?: string) {
  const r = await recheckApollo(admin, max, jobId);
  let held = 0;
  for (const h of r.holdIds) held += (await holdForProfileCheck(admin, s, h.jobId, h.ids)).held;
  return { checked: r.checked, skipped: r.skipped, held, remaining: r.remaining };
}

async function stepLeads(admin: any, s: any, agencyName: string, n = 3) {
  // Candidate first: a reminder to anyone told about a pitch 2+ days ago who hasn't responded.
  try { await stepReminders(admin); } catch (e) { console.error("pitch reminders", errMsg(e)); }
  const { data: pending } = await admin.from("leads").select("*").eq("status", "pending").order("created_at").limit(n);
  let kept = 0, pitched = 0; const errors: string[] = [];
  const queueIfAuto = async (l: any, r: any) => { if (r?.pitched) { pitched++; if (s.approval === "auto" && r.channel === "email" && !sendBlockers(s).length) await queueLeads(admin, [l.id], null, s, agencyName); } };
  // Waiting for blind resumes: pitched as soon as one of their candidates' blind resumes is checked.
  const { data: waiting } = await admin.from("leads").select("*").eq("status", "awaiting").order("updated_at").limit(n * 3);
  for (const l of waiting || []) {
    try { await queueIfAuto(l, await pitchLead(admin, l, s)); } catch (e) { errors.push(errMsg(e).slice(0, 160)); }
  }
  for (const l of pending || []) {
    try { const r: any = await processLead(admin, l, s); if (r.kept) kept++; await queueIfAuto(l, r); }
    catch (e) { errors.push(errMsg(e).slice(0, 160)); }
  }
  return { processed: (pending || []).length, kept, pitched, errors };
}

// A company said it's interested (the button on the candidates page, or in the email): the contract
// goes out by itself through the client sender (Outreach > Setup > Contract). Until a contract is
// set up, every active Admin is told once so they can send it themselves.
async function stepContracts(admin: any, s: any, agencyName: string) {
  const { data: leads } = await admin.from("leads").select("*").not("interested_at", "is", null).is("contract_sent_at", null).limit(10);
  let sent = 0, flagged = 0;
  const c = s.contract || {};
  for (const l of leads || []) {
    if (c.enabled && c.subject && c.body && l.contact_email) {
      const fill = (t: string) => String(t || "").replace(/\{\{first_name\}\}/gi, l.contact_first_name || "there").replace(/\{\{company\}\}/gi, l.company || "").replace(/\{\{role\}\}/gi, l.job_title || "")
        .replace(/\{\{contract_link\}\}/gi, c.url || "");
      const body = fill(c.body) + (c.url && !/\{\{contract_link\}\}/i.test(c.body) ? "\n\n" + c.url : "");
      const { error } = await admin.from("outreach_messages").insert({ kind: "client", lead_id: l.id, to_email: l.contact_email, to_name: l.contact_name, subject: fill(c.subject).slice(0, 200),
        body: finalBody(body, l.unsub_token, "l", l.region || "OTHER", s, agencyName, "client"), approved_by: null });
      if (!error) { await admin.from("leads").update({ contract_sent_at: new Date().toISOString(), status: l.status === "won" ? "won" : "meeting", notes: [l.notes, "Contract queued automatically " + new Date().toISOString().slice(0, 10)].filter(Boolean).join("\n") }).eq("id", l.id); sent++; }
      continue;
    }
    if (l.contract_flagged_at) continue;
    const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin").eq("status", "Active");
    for (const a of admins || []) {
      await admin.rpc("push_update", { p_user: a.id, p_kind: "event", p_title: l.company + " is interested in your candidates for " + l.job_title,
        p_body: (l.contact_name || "Their hiring contact") + (l.contact_email ? " (" + l.contact_email + ")" : "") + " clicked 'We're interested'. No contract is set up in Outreach > Setup yet, so send it yourself.",
        p_link: { page: "campaigns" }, p_dedupe: "lead-interest:" + l.id }).then(() => {}, () => {});
    }
    await admin.from("leads").update({ contract_flagged_at: new Date().toISOString() }).eq("id", l.id);
    flagged++;
  }
  return { sent, flagged };
}

// Everyone still waiting under Needs approval on open roles, with a known location, checked against
// the office: anyone clearly too far is moved to Skipped with the reason (nothing is deleted).
async function locationSweep(admin: any, dry = false) {
  const { data } = await admin.from("prospects").select("id,job_id,location,jobs!inner(status)").eq("status", "found").neq("jobs.status", "Closed").limit(2000);
  const ids: any = await skipTooFar(admin, (data || []).map((p: any) => ({ id: p.id, job_id: p.job_id, location: p.location })), dry);
  return { checked: (data || []).length, [dry ? "wouldSkip" : "skipped"]: ids.length, ids, ...(dry ? { report: ids.report } : {}), ...(areaErrors.length ? { errors: areaErrors.slice(-5) } : {}) };
}

// Data minimisation: prospects nobody engaged with are deleted after the retention period, and
// people in the talent pool (sourced for a role that has closed) 12 months after it closed.
const POOL_DAYS = 365;
async function cleanup(admin: any, days: number) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const { count } = await admin.from("prospects").delete({ count: "exact" }).lt("created_at", cutoff)
    .in("status", ["found", "approved", "contacted", "not_interested", "rejected", "bounced"]);
  const { count: pooled } = await admin.from("prospects").delete({ count: "exact" }).eq("status", "archived")
    .lt("archived_at", new Date(Date.now() - POOL_DAYS * 864e5).toISOString());
  return (count || 0) + (pooled || 0);
}

// Outreach templates (template.ts): redraft the emails still waiting for approval on a job.
async function redraftWaiting(admin: any, jobId: string, s: any) {
  const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, message: "Job not found" };
  const { data: people } = await admin.from("prospects").select("id,first_name,full_name,title,company,fit_reason,data").eq("job_id", jobId).eq("status", "found").not("email", "is", null).limit(300);
  const n = await draftFromTemplate(admin, job, people || [], String(s.senderName || "").split(" ")[0], s.includePay);
  return { ok: true, redrafted: n, message: n ? `Redrafted ${n} waiting email${n === 1 ? "" : "s"} from the template.` : "No emails waiting for approval on this job." };
}

Deno.serve((req: Request) => aiCharge.run({ feature: "sourcing", userId: null }, () => handle(req)));
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const charged = aiCharge.getStore();
    if (charged) charged.feature = aiFeatureName(String(body.action || ""));
    const { s, agencyName } = await loadSettings(admin);

    // Scheduled runs.
    const opsKey = req.headers.get("x-harbor-ops") || "";
    if (opsKey) {
      const { data: tok } = await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!tok || opsKey.length < 32) return json({ error: "Invalid ops token" }, 403);
      if (body.action === "tick") {
        const out: Record<string, unknown> = {};
        // One heavy step per run (a job's bench/outside search, or a few leads) keeps each run
        // well inside the function time limit; sending and clean-up are quick.
        try { out.jobs = await stepJobs(admin, s, opsKey, agencyName); } catch (e) { out.jobsError = errMsg(e); }
        if (!out.jobs) { try { out.leads = await stepLeads(admin, s, agencyName, 2); } catch (e) { out.leadsError = errMsg(e); } }
        try { out.xray = await stepXrayQueue(admin, s); } catch (e) { out.xrayError = errMsg(e); }
        try { out.musts = await stepMusts(admin, s, 10); } catch (e) { out.mustsError = errMsg(e); }
        try { out.closedStops = await stopClosedRoleSequences(admin); } catch (e) { out.closedStopsError = errMsg(e); }
        try { out.inactive = await stepInactiveRecruiters(admin); } catch (e) { out.inactiveError = errMsg(e); }
        try { out.sourcedInterest = await sweepSourcedInterest(admin); } catch (e) { out.sourcedInterestError = errMsg(e); }
        try { out.contracts = await stepContracts(admin, s, agencyName); } catch (e) { out.contractsError = errMsg(e); }
        try { out.send = await processQueue(admin, s); } catch (e) { out.sendError = errMsg(e); }
        try { out.deleted = await cleanup(admin, s.retentionDays); } catch (e) { out.cleanupError = errMsg(e); }
        return json({ ok: true, ...out });
      }
      // Every 2 minutes (cron harbor-xray-queue): start queued X-ray searches, pick up stalled ones.
      if (body.action === "xray_queue") return json({ ok: true, ...(await stepXrayQueue(admin, s)) });
      // Someone a recruiter found is interested (database trigger prospects_sourced_interest).
      if (body.action === "sourced_interest" && body.prospectId) {
        try { return json(await sourcedInterest(admin, String(body.prospectId))); }
        catch (e) { console.error("sourced interest", errMsg(e)); return json({ error: errMsg(e) }, 500); }
      }
      // One step of an X-ray run, in its own call (so its own time limit). Answers straight away;
      // the step works in the background and hands over to the next one when it needs to.
      if (body.action === "xray_step" && body.jobId) {
        // The search's AI cost is charged to whoever started it (Team audit), not to "automatic runs".
        if (charged) { const { data: xj } = await admin.from("jobs").select("xray").eq("id", String(body.jobId)).maybeSingle(); if (xj?.xray?.by) charged.userId = String(xj.xray.by); }
        const work = runXrayStep(admin, String(body.jobId), s, String(body.run || ""));
        // @ts-ignore EdgeRuntime is provided by Supabase Edge Functions
        if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
        return json({ ok: true });
      }
      // Summary + must-have checklist for people found outside X-ray (Apollo, PDL) who don't have one yet.
      if (body.action === "musts_backfill") return json({ ok: true, ...(await stepMusts(admin, s, Math.min(Number(body.max) || 20, 40), body.jobId ? String(body.jobId) : undefined)) });
      if (body.action === "search_area" && body.jobId) {
        const { data: job } = await admin.from("jobs").select("*").eq("id", String(body.jobId)).maybeSingle();
        if (!job) return json({ error: "Job not found" }, 404);
        return json({ ok: true, area: await searchArea(admin, job, jobCountryNames(job)) });
      }
      if (body.action === "leads_daily") {
        if (!s.leads.enabled) return json({ ok: true, skipped: "Client leads are switched off in Outreach > Setup" });
        if (!theirstackKey()) return json({ ok: true, skipped: "TheirStack isn't connected" });
        // TheirStack and Apollo cost credits: today's feed waits for an Admin's approval.
        const { request, created } = await requestSpend(admin, "leads_fetch", s, { title: "Fetch today's new job postings for client leads" });
        return json({ ok: true, awaitingApproval: request.id, created });
      }
      // A preview copy of a prospect's first email to a given address (Brevo); nothing is queued.
      if (body.action === "test_email" && body.prospectId && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.to || ""))) {
        return json(await sendTest(admin, String(body.prospectId), String(body.to), s, agencyName));
      }
      // Every 10 minutes (cron harbor-xray-emails): emails for the best X-ray people, within the daily cap.
      if (body.action === "auto_emails") {
        const r = await autoFindEmails(admin, s, agencyName);
        let loc: unknown = null;
        try { loc = await locationSweep(admin); } catch (e) { loc = { error: errMsg(e) }; }
        return json({ ok: true, ...r, locations: loc });
      }
      if (body.action === "location_sweep") return json({ ok: true, ...(await locationSweep(admin, !!body.dry)) });
      if (body.action === "apollo_check") return json({ ok: true, ...(await apolloSendCheck()) });
      if (body.action === "search_check") return json({ ok: true, ...(await checkEngines(admin, body.q ? String(body.q) : undefined, String(body.only || ""), Array.isArray(body.models) ? body.models.map(String) : [])) });
      // The talent pool for one job (also checked automatically when a job goes live).
      if (body.action === "pool" && body.jobId) {
        const { data: job } = await admin.from("jobs").select("*").eq("id", String(body.jobId)).maybeSingle();
        if (!job) return json({ error: "Job not found" }, 404);
        return json(await matchPool(admin, job, s, agencyName));
      }
      // Free X-ray search for one job (also started automatically for every newly live job).
      if (body.action === "xray" && body.jobId) return json(await startXray(admin, String(body.jobId), s, null, cleanGuide(body.guide)));
      if (body.action === "redraft_template" && body.jobId) return json(await redraftWaiting(admin, String(body.jobId), s));
      // Someone applied, said no, unsubscribed or was deleted (database trigger): finish their
      // Apollo sequence so the follow-ups stop.
      if (body.action === "apollo_stop") {
        const ids = (Array.isArray(body.contactIds) ? body.contactIds : []).map(String);
        try { return json({ ok: true, stopped: await stopInSequences(ids) }); }
        catch (e) { console.error("apollo stop", errMsg(e)); return json({ ok: false, error: errMsg(e) }, 502); }
      }
      // A test send through Apollo: a prospect's email, to a given address, with dummy unsubscribe links.
      if (body.action === "apollo_test" && body.prospectId && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.to || ""))) {
        const { data: p } = await admin.from("prospects").select("*").eq("id", String(body.prospectId)).maybeSingle();
        if (!p) return json({ error: "Not found" }, 404);
        const mail = await composeProspect(admin, { ...p, unsub_token: "test-preview" }, s, agencyName, new Map());
        const ref = await sendViaApollo({ kind: "candidate", to: String(body.to), firstName: "Test", lastName: "Pronext", company: "", subject: "[TEST] " + (p.subject || "A role that fits your background"), body: mail.text, html: mail.html });
        return json({ ok: true, contactId: ref });
      }
      return json({ error: "Unknown scheduled action" }, 400);
    }

    // Staff actions.
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Your session has ended. Sign in again." }, 401);
    const { data: me } = await admin.from("profiles").select("id,role,status,full_name,email").eq("id", caller.user.id).single();
    if (charged && me?.id) charged.userId = me.id;
    if (!me || me.status !== "Active") return json({ error: "Your account isn't active. Ask your admin." }, 403);
    const { action } = body;
    // Recruiters: their own X-ray search on a role they're engaged on, and how it's going. They see
    // the people they found through my_sourced_prospects (no emails); everything else is Rec Ops'.
    if (me.role === "recruiter") {
      const jobId = String(body.jobId || "");
      if (action === "xray_stop") return json(await stopXray(admin, jobId, s, me));
      if (action === "xray" || action === "xray_status") {
        const { data: job } = await admin.from("jobs").select("id,status,lead_role,xray").eq("id", jobId).maybeSingle();
        if (!job) return json({ error: "We couldn't find this job. Refresh the page and try again." }, 404);
        if (action === "xray_status") {
          const { data: reqs } = await admin.from("xray_requests").select("created_at,started_at,finished_at,found,error").eq("job_id", jobId).eq("requested_by", me.id).order("created_at", { ascending: false }).limit(1);
          const r = (reqs || [])[0] || null;
          const x = job.xray || {};
          const mine = x.by === me.id && x.state === "running" && Date.now() - new Date(x.at || 0).getTime() < XRAY_STALE_MS;
          return json({ ok: true, request: r, running: mine, progress: mine ? x.progress || null : null });
        }
        if (job.status !== "Open" || job.lead_role) return json({ error: "You can only search for roles that are open." }, 400);
        const [{ data: onList }, { data: eng }] = await Promise.all([
          admin.from("job_recruiters").select("job_id").eq("job_id", jobId).eq("recruiter_id", me.id).limit(1),
          admin.from("job_engagements").select("id").eq("job_id", jobId).eq("recruiter_id", me.id).is("disengaged_at", null).limit(1),
        ]);
        if (!onList?.length && !eng?.length) return json({ error: "Engage on this role first, then you can run an X-ray search for it." }, 403);
        return json(await startXray(admin, jobId, s, me.id, null));
      }
      return json({ error: "Only Rec Ops and Admins can do this. Ask them, or message them from the role." }, 403);
    }
    if (!(me.role === "admin" || me.role === "recops")) return json({ error: "Only Rec Ops and Admins can run sourcing and outreach." }, 403);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 200);

    if (action === "status") {
      const since = new Date(); since.setUTCHours(0, 0, 0, 0);
      const [{ count: queued }, { count: sentToday }, { count: failed }] = await Promise.all([
        admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "queued"),
        admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", since.toISOString()),
        admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "failed"),
      ]);
      const { count: approvals } = await admin.from("spend_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
      const searchUse = await searchUsage(admin).catch(() => ({}));
      return json({ ok: true, connections: connections(), searchUsage: searchUse, settings: s, blockers: sendBlockers(s), queue: { queued, sentToday, failed }, approvals: approvals || 0, canApprove: me.role === "admin" });
    }

    // Paid work from a button: an Admin confirms the cost and it runs; anyone else's click
    // becomes a request for an Admin to approve.
    const isAdmin = me.role === "admin";
    const logDirect = async (kind: string, jobId: string | null, title: string, est: { a: number; t: number }, result: unknown) => {
      await admin.from("spend_requests").insert({ kind, job_id: jobId, title, est_apollo: est.a, est_theirstack: est.t, cost_text: [est.t ? `up to ${est.t} TheirStack credits` : "", est.a ? `up to ${est.a} Apollo credits` : ""].filter(Boolean).join(" and "),
        status: "done", requested_by: me.id, decided_by: me.id, decided_at: new Date().toISOString(), result }).then(() => {}, () => {});
    };
    const runApproved = async (req: any) => {
      if (req.kind === "pdl_search") {
        const r: any = await sourcePdl(admin, req.job_id, s, agencyName);
        if (s.approval === "auto" && r.ids?.length && !sendBlockers(s).length) await queueProspects(admin, r.ids, null, s, agencyName);
        return r;
      }
      if (req.kind === "pdl_profiles") return await runProfileChecks(admin, req.job_id, Array.isArray(req.payload?.ids) ? req.payload.ids : []);
      if (req.kind === "xray_emails") return await findEmails(admin, { jobId: req.job_id, ids: Array.isArray(req.payload?.ids) ? req.payload.ids : [] }, s, agencyName);
      if (req.kind === "apollo_search") {
        const r: any = await sourceExternal(admin, req.job_id, s, { force: true });
        if (s.approval === "auto" && r.ids?.length && !sendBlockers(s).length) await queueProspects(admin, r.ids, null, s, agencyName);
        return r;
      }
      const r: any = await fetchLeads(admin, s);
      if (!r.ok) return r;
      const pr = await stepLeads(admin, s, agencyName, 3);
      return { ...r, processed: pr.processed, kept: pr.kept, message: r.message + ` Checked ${pr.processed}, kept ${pr.kept}; the rest are checked over the next hour.` };
    };

    // Where an outside search would look (free: no Apollo credits, one small AI call, cached).
    if (action === "search_area") {
      const { data: job } = await admin.from("jobs").select("*").eq("id", String(body.jobId || "")).maybeSingle();
      if (!job) return json({ error: "Job not found" }, 404);
      const area = await searchArea(admin, job, jobCountryNames(job));
      return json({ ok: true, area });
    }

    // Free X-ray search (LinkedIn, and GitHub and technical sites for technical roles). No
    // credits are used, so it runs straight away for Rec Ops and Admins.
    // The job's first outreach email in the agency's own words; saving redrafts the emails waiting for approval.
    if (action === "save_template") {
      if (!body.jobId) return json({ error: "jobId is required" }, 400);
      const t = body.template === null ? null : cleanTemplate(body.template);
      if (body.template !== null && !t) return json({ error: "A template needs a subject and a body" }, 400);
      await admin.from("jobs").update({ outreach_template: t }).eq("id", String(body.jobId));
      const r = t ? await redraftWaiting(admin, String(body.jobId), s) : { redrafted: 0 };
      return json({ ok: true, template: t, redrafted: r.redrafted || 0 });
    }
    if (action === "redraft_template") return json(await redraftWaiting(admin, String(body.jobId || ""), s));

    if (action === "xray") {
      if (!body.jobId) return json({ error: "Choose a job first." }, 400);
      // Optional direction (titles, places, must-haves, companies, exclusions, exact searches).
      return json(await startXray(admin, String(body.jobId), s, me.id, cleanGuide(body.guide)));
    }
    // Stop a running X-ray search (one reviewing keeps the best of who it already reviewed).
    if (action === "xray_stop") {
      if (!body.jobId) return json({ error: "Choose a job first." }, 400);
      return json(await stopXray(admin, String(body.jobId), s, me));
    }

    // People from the talent pool who fit this job (free; also checked when a job goes live).
    if (action === "pool") {
      const { data: job } = await admin.from("jobs").select("*").eq("id", String(body.jobId || "")).maybeSingle();
      if (!job) return json({ error: "Job not found" }, 404);
      if (job.status === "Closed") return json({ ok: true, matched: 0, message: "This role is closed." });
      return json(await matchPool(admin, job, s, agencyName));
    }

    if (action === "search_external") {
      if (!body.jobId) return json({ error: "jobId is required" }, 400);
      if (!apolloKey()) return json({ ok: false, notConnected: "apollo", message: "Apollo isn't connected yet. Add the APOLLO_API_KEY secret to search outside Pronext." });
      const chk: any = await sourceExternal(admin, body.jobId, s, { force: !!body.force, checkOnly: true });
      if (!chk.needed) return json(chk);
      const title = `Search Apollo for outside candidates: ${chk.jobTitle}${chk.client ? ", " + chk.client : ""}`;
      if (isAdmin && !body.confirmed) return json({ ok: true, needsConfirm: true, costText: `up to ${s.prospectsPerJob} Apollo credits` + (chk.area ? `. Searching: ${chk.area}` : ""), title });
      if (isAdmin) { const r = await runApproved({ kind: "apollo_search", job_id: body.jobId }); await logDirect("apollo_search", body.jobId, title, { a: s.prospectsPerJob, t: 0 }, r); return json(r); }
      const { created } = await requestSpend(admin, "apollo_search", s, { jobId: body.jobId, title, requestedBy: me.id });
      return json({ ok: true, requested: true, message: created ? "Sent to an Admin for approval. It runs once they approve." : "Already waiting for an Admin's approval." });
    }

    // People Data Labs search for one job (paid): Admins confirm the cost, anyone else asks an Admin.
    if (action === "search_pdl") {
      if (!body.jobId) return json({ error: "jobId is required" }, 400);
      const chk: any = await sourcePdl(admin, String(body.jobId), s, agencyName, { checkOnly: true });
      if (!chk.needed) return json(chk);
      const title = `Search People Data Labs for outside candidates: ${chk.jobTitle}${chk.client ? ", " + chk.client : ""}`;
      const cost = `up to ${s.pdlPerSearch} People Data Labs credits (1 per person returned, about $0.20–0.28 each). Searching: ${chk.area}`;
      if (isAdmin && !body.confirmed) return json({ ok: true, needsConfirm: true, costText: cost, title });
      if (isAdmin) {
        const r: any = await runApproved({ kind: "pdl_search", job_id: body.jobId });
        await admin.from("spend_requests").insert({ kind: "pdl_search", job_id: body.jobId, title, est_apollo: 0, est_theirstack: 0, cost_text: `up to ${s.pdlPerSearch} People Data Labs credits`,
          status: "done", requested_by: me.id, decided_by: me.id, decided_at: new Date().toISOString(), result: r }).then(() => {}, () => {});
        return json(r);
      }
      const { created } = await requestSpend(admin, "pdl_search", s, { jobId: String(body.jobId), title, requestedBy: me.id });
      return json({ ok: true, requested: true, message: created ? "Sent to an Admin for approval. It runs once they approve." : "Already waiting for an Admin's approval." });
    }

    // Emails for X-ray results: see emails.ts (also found automatically every 10 minutes).
    if (action === "find_emails") {
      // Runs straight away, no approval: X-ray emails are found automatically anyway; this just
      // doesn't wait for the next run (and looks up anyone asked for, whatever their fit), within the daily cap.
      const o = { jobId: body.jobId ? String(body.jobId) : null, ids };
      if (!o.jobId && !ids.length) return json({ error: "jobId or ids is required" }, 400);
      if (!apolloKey() && !contactoutKey()) return json({ ok: false, notConnected: "apollo", message: "No email source is connected. Add the CONTACTOUT_API_KEY or APOLLO_API_KEY secret to look up emails." });
      return json({ ok: true, ...(await autoFindEmails(admin, s, agencyName, o)) });
    }

    if (action === "list_requests") {
      const { data } = await admin.from("spend_requests").select("*").order("created_at", { ascending: false }).limit(60);
      return json({ ok: true, requests: data || [], canApprove: isAdmin });
    }
    if (action === "approve_request" || action === "decline_request") {
      if (!isAdmin) return json({ error: "Only an Admin can approve spending" }, 403);
      const { data: req } = await admin.from("spend_requests").select("*").eq("id", body.id).maybeSingle();
      if (!req) return json({ error: "Request not found" }, 404);
      if (req.status !== "pending") return json({ error: "This request was already " + req.status }, 409);
      const now = new Date().toISOString();
      if (action === "decline_request") {
        await admin.from("spend_requests").update({ status: "declined", decided_by: me.id, decided_at: now }).eq("id", req.id);
        // Full-profile check declined: the people waiting on it can be emailed as they are.
        if (req.kind === "pdl_profiles") await releaseProfileHold(admin, Array.isArray(req.payload?.ids) ? req.payload.ids : [], "Full-profile check declined by " + (me.full_name || "an Admin"));
        if (req.kind === "apollo_search" && req.job_id) {
          const { data: j } = await admin.from("jobs").select("sourcing").eq("id", req.job_id).maybeSingle();
          await admin.from("jobs").update({ sourcing: { ...(j?.sourcing || {}), state: "done", external: { at: now, skipped: "Declined by " + (me.full_name || "an Admin") } } }).eq("id", req.job_id);
        }
        return json({ ok: true, message: "Declined. Nothing was spent." });
      }
      await admin.from("spend_requests").update({ status: "approved", decided_by: me.id, decided_at: now }).eq("id", req.id);
      try {
        const r: any = await runApproved(req);
        await admin.from("spend_requests").update({ status: r?.ok === false ? "failed" : "done", result: r, error: r?.ok === false ? String(r.message || "").slice(0, 300) : null }).eq("id", req.id);
        return json({ ok: true, ...r });
      } catch (e) {
        await admin.from("spend_requests").update({ status: "failed", error: errMsg(e).slice(0, 300) }).eq("id", req.id);
        return json({ error: errMsg(e) }, 500);
      }
    }

    if (action === "approve_prospects") {
      const { data: picked } = ids.length ? await admin.from("prospects").select("id,source,status,data").in("id", ids) : { data: [] };
      const why = (picked || []).map((p: any) => holdReason(p)).filter(Boolean) as string[];
      return json({ ok: true, queued: await queueProspects(admin, ids, me.id, s, agencyName), held: why.length, heldWhy: [...new Set(why)] });
    }
    // "Location OK": a person checked where they are; they can be approved, and are never held again.
    if (action === "location_ok") {
      const { data: rows } = ids.length ? await admin.from("prospects").select("id,data,email,body").in("id", ids) : { data: [] };
      for (const r of rows || []) {
        const gaps = (Array.isArray(r.data?.gaps) ? r.data.gaps : []).filter((g: string) => !/check they can commute|Location not shown/i.test(String(g)));
        await admin.from("prospects").update({ data: { ...(r.data || {}), location_hold: null, location_ok: { by: me.id, at: new Date().toISOString() }, gaps } }).eq("id", r.id);
      }
      const undrafted = (rows || []).filter((r: any) => r.email && !r.body).map((r: any) => r.id);
      if (undrafted.length) await draftEmails(admin, undrafted, s, agencyName);
      return json({ ok: true, cleared: (rows || []).length });
    }
    if (action === "approve_leads") return json({ ok: true, queued: await queueLeads(admin, ids, me.id, s, agencyName) });
    if (action === "send_now") return json({ ok: true, ...(await processQueue(admin, s, 20)) });
    if (action === "manual_compose" || action === "manual_sent") {
      const kind = body.kind === "l" ? "l" : "p", id = String(body.id || "");
      if (!id) return json({ error: "id is required" }, 400);
      if (action === "manual_compose") return json({ ok: true, ...(await manualCompose(admin, kind, id, s, agencyName)) });
      return json(await markManualSent(admin, kind, id));
    }
    // "Email me a test": the first email to a prospect (or the pitch to a lead), sent to your
    // own address so you see exactly what they'd get. Nothing is queued or marked as sent.
    if (action === "preview_email") return json(await previewProspect(admin, String(body.id || ""), s, agencyName));
    if (action === "test_email") {
      const to = String(me.email || caller.user.email || "");
      if (!to) return json({ error: "Your profile has no email address" }, 400);
      if (body.kind === "l") return json(await sendLeadTest(admin, String(body.id || ""), to, s, agencyName));
      return json(await sendTest(admin, String(body.id || ""), to, s, agencyName));
    }
    if (action === "apollo_check") return json({ ok: true, ...(await apolloSendCheck()) });
    if (action === "retry_failed") {
      await admin.from("outreach_messages").update({ status: "queued", error: null }).eq("status", "failed");
      return json({ ok: true, ...(await processQueue(admin, s, 20)) });
    }

    if (action === "fetch_leads") {
      if (!theirstackKey()) return json({ ok: false, notConnected: "theirstack", message: "The job feed isn't connected yet. Add the THEIRSTACK_API_KEY secret." });
      const title = "Fetch today's new job postings for client leads";
      const costText = `up to ${s.leads.postingsPerDay} TheirStack credits and up to ${s.leads.postingsPerDay} Apollo credits`;
      if (isAdmin && !body.confirmed) return json({ ok: true, needsConfirm: true, costText, title });
      if (isAdmin) { const r = await runApproved({ kind: "leads_fetch" }); await logDirect("leads_fetch", null, title, { a: s.leads.postingsPerDay, t: s.leads.postingsPerDay }, r); return json(r); }
      const { created } = await requestSpend(admin, "leads_fetch", s, { title, requestedBy: me.id });
      return json({ ok: true, requested: true, message: created ? "Sent to an Admin for approval. It runs once they approve." : "Already waiting for an Admin's approval." });
    }
    if (action === "process_leads") return json({ ok: true, ...(await stepLeads(admin, s, agencyName, 3)) });
    // Ask candidates about matched roles (the role goes without the employer's name).
    if (action === "offer_send") {
      const ids = (Array.isArray(body.offerIds) ? body.offerIds : []).map(String).filter(Boolean);
      if (!ids.length) return json({ error: "Pick at least one candidate" }, 400);
      return json({ ok: true, ...(await sendOffers(admin, ids, me.id)) });
    }
    if (action === "offer_skip") {
      const ids = (Array.isArray(body.offerIds) ? body.offerIds : []).map(String).filter(Boolean);
      await admin.from("lead_offers").update({ status: "skipped" }).in("id", ids).eq("status", "suggested");
      return json({ ok: true });
    }
    // The employer agreed and the candidate is on the role: let them know (employer still unnamed).
    if (action === "offer_moving" && body.offerId) return json({ ok: true, ...(await sendOfferMoving(admin, String(body.offerId))) });
    // A lead's pitch right away (after a candidate confirmed), instead of waiting for the next run.
    if (action === "pitch_lead" && body.leadId) {
      const { data: l } = await admin.from("leads").select("*").eq("id", body.leadId).single();
      if (!l) return json({ error: "Lead not found" }, 404);
      // force: send now with the candidates who are ready, without waiting for the rest.
      return json(await pitchLead(admin, l, s, body.force === true));
    }
    // Candidate first: one candidate on a pitch. push = ready without waiting; withdraw / remove =
    // off this pitch; remind = the reminder email now.
    if (["offer_push", "offer_withdraw", "offer_remove", "offer_remind"].includes(action) && body.offerId) {
      if (!isAdmin && me.role !== "recops") return json({ error: "Only Rec Ops or an Admin can do this" }, 403);
      const { data: pf } = await admin.from("profiles").select("full_name").eq("id", me.id).maybeSingle();
      return json(await offerAction(admin, { id: me.id, name: String(pf?.full_name || "") }, String(body.offerId), action.replace("offer_", "") as any));
    }

    // Won lead -> a draft job in Pronext (then it goes live like any other job).
    if (action === "convert_lead") {
      const { data: l } = await admin.from("leads").select("*").eq("id", body.leadId).maybeSingle();
      if (!l) return json({ error: "Lead not found" }, 404);
      if (l.converted_job_id) return json({ ok: true, jobId: l.converted_job_id });
      const { data: j, error } = await admin.from("jobs").insert({
        role_title: l.job_title, client: l.company, location: l.location || null, description: l.description || null,
        status: "Draft", created_by: me.id, country: l.country && l.country.length === 2 ? l.country : null,
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      await admin.from("leads").update({ status: "won", converted_job_id: j.id }).eq("id", l.id);
      return json({ ok: true, jobId: j.id });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("sourcing", errMsg(e));
    return json({ error: friendlyXrayError(e) }, 500);
  }
}
