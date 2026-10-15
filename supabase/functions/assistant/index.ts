import { createClient } from "npm:@supabase/supabase-js@2";

// The ProNext assistant: helps close roles. Signed-in staff only.
//   - It LOOKS THINGS UP itself (candidates, jobs, pipelines, interviews, client feedback, AI
//     lessons, team workload) and searches / reads the web. Lookups run with the caller's own
//     login, so the database's row security decides what comes back: a recruiter only ever sees
//     their own candidates. Money is filtered by role too (recruiters never see client fees).
//   - It never changes anything itself: it PROPOSES actions (propose_* tools). Each comes back to
//     the app as a card the person approves, and the app runs it with that person's permissions;
//     the server endpoints behind each action check again.
//   - Which actions it may propose depends on the role (TOOLS_FOR). Brainstorm mode has no actions.
//   POST { messages: [{ role, content }], mode: "work" | "brainstorm", page: { jobId?, candidateId? }, tz? }
//   ->   { text, proposals: [{ tool, input }], model }
// Each call's token and web-search use is logged to public.ai_usage (feature 'assistant').
// Morning brief (ops token, cron "harbor-morning-brief" on weekday mornings): { action: "brief_next" }
// writes one person's brief as a saved conversation (kind 'brief') with its proposed actions waiting
// for approval, a few people per call. Those runs use the service role, so recruiter scoping is
// applied in the lookups themselves (me.scoped) instead of by row security.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAST = Deno.env.get("ASSISTANT_MODEL") || Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";
const SMART = Deno.env.get("ASSISTANT_SMART_MODEL") || "claude-sonnet-4-5";
// USD per million tokens, for the spend log (input, output). Web search: $10 per 1,000.
const PRICE: Record<string, [number, number]> = { haiku: [1, 5], sonnet: [3, 15], opus: [5, 25] };
const priceOf = (m: string) => PRICE[Object.keys(PRICE).find((k) => m.includes(k)) || "sonnet"];
const MAX_STEPS = 8;
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const day = (d: unknown) => (d ? String(d).slice(0, 10) : "");

// ---------------------------------------------------------------- tools
const STAGES = ["Sourced", "In review", "Screening", "Submitted", "Interview", "Offer", "Placed", "Rejected", "Withdrawn"];
const READ_TOOLS = [
  { name: "list_jobs", description: "List jobs with their pipeline (how many candidates at each stage, days open, last activity). Start here to see which roles need attention.",
    input_schema: { type: "object", properties: { status: { type: "string", description: "Open (default), On hold, Draft, Closed or All" }, client: { type: "string" } } } },
  { name: "get_job", description: "Everything about one job: description, pay, screening questions, every candidate on it with stage, AI fit and verdict, unmet must-haves, client rejection reasons and feedback, what the AI has learned for this role, interviews and sourcing status.",
    input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
  { name: "search_candidates", description: "Find candidates by name, title, skill, location or company (matches any word). Also filter by job or status. Returns id, title, location, status, AI score and the roles they're on.",
    input_schema: { type: "object", properties: { query: { type: "string" }, job_id: { type: "string" }, status: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_candidate", description: "Full profile of one candidate: experience, skills, location, pay, notice, employers, AI strengths and gaps, and for every role they're on: stage, AI verdict, the requirement checklist, screening answers, follow-up questions, rejection details. Plus team notes and interviews.",
    input_schema: { type: "object", properties: { candidate_id: { type: "string" } }, required: ["candidate_id"] } },
  { name: "list_interviews", description: "Interviews in a date range (default: last 7 days to next 14), with candidate, role, status, decision and feedback.",
    input_schema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, job_id: { type: "string" } } } },
  { name: "team_workload", description: "Each team member's open candidates by stage, open tasks and interviews this week (Admins and Rec Ops only).",
    input_schema: { type: "object", properties: {} } },
  { name: "get_xray", description: "The X-ray sourcing for a job (Admins and Rec Ops only): the last run (state, when, the searches it ran, the must-have checklist, any direction given, how many found) and the people found so far (X-ray and Apollo prospects) with fit, verdict, overview, gaps, location, whether an email was found and outreach status. Use it to judge whether sourcing is finding the right people and how to steer the next run.",
    input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
];
const WEB_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5, max_content_tokens: 8000 },
];
const PROPOSE: Record<string, any> = {
  propose_job_draft: { name: "propose_job_draft", description: "Propose creating a new job as a DRAFT (the person reviews and publishes it).",
    input_schema: { type: "object", properties: {
      role: { type: "string" }, client: { type: "string" }, location: { type: "string" }, country: { type: "string" },
      work_setup: { type: "string", enum: ["Remote", "Hybrid", "On-site"] }, employment_type: { type: "string", enum: ["Full-time", "Part-time", "Contract", "Temporary", "Internship"] },
      description: { type: "string" }, currency: { type: "string" }, min_pay: { type: "number" }, max_pay: { type: "number" },
      fee_amount: { type: "number" }, fee_type: { type: "string", enum: ["flat", "percent"] }, contract: { type: "boolean" }, contract_months: { type: "number" },
    }, required: ["role", "client"] } },
  propose_interview: { name: "propose_interview", description: "Propose scheduling an interview for a candidate.",
    input_schema: { type: "object", properties: {
      candidate_id: { type: "string" }, job_id: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM, 24h" },
      timezone: { type: "string" }, duration_min: { type: "number" }, round: { type: "string" },
      location_type: { type: "string", enum: ["meet", "phone", "link", "in_person"] }, location: { type: "string" }, notes: { type: "string" }, notify_candidate: { type: "boolean" },
    }, required: ["candidate_id", "date", "time"] } },
  propose_note: { name: "propose_note", description: "Propose adding an internal note to a candidate's profile (only the team sees it).",
    input_schema: { type: "object", properties: { candidate_id: { type: "string" }, text: { type: "string" } }, required: ["candidate_id", "text"] } },
  propose_message: { name: "propose_message", description: "Propose sending a chat message (also emailed) to a candidate about a role they're on.",
    input_schema: { type: "object", properties: { candidate_id: { type: "string" }, job_id: { type: "string" }, text: { type: "string" } }, required: ["candidate_id", "text"] } },
  propose_stage: { name: "propose_stage", description: "Propose moving a candidate to a new stage on a role.",
    input_schema: { type: "object", properties: { candidate_id: { type: "string" }, job_id: { type: "string" }, stage: { type: "string", enum: STAGES } }, required: ["candidate_id", "stage"] } },
  propose_task: { name: "propose_task", description: "Propose a to-do / reminder with an optional due date. Admins and Rec Ops can assign it to a team member (assigned_to = their user id).",
    input_schema: { type: "object", properties: { title: { type: "string" }, due_on: { type: "string", description: "YYYY-MM-DD" }, assigned_to: { type: "string" }, job_id: { type: "string" }, candidate_id: { type: "string" } }, required: ["title"] } },
  propose_email: { name: "propose_email", description: "Draft an email the person sends THEMSELVES from their own Gmail (to a client, candidate or anyone). It appears with an 'Open in Gmail' button. Use for client submissions, shortlists, follow-ups and outreach that should come from the person.",
    input_schema: { type: "object", properties: { to: { type: "string", description: "Email address if known, else ''" }, subject: { type: "string" }, body: { type: "string", description: "Plain text, ready to send, signed with the person's first name" } }, required: ["subject", "body"] } },
  propose_route: { name: "propose_route", description: "Propose putting an existing candidate forward for another open role (they get it on their candidate page and accept), optionally with screening questions for what's unproven.",
    input_schema: { type: "object", properties: { candidate_id: { type: "string" }, job_id: { type: "string" }, questions: { type: "array", items: { type: "string" } } }, required: ["candidate_id", "job_id"] } },
  propose_xray: { name: "propose_xray", description: "Propose running an X-ray search for a job (free public-profile searches on LinkedIn, and GitHub and technical sites for technical roles; found people are reviewed against the job and saved as prospects). Steer it with direction drawn from what you learned: titles to search, places, must-haves, companies to target, terms to leave out, and up to 4 exact Google X-ray queries of your own (each starting with site:, e.g. site:linkedin.com/in). Admins and Rec Ops only.",
    input_schema: { type: "object", properties: { job_id: { type: "string" }, why: { type: "string", description: "One line for the person: what this run aims for and why" },
      guide: { type: "object", properties: {
        notes: { type: "string", description: "Plain direction for the search planner, e.g. 'Client rejected two people without Big 4 audit; only people with Big 4 audit then industry'" },
        titles: { type: "array", items: { type: "string" } }, locations: { type: "array", items: { type: "string" } }, must_have: { type: "array", items: { type: "string" } },
        target_companies: { type: "array", items: { type: "string" } }, exclude: { type: "array", items: { type: "string" } }, queries: { type: "array", items: { type: "string" } } } } }, required: ["job_id"] } },
  propose_bench_check: { name: "propose_bench_check", description: "Propose running the AI bench check for a job: reviews the closest people already in ProNext against it (uses AI credits). Admins and Rec Ops only.",
    input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
};
// What each role may propose. Recruiters work on their own candidates; anything bigger is a request to Rec Ops (a task).
const TOOLS_FOR: Record<string, string[]> = {
  admin: Object.keys(PROPOSE),
  recops: Object.keys(PROPOSE),
  recruiter: ["propose_interview", "propose_note", "propose_message", "propose_stage", "propose_task", "propose_email", "propose_route"],
};

// ---------------------------------------------------------------- lookups (caller's own login: RLS applies)
async function runRead(db: any, me: any, name: string, input: any): Promise<unknown> {
  const staff = me.role === "admin" || me.role === "recops";
  const feeOf = (j: any) => !staff ? undefined : j.billing_amount ? (j.billing_type === "percent" ? j.billing_amount + "%" : j.billing_amount + " " + (j.billing_currency || "")) + (j.billing_frequency === "Monthly" ? "/month" : "") : "";
  const yourCut = (j: any) => j.incentive_amount ? (j.incentive_type === "percent" ? j.incentive_amount + "%" : j.incentive_amount + " " + (j.incentive_currency || "")) : "";

  if (name === "list_jobs") {
    const status = String(input?.status || "Open");
    let q = db.from("jobs").select("id,role_title,client,status,location,work_setup,country,created_at,headcount,billing_type,billing_amount,billing_currency,billing_frequency,incentive_type,incentive_amount,incentive_currency,hold_reason").order("created_at", { ascending: false }).limit(80);
    if (status !== "All") q = q.eq("status", status);
    if (input?.client) q = q.ilike("client", "%" + input.client + "%");
    const { data: jobs, error } = await q;
    if (error) return { error: error.message };
    const ids = (jobs || []).map((j: any) => j.id);
    const { data: links0 } = ids.length ? await db.from("candidate_jobs").select("job_id,stage,updated_at,candidate_response,candidates(recruiter_id)").in("job_id", ids) : { data: [] };
    const links = me.scoped ? (links0 || []).filter((l: any) => l.candidates?.recruiter_id === me.id) : links0;
    return (jobs || []).map((j: any) => {
      const ls = (links || []).filter((l: any) => l.job_id === j.id && l.candidate_response !== "declined");
      const by: Record<string, number> = {};
      for (const l of ls) by[l.stage] = (by[l.stage] || 0) + 1;
      const last = ls.map((l: any) => l.updated_at).sort().pop();
      return { id: j.id, role: j.role_title, client: j.client, status: j.status, where: [j.location, j.work_setup, j.country].filter(Boolean).join(", "),
        days_open: Math.round((Date.now() - new Date(j.created_at).getTime()) / 864e5), openings: j.headcount || 1, pipeline: by, last_activity: day(last),
        fee: feeOf(j), recruiter_incentive: yourCut(j) || undefined, on_hold: j.hold_reason || undefined };
    });
  }

  if (name === "get_job") {
    const { data: j, error } = await db.from("jobs").select("*").eq("id", input.job_id).maybeSingle();
    if (error || !j) return { error: "Job not found or not visible to you" };
    const { data: links0 } = await db.from("candidate_jobs").select("id,candidate_id,stage,fit,ai,candidate_response,submitted_at,updated_at,reject_kind,reject_reason,reject_feedback,rejected_at,client_viewed_at,candidates(name,current_title,location,recruiter_id)").eq("job_id", j.id);
    const links = me.scoped ? (links0 || []).filter((l: any) => l.candidates?.recruiter_id === me.id) : links0;
    const { data: lessons } = await db.from("screening_lessons").select("kind,lesson,look_for").eq("job_id", j.id).eq("active", true).limit(20);
    const { data: ivs0 } = await db.from("interviews").select("candidate_id,round,starts_at,status,decision,feedback,recruiter_id").eq("job_id", j.id).order("starts_at", { ascending: false }).limit(20);
    const ivs = me.scoped ? (ivs0 || []).filter((i: any) => i.recruiter_id === me.id) : ivs0;
    return {
      id: j.id, role: j.role_title, client: j.client, status: j.status, hold: j.hold_reason || undefined, location: j.location, work_setup: j.work_setup, country: j.country,
      employment_type: j.employment_type, openings: j.headcount || 1, pay: [j.min_pay, j.max_pay].filter(Boolean).join("–") + " " + (j.currency || "") + (j.salary_period ? "/" + j.salary_period : ""),
      fee: feeOf(j), recruiter_incentive: yourCut(j) || undefined, days_open: Math.round((Date.now() - new Date(j.created_at).getTime()) / 864e5),
      description: clip(j.description, 3500), screening_questions: j.screening_questions || [], parallel_titles: j.parallel_titles || [],
      sourcing: j.sourcing?.internal ? { bench_checked: day(j.sourcing.internal.at), strong_bench_fits: j.sourcing.internal.goodFits } : undefined,
      candidates: (links || []).filter((l: any) => l.candidate_response !== "declined").map((l: any) => ({
        candidate_id: l.candidate_id, name: l.candidates?.name, title: l.candidates?.current_title, location: l.candidates?.location, stage: l.stage,
        ai_fit: l.fit, verdict: l.ai?.verdict, unmet_must_haves: (l.ai?.requirements || []).filter((r: any) => r.type === "must" && r.status !== "met").map((r: any) => r.requirement + " (" + r.status + ")").slice(0, 6),
        followups: l.ai?.followups ? l.ai.followups.state : undefined, submitted: day(l.submitted_at), client_viewed: day(l.client_viewed_at), last_update: day(l.updated_at),
        rejected: l.reject_reason ? { by: l.reject_kind, reason: l.reject_reason, feedback: clip(l.reject_feedback, 500), on: day(l.rejected_at) } : undefined,
      })),
      lessons_for_this_role: (lessons || []).map((x: any) => `[${x.kind}] ${x.lesson} Look for: ${x.look_for}`),
      interviews: (ivs || []).map((i: any) => ({ candidate_id: i.candidate_id, round: i.round, when: i.starts_at, status: i.status, decision: i.decision, feedback: clip(i.feedback, 300) })),
    };
  }

  if (name === "search_candidates") {
    const lim = Math.min(Number(input?.limit) || 25, 50);
    let q = db.from("candidates").select("id,name,current_title,current_company,location,status,ai_score,skills,experience,updated_at,recruiter_id,candidate_jobs(job_id,stage,fit)").eq("is_draft", false).order("updated_at", { ascending: false }).limit(input?.query ? 400 : lim);
    if (me.scoped) q = q.eq("recruiter_id", me.id);
    if (input?.status) q = q.eq("status", input.status);
    const { data, error } = await q;
    if (error) return { error: error.message };
    let rows = data || [];
    if (input?.job_id) rows = rows.filter((c: any) => (c.candidate_jobs || []).some((l: any) => l.job_id === input.job_id));
    if (input?.query) {
      const words = String(input.query).toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
      const scored = rows.map((c: any) => {
        const hay = [c.name, c.current_title, c.current_company, c.location, c.experience, ...(c.skills || [])].join(" ").toLowerCase();
        return { c, s: words.filter((w) => hay.includes(w)).length };
      }).filter((x: any) => x.s > 0).sort((a: any, b: any) => b.s - a.s);
      rows = scored.map((x: any) => x.c);
    }
    return rows.slice(0, lim).map((c: any) => ({ id: c.id, name: c.name, title: c.current_title, company: c.current_company, location: c.location, status: c.status, ai_score: c.ai_score,
      experience: c.experience, skills: (c.skills || []).slice(0, 8), roles: (c.candidate_jobs || []).map((l: any) => ({ job_id: l.job_id, stage: l.stage, fit: l.fit })), mine: c.recruiter_id === me.id }));
  }

  if (name === "get_candidate") {
    const { data: c, error } = await db.from("candidates").select("id,name,current_title,current_company,location,status,email,phone,linkedin_url,experience,notice,pay,skills,strengths,gaps,ai_score,industries,parallel_titles,preferences,email_opt_out,recruiter_id,created_at").eq("id", input.candidate_id).maybeSingle();
    if (error || !c || (me.scoped && c.recruiter_id !== me.id)) return { error: "Candidate not found or not visible to you" };
    const { data: links } = await db.from("candidate_jobs").select("id,job_id,stage,fit,ai,screening_answers,candidate_response,submitted_at,reject_kind,reject_reason,reject_feedback,jobs(role_title,client)").eq("candidate_id", c.id);
    const { data: notes } = await db.from("candidate_comments").select("body,created_at").eq("candidate_id", c.id).order("created_at", { ascending: false }).limit(10);
    const { data: ivs } = await db.from("interviews").select("job_id,round,starts_at,status,decision,feedback").eq("candidate_id", c.id).order("starts_at", { ascending: false }).limit(10);
    return {
      id: c.id, name: c.name, title: c.current_title, company: c.current_company, location: c.location, status: c.status, email: c.email, email_opt_out: c.email_opt_out || undefined,
      phone: c.phone, linkedin: c.linkedin_url, experience: c.experience, notice: c.notice, pay_expectation: c.pay, skills: c.skills, strengths: c.strengths, gaps: c.gaps,
      ai_score: c.ai_score, parallel_titles: c.parallel_titles, preferences: c.preferences || undefined,
      employers: (c.industries || []).slice(0, 10).map((x: any) => `${x.company} (${x.title || ""}, ${[x.from, x.to].filter(Boolean).join("–")}): ${x.confidence === "confirmed" ? x.industry : "industry unsure"}`),
      roles: (links || []).map((l: any) => ({ job_id: l.job_id, role: l.jobs?.role_title, client: l.jobs?.client, stage: l.stage, response: l.candidate_response, fit: l.fit, verdict: l.ai?.verdict,
        summary: clip(l.ai?.summary, 600), checklist: (l.ai?.requirements || []).map((r: any) => `[${r.type}] ${r.requirement}: ${r.status}${r.evidence ? " (" + clip(r.evidence, 120) + ")" : ""}`).slice(0, 20),
        screening_answers: (Array.isArray(l.screening_answers) ? l.screening_answers : []).map((a: any) => typeof a === "object" && a ? clip(a.q, 150) + " → " + clip(a.a, 400) : clip(a, 400)).slice(0, 10),
        followups: l.ai?.followups ? { state: l.ai.followups.state, qa: (l.ai.followups.questions || []).map((x: any) => clip(x.q, 200) + (x.a ? " → " + clip(x.a, 400) : "")) } : undefined,
        rejected: l.reject_reason ? { by: l.reject_kind, reason: l.reject_reason, feedback: clip(l.reject_feedback, 600) } : undefined, submitted: day(l.submitted_at) })),
      team_notes: (notes || []).map((n: any) => day(n.created_at) + ": " + clip(n.body, 400)),
      interviews: (ivs || []).map((i: any) => ({ job_id: i.job_id, round: i.round, when: i.starts_at, status: i.status, decision: i.decision, feedback: clip(i.feedback, 300) })),
      mine: c.recruiter_id === me.id,
    };
  }

  if (name === "list_interviews") {
    const from = input?.from || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const to = input?.to || new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    let q = db.from("interviews").select("candidate_id,job_id,round,starts_at,status,decision,feedback,recruiter_id,candidates(name),jobs(role_title,client)").gte("starts_at", from).lte("starts_at", to + "T23:59:59Z").order("starts_at").limit(60);
    if (input?.job_id) q = q.eq("job_id", input.job_id);
    if (me.scoped) q = q.eq("recruiter_id", me.id);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return (data || []).map((i: any) => ({ candidate_id: i.candidate_id, candidate: i.candidates?.name, job_id: i.job_id, role: i.jobs ? i.jobs.role_title + " (" + i.jobs.client + ")" : "", round: i.round, when: i.starts_at, status: i.status, decision: i.decision, feedback: clip(i.feedback, 200), mine: i.recruiter_id === me.id }));
  }

  if (name === "get_xray") {
    if (!staff) return { error: "Only Admins and Rec Ops can see sourcing" };
    const { data: j } = await db.from("jobs").select("id,role_title,client,xray").eq("id", String(input?.job_id || "")).maybeSingle();
    if (!j) return { error: "Job not found" };
    const { data: ps } = await db.from("prospects").select("id,full_name,title,company,location,source,fit,verdict,fit_reason,status,email,data,created_at").eq("job_id", j.id).is("archived_at", null).order("fit", { ascending: false, nullsFirst: false }).limit(30);
    const x = j.xray || {};
    return {
      job: `${j.role_title} at ${j.client}`,
      last_run: x.state ? { state: x.state, at: x.at, found: x.found, reviewed: x.reviewed, searches_run: x.searched, by_site: x.bySite, checklist: x.checklist, queries: x.queries, direction: x.guide || null, note: x.note || x.error || null } : "X-ray has not run for this job yet",
      people: (ps || []).map((p: any) => ({ id: p.id, name: p.full_name, title: p.title, company: p.company, location: p.location, found_by: p.data?.xray ? "X-ray " + (p.data.site || p.source) : p.source, fit: p.fit, verdict: p.verdict,
        overview: p.data?.overview || p.fit_reason, gaps: p.data?.gaps, has_email: !!p.email, outreach: p.status, profile: p.data?.profile_url || null })),
    };
  }

  if (name === "team_workload") {
    if (!staff) return { error: "Only Admins and Rec Ops can see the team's workload" };
    const { data: users } = await db.from("profiles").select("id,full_name,role,status").eq("status", "Active");
    const { data: cands } = await db.from("candidates").select("recruiter_id,candidate_jobs(stage)").eq("is_draft", false);
    const { data: tasks } = await db.from("tasks").select("assigned_to,status,due_on").eq("status", "open");
    const wk = new Date(Date.now() + 7 * 864e5).toISOString();
    const { data: ivs } = await db.from("interviews").select("recruiter_id").gte("starts_at", new Date().toISOString()).lte("starts_at", wk);
    return (users || []).map((u: any) => {
      const by: Record<string, number> = {};
      for (const c of (cands || []).filter((c: any) => c.recruiter_id === u.id)) for (const l of c.candidate_jobs || []) if (!["Rejected", "Withdrawn", "Placed"].includes(l.stage)) by[l.stage] = (by[l.stage] || 0) + 1;
      const ts = (tasks || []).filter((t: any) => t.assigned_to === u.id);
      return { id: u.id, name: u.full_name, role: u.role, active_pipeline: by, open_tasks: ts.length, overdue_tasks: ts.filter((t: any) => t.due_on && t.due_on < new Date().toISOString().slice(0, 10)).length, interviews_next_7_days: (ivs || []).filter((i: any) => i.recruiter_id === u.id).length };
    });
  }
  return { error: "Unknown lookup" };
}

// ---------------------------------------------------------------- prompt
function systemPrompt(me: any, mode: string, today: string, tz: string, page: any, jobs: any[], users: any[]) {
  const role = me.role === "admin" ? "Admin" : me.role === "recops" ? "Rec Ops manager" : "Recruiter";
  const scope = me.role === "recruiter"
    ? "As a Recruiter they see only their own candidates and never client fees or agency revenue (only their own incentive). Anything beyond their own candidates (sourcing, bench checks, submitting to a client, other people's candidates) is a request to Rec Ops: propose a task for Rec Ops instead."
    : me.role === "recops" ? "As Rec Ops they see every candidate and job and run the pipeline, sourcing and client submissions."
    : "As an Admin they see everything, including fees, revenue and the team's performance.";
  const common = `You are the ProNext assistant inside a recruitment agency's workspace. Your purpose is to help close roles: get strong candidates in front of clients and hired. You work for ${me.full_name || "the user"} (${role}). ${scope}
Today is ${today} (${tz}).
You can look things up yourself with the lookup tools (ProNext data) and web_search / web_fetch (the internet: candidate and company research, a client's news and hiring, salary benchmarks, where people with a rare skill work, competitor job posts). Look things up instead of asking the person for facts you can find. Never invent facts: if a lookup returns nothing, say so.
"X-ray" here always means X-ray sourcing: Google searches for people's public profiles (LinkedIn, GitHub and similar sites) for a job, never medical imaging. Admins and Rec Ops can run and steer it with get_xray and propose_xray; for a Recruiter, propose a task asking Rec Ops to run one.
Write plainly and briefly. No markdown headings; short paragraphs or simple "-" lists are fine.`;
  const work = `
HOW YOU ACT: you cannot change anything yourself. To do something, call the propose_* tools; each becomes a card the person approves. Propose several at once when a plan needs them. Only use real ids from lookups. If something essential is ambiguous (two people with the same name, a missing interview time), ask one short question.
CLOSING A ROLE (when asked to close, fill, unblock or review a role):
1) Diagnose with get_job (and get_candidate for the key people): is the pipeline too thin, the wrong profile (look at unmet must-haves, client rejection reasons and lessons), stuck (no update for days, interviews without feedback, submitted but not viewed), or is the brief itself the problem (pay below market: check the web; requirements too narrow)?
2) Say in 3-6 lines what's really blocking it, most important first.
SOURCING (Admins and Rec Ops): when the pipeline is thin or the wrong profile, check get_xray. If X-ray never ran, or found the wrong people (look at their gaps and at client rejection reasons and lessons), propose_xray with direction that fixes it: the titles, places, must-haves and target companies that match what the client actually wants, terms to leave out, and your own exact queries when you can write sharper ones. Use web_search to learn where such people work (competitors, firms) before steering.
3) Give a concrete plan and propose the actions for it right away: e.g. chase the client on submitted candidates (propose_email from the person), nudge stalled candidates (propose_message), schedule interviews, route strong people already in ProNext to it (propose_route with questions for what's unproven), run a bench check, reminders for follow-ups (propose_task), or a revised brief to suggest to the client (propose_email). Prefer actions that move a candidate closer to an offer this week.
Emails the person should send themselves (to clients, or personal notes to candidates) go in propose_email. Chat messages to candidates on a role go in propose_message.`;
  const brainstorm = `
BRAINSTORM MODE: think with the person. Explore options, challenge assumptions, bring numbers from ProNext and evidence from the web, and end with a clear recommendation and the next 2-3 steps. You have no action tools in this mode; if the person wants to act, tell them to switch Brainstorm off.`;
  const where = page?.jobId ? `\nThe person is looking at job ${page.jobId} right now ("this role" means it).` : page?.candidateId ? `\nThe person is looking at candidate ${page.candidateId} right now ("this candidate" means them).` : "";
  return common + (mode === "brainstorm" ? brainstorm : work) + where +
    `\n\nOpen jobs (id | role | client):\n${jobs.map((j) => `${j.id} | ${j.role_title} | ${j.client}`).join("\n") || "(none)"}` +
    `\n\nTeam (id | name | role):\n${users.map((u) => `${u.id} | ${u.full_name} | ${u.role}`).join("\n") || "(none)"}`;
}

// ---------------------------------------------------------------- Claude call
async function callClaude(key: string, payload: any, beta: string | null) {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
    if (beta) headers["anthropic-beta"] = beta;
    res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(payload) });
    if (res.ok || ![429, 500, 502, 503, 529].includes(res.status)) break;
    await sleep(attempt === 0 ? 2000 : 5000);
  }
  return res!;
}

// One assistant turn: lookups, web and proposals in a loop until it answers. Logs its cost.
async function runAgent(o: { admin: any; db: any; me: any; key: string; mode: string; messages: any[]; page: any; tz: string; smart?: boolean; forceModel?: string }) {
  const { admin, db, me, key, mode, page, tz } = o;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [{ data: jobs }, { data: users }] = await Promise.all([
    db.from("jobs").select("id,role_title,client").in("status", ["Open", "On hold"]).order("created_at", { ascending: false }).limit(80),
    db.from("profiles").select("id,full_name,role").eq("status", "Active"),
  ]);
  const allowed = mode === "brainstorm" ? [] : (TOOLS_FOR[me.role] || TOOLS_FOR.recruiter);
  const last = String(o.messages[o.messages.length - 1]?.content || "").toLowerCase();
  // The stronger model for planning and thinking; the fast one for quick asks.
  const model = o.forceModel || (o.smart || mode === "brainstorm" || /\b(close|fill|unblock|plan|strategy|why|diagnos|review)\b/.test(last) ? SMART : FAST);
  let useFetch = true;
  const tools = () => [...READ_TOOLS, ...(useFetch ? WEB_TOOLS : WEB_TOOLS.slice(0, 1)), ...allowed.map((n) => PROPOSE[n])];
  const system = [{ type: "text", text: systemPrompt(me, mode, today, tz, page || {}, jobs || [], users || []), cache_control: { type: "ephemeral" } }];
  const convo: any[] = [...o.messages];
  const proposals: any[] = [];
  let text = "", inTok = 0, outTok = 0, searches = 0, steps = 0, error = "", status = 200;
  while (steps++ < MAX_STEPS) {
    const payload = { model, max_tokens: 3000, system, tools: tools(), messages: convo };
    let res = await callClaude(key, payload, useFetch ? "web-fetch-2025-09-10" : null);
    if (!res.ok && res.status === 400 && useFetch) {
      const t = await res.text();
      if (/web_fetch|beta/i.test(t)) { useFetch = false; res = await callClaude(key, { ...payload, tools: tools() }, null); }
      else { error = "The assistant couldn't answer: " + t.slice(0, 200); status = 502; break; }
    }
    if (!res.ok) {
      const t = (await res.text()).slice(0, 300);
      status = /credit balance/i.test(t) ? 402 : 502;
      error = /credit balance/i.test(t) ? "The Claude account is out of credit. Top up at console.anthropic.com, then try again."
        : [429, 529].includes(res.status) ? "The assistant is busy right now. Try again in a minute." : "The assistant couldn't answer (" + res.status + "): " + t.slice(0, 160);
      break;
    }
    const out = await res.json();
    inTok += (Number(out?.usage?.input_tokens) || 0) + (Number(out?.usage?.cache_creation_input_tokens) || 0) + (Number(out?.usage?.cache_read_input_tokens) || 0) * 0.1;
    outTok += Number(out?.usage?.output_tokens) || 0;
    searches += Number(out?.usage?.server_tool_use?.web_search_requests) || 0;
    const blocks: any[] = Array.isArray(out?.content) ? out.content : [];
    const said = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (said) text = said; // the last thing it says is the answer; earlier "let me check…" lines are dropped
    // A long web search can pause the turn: hand it straight back to continue.
    if (out.stop_reason === "pause_turn") { convo.push({ role: "assistant", content: blocks }); continue; }
    const uses = blocks.filter((b) => b.type === "tool_use");
    if (!uses.length || out.stop_reason !== "tool_use") break;
    convo.push({ role: "assistant", content: blocks });
    const results: any[] = [];
    for (const u of uses) {
      if (u.name.startsWith("propose_")) {
        if (!allowed.includes(u.name)) { results.push({ type: "tool_result", tool_use_id: u.id, content: "Not allowed for this person's role. Propose a task for Rec Ops instead.", is_error: true }); continue; }
        proposals.push({ tool: u.name, input: u.input || {} });
        results.push({ type: "tool_result", tool_use_id: u.id, content: "Proposed. The person will approve or decline it." });
      } else {
        let r: unknown;
        try { r = await runRead(db, me, u.name, u.input || {}); } catch (e) { r = { error: String((e as Error)?.message || e) }; }
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(r).slice(0, 30000) });
      }
    }
    convo.push({ role: "user", content: results });
  }
  const [pi, po] = priceOf(model);
  await admin.from("ai_usage").insert({ user_id: me.id, feature: "assistant", model, input_tokens: Math.round(inTok), output_tokens: outTok,
    cost_usd: Math.round(((inTok * pi + outTok * po) / 1e6 + searches * 0.01) * 1e6) / 1e6 }).then(() => {}, () => {});
  return { error, status, model, proposals, text: text || (proposals.length ? "Here's what I'd do. Approve to go ahead." : "I couldn't find an answer to that.") };
}

const BRIEF_ASK = "Give me my morning brief. In a few short lines: what changed since yesterday, which roles are closest to a hire and what's blocking each, and the 3 most important things to do today to get a hire. Propose the actions for those 3 things (emails, messages, interviews, reminders) so I can approve them. If nothing needs doing, say so in one line.";

// Weekday mornings: the next few active people without today's brief get one, saved as a conversation.
async function briefNext(admin: any, key: string, max: number) {
  const tz = "Africa/Lagos";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const startUtc = new Date(Date.now() - 20 * 3600e3).toISOString();
  const { data: people } = await admin.from("profiles").select("id,full_name,role,status").eq("status", "Active").in("role", ["admin", "recops", "recruiter"]);
  const { data: done } = await admin.from("assistant_threads").select("user_id").eq("kind", "brief").gte("created_at", startUtc);
  const have = new Set((done || []).map((d: any) => d.user_id));
  const todo = (people || []).filter((p: any) => !have.has(p.id));
  const out: any[] = [];
  for (const p of todo.slice(0, max)) {
    const me = { ...p, scoped: p.role === "recruiter" };
    const r = await runAgent({ admin, db: admin, me, key, mode: "work", messages: [{ role: "user", content: BRIEF_ASK }], page: {}, tz, forceModel: FAST });
    if (r.error) { out.push({ id: p.id, error: r.error }); if (r.status === 402) break; continue; }
    const label = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(new Date());
    await admin.from("assistant_threads").insert({ user_id: p.id, kind: "brief", mode: "work", title: "Morning brief · " + label,
      messages: [{ role: "user", content: BRIEF_ASK }, { role: "assistant", content: r.text, proposals: r.proposals.map((x: any) => ({ ...x, state: x.tool === "propose_email" ? "draft" : "waiting" })) }] });
    out.push({ id: p.id, ok: true, proposals: r.proposals.length });
  }
  return { ok: true, today, done: out, remaining: Math.max(0, todo.length - out.length) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "The assistant isn't connected (ANTHROPIC_API_KEY)" }, 400);
    let me: any, db: any;
    const opsKey = req.headers.get("x-harbor-ops") || "";
    if (opsKey) {
      // Server-side runs (ops token): the morning brief, and a health check that answers as a given
      // person (read-only; proposals are returned, never carried out).
      const { data: tok } = await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!tok || opsKey.length < 32) return json({ error: "Invalid ops token" }, 403);
      if (body.action === "brief_next") return json(await briefNext(admin, key, Math.min(Number(body.max) || 2, 4)));
      if (!body.selftest_profile) return json({ error: "Unknown ops action" }, 400);
      ({ data: me } = await admin.from("profiles").select("id,full_name,role,status").eq("id", body.selftest_profile).single());
      if (!me) return json({ error: "No such profile" }, 404);
      me.scoped = me.role === "recruiter";
      db = admin;
    } else {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: caller } = await admin.auth.getUser(jwt);
      if (!caller?.user) return json({ error: "Not signed in" }, 401);
      ({ data: me } = await admin.from("profiles").select("id,full_name,role,status").eq("id", caller.user.id).single());
      if (!me || me.status !== "Active") return json({ error: "Your account isn't active" }, 403);
      // Every lookup runs as the person, so row security applies.
      db = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: "Bearer " + jwt } }, auth: { persistSession: false } });
    }

    const mode = body.mode === "brainstorm" ? "brainstorm" : "work";
    const tz = String(body.tz || "Africa/Lagos");
    const messages: any[] = (Array.isArray(body.messages) ? body.messages : []).slice(-20)
      .map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 6000) }))
      .filter((m: any) => m.content);
    while (messages.length && messages[0].role !== "user") messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "Ask something first" }, 400);

    const r = await runAgent({ admin, db, me, key, mode, messages, page: body.page || {}, tz, smart: !!body.smart });
    if (r.error) return json({ error: r.error }, r.status);
    return json({ ok: true, text: r.text, proposals: r.proposals, model: r.model });
  } catch (e) {
    console.error("assistant", String((e as Error)?.message || e));
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
