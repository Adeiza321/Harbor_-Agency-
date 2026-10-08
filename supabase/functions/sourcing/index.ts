import { createClient } from "npm:@supabase/supabase-js@2";
import { loadSettings, sendBlockers } from "./common.ts";
import { searchArea, sourceExternal } from "./prospects.ts";
import { COUNTRY_NAMES, targetCodes } from "./regions.ts";
import { fetchLeads, processLead } from "./leads.ts";
import { composeProspect, manualCompose, markManualSent, processQueue, queueLeads, queueProspects, sendTest } from "./queue.ts";
import { apolloKey, apolloSendCheck, sendViaApollo } from "./apollo.ts";
import { theirstackKey } from "./theirstack.ts";
import { provider } from "./send.ts";
import { requestSpend } from "./approvals.ts";

// Sourcing and outreach for Pronext.
//   Candidate side: every job that goes live has its bench checked first (ai-screen bench_fits,
//   matching the job's parallel titles both ways); only if there are fewer strong fits than the
//   setting does Pronext search Apollo, reveal verified emails for the best matches and draft emails.
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
    theirstack: !!theirstackKey(),
    sender: provider(),
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
    if (full) { await searchArea(admin, full, targetCodes(s.regions).map((c: string) => COUNTRY_NAMES[c]).filter(Boolean)); job.sourcing = full.sourcing; }
  } catch (e) { console.error("search area", errMsg(e)); }
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

// Leads waiting to be checked: a few per run, to stay within time and rate limits.
async function stepLeads(admin: any, s: any, agencyName: string, n = 3) {
  const { data: pending } = await admin.from("leads").select("*").eq("status", "pending").order("created_at").limit(n);
  let kept = 0; const errors: string[] = [];
  for (const l of pending || []) {
    try {
      const r = await processLead(admin, l, s);
      if (r.kept) {
        kept++;
        if (s.approval === "auto" && (r as any).channel === "email" && !sendBlockers(s).length) await queueLeads(admin, [l.id], null, s, agencyName);
      }
    } catch (e) { errors.push(errMsg(e).slice(0, 160)); }
  }
  return { processed: (pending || []).length, kept, errors };
}

// Data minimisation: prospects nobody engaged with are deleted after the retention period.
async function cleanup(admin: any, days: number) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const { count } = await admin.from("prospects").delete({ count: "exact" }).lt("created_at", cutoff)
    .in("status", ["found", "approved", "contacted", "not_interested", "rejected", "bounced"]);
  return count || 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
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
        try { out.send = await processQueue(admin, s); } catch (e) { out.sendError = errMsg(e); }
        try { out.deleted = await cleanup(admin, s.retentionDays); } catch (e) { out.cleanupError = errMsg(e); }
        return json({ ok: true, ...out });
      }
      if (body.action === "search_area" && body.jobId) {
        const { data: job } = await admin.from("jobs").select("*").eq("id", String(body.jobId)).maybeSingle();
        if (!job) return json({ error: "Job not found" }, 404);
        return json({ ok: true, area: await searchArea(admin, job, targetCodes(s.regions).map((c: string) => COUNTRY_NAMES[c]).filter(Boolean)) });
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
      if (body.action === "apollo_check") return json({ ok: true, ...(await apolloSendCheck()) });
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
    if (!caller?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("id,role,status,full_name,email").eq("id", caller.user.id).single();
    if (!me || me.status !== "Active") return json({ error: "Your account is not active" }, 403);
    if (!(me.role === "admin" || me.role === "recops")) return json({ error: "Only Rec Ops or Admins can run sourcing and outreach" }, 403);
    const { action } = body;
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 200);

    if (action === "status") {
      const since = new Date(); since.setUTCHours(0, 0, 0, 0);
      const [{ count: queued }, { count: sentToday }, { count: failed }] = await Promise.all([
        admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "queued"),
        admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", since.toISOString()),
        admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("status", "failed"),
      ]);
      const { count: approvals } = await admin.from("spend_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
      return json({ ok: true, connections: connections(), settings: s, blockers: sendBlockers(s), queue: { queued, sentToday, failed }, approvals: approvals || 0, canApprove: me.role === "admin" });
    }

    // Paid work from a button: an Admin confirms the cost and it runs; anyone else's click
    // becomes a request for an Admin to approve.
    const isAdmin = me.role === "admin";
    const logDirect = async (kind: string, jobId: string | null, title: string, est: { a: number; t: number }, result: unknown) => {
      await admin.from("spend_requests").insert({ kind, job_id: jobId, title, est_apollo: est.a, est_theirstack: est.t, cost_text: [est.t ? `up to ${est.t} TheirStack credits` : "", est.a ? `up to ${est.a} Apollo credits` : ""].filter(Boolean).join(" and "),
        status: "done", requested_by: me.id, decided_by: me.id, decided_at: new Date().toISOString(), result }).then(() => {}, () => {});
    };
    const runApproved = async (req: any) => {
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
      const area = await searchArea(admin, job, targetCodes(s.regions).map((c) => COUNTRY_NAMES[c]).filter(Boolean));
      return json({ ok: true, area });
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

    if (action === "approve_prospects") return json({ ok: true, queued: await queueProspects(admin, ids, me.id, s, agencyName) });
    if (action === "approve_leads") return json({ ok: true, queued: await queueLeads(admin, ids, me.id, s, agencyName) });
    if (action === "send_now") return json({ ok: true, ...(await processQueue(admin, s, 20)) });
    if (action === "manual_compose" || action === "manual_sent") {
      const kind = body.kind === "l" ? "l" : "p", id = String(body.id || "");
      if (!id) return json({ error: "id is required" }, 400);
      if (action === "manual_compose") return json({ ok: true, ...(await manualCompose(admin, kind, id, s, agencyName)) });
      return json(await markManualSent(admin, kind, id));
    }
    // "Email me a test": the prospect's first email, sent to your own address.
    if (action === "test_email") {
      const to = String(me.email || caller.user.email || "");
      if (!to) return json({ error: "Your profile has no email address" }, 400);
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
    return json({ error: errMsg(e) }, 500);
  }
});
