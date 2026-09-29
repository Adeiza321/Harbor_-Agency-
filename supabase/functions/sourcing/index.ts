import { createClient } from "npm:@supabase/supabase-js@2";
import { loadSettings, sendBlockers } from "./common.ts";
import { sourceExternal } from "./prospects.ts";
import { fetchLeads, processLead } from "./leads.ts";
import { processQueue, queueLeads, queueProspects } from "./queue.ts";
import { apolloKey } from "./apollo.ts";
import { theirstackKey } from "./theirstack.ts";
import { provider } from "./send.ts";

// Sourcing and outreach for Harbor.
//   Candidate side: every job that goes live has its bench checked first (ai-screen bench_fits,
//   matching the job's parallel titles both ways); only if there are fewer strong fits than the
//   setting does Harbor search Apollo, reveal verified emails for the best matches and draft emails.
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
  // internal_done: outside search only when the bench is short and Apollo is connected.
  if (!apolloKey()) {
    await admin.from("jobs").update({ sourcing: { ...(job.sourcing || {}), state: "done", external: { at: new Date().toISOString(), skipped: "Apollo not connected" } } }).eq("id", job.id);
    return { job: job.id, step: "external", skipped: "apollo" };
  }
  try {
    const r = await sourceExternal(admin, job.id, s);
    if (s.approval === "auto" && r.ids?.length && !sendBlockers(s).length) await queueProspects(admin, r.ids, null, s, agencyName);
    return { job: job.id, step: "external", ...r };
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
      if (body.action === "leads_daily") {
        if (!s.leads.enabled) return json({ ok: true, skipped: "Client leads are switched off in Outreach > Setup" });
        return json(await fetchLeads(admin, s));
      }
      return json({ error: "Unknown scheduled action" }, 400);
    }

    // Staff actions.
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("id,role,status,full_name").eq("id", caller.user.id).single();
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
      return json({ ok: true, connections: connections(), settings: s, blockers: sendBlockers(s), queue: { queued, sentToday, failed } });
    }

    if (action === "search_external") {
      if (!body.jobId) return json({ error: "jobId is required" }, 400);
      return json(await sourceExternal(admin, body.jobId, s, { force: !!body.force }));
    }

    if (action === "approve_prospects") return json({ ok: true, queued: await queueProspects(admin, ids, me.id, s, agencyName) });
    if (action === "approve_leads") return json({ ok: true, queued: await queueLeads(admin, ids, me.id, s, agencyName) });
    if (action === "send_now") return json({ ok: true, ...(await processQueue(admin, s, 20)) });
    if (action === "retry_failed") {
      await admin.from("outreach_messages").update({ status: "queued", error: null }).eq("status", "failed");
      return json({ ok: true, ...(await processQueue(admin, s, 20)) });
    }

    if (action === "fetch_leads") {
      const r = await fetchLeads(admin, s);
      if (!r.ok) return json(r);
      const p = await stepLeads(admin, s, agencyName, 3);
      return json({ ...r, processed: p.processed, kept: p.kept, message: r.message + ` Checked ${p.processed}, kept ${p.kept}; the rest are checked over the next hour.` });
    }
    if (action === "process_leads") return json({ ok: true, ...(await stepLeads(admin, s, agencyName, 3)) });

    // Won lead -> a draft job in Harbor (then it goes live like any other job).
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
