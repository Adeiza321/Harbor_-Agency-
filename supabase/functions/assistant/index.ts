import { createClient } from "npm:@supabase/supabase-js@2";

// The ProNext assistant: helps close roles. Signed-in staff only.
//   - It LOOKS THINGS UP itself (candidates, jobs, pipelines, interviews, client feedback, AI
//     lessons, team workload, anyone by name or LinkedIn link, X-ray prospects, the bench check,
//     sourcing across roles, tasks, the Inbox, its person's own chats, placements, recent activity)
//     and searches / reads the web. It knows how the app works for each role (GUIDE) so it can
//     walk people through it, and it's told to say when it isn't sure. Lookups run with the caller's own
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
// for approval, a few people per call. End-of-day round-up (cron "harbor-assistant-roundup"):
// { action: "roundup_next" }, the same way (kind 'roundup'), and posted to assistant_updates. Those runs use the service role, so recruiter scoping is
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
const MAX_STEPS = 10;
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const day = (d: unknown) => (d ? String(d).slice(0, 10) : "");
// Prospect statuses as the app shows them (Outreach tabs and the job's Sourcing tab).
const PROSPECT_LABEL: Record<string, string> = { found: "Needs approval", approved: "Approved", queued: "Queued to send", contacted: "Emailed", interested: "Interested", not_interested: "Not interested", unsubscribed: "Unsubscribed", bounced: "Bounced", rejected: "Skipped", converted: "Converted", archived: "In talent pool" };
const prospectLabel = (p: any) => p.archived_at ? "In talent pool" : p.data?.xray && p.status === "found" ? (p.email ? "Needs approval" : "To contact (no email yet)") : p.data?.xray && p.status === "contacted" ? "Contacted" : (PROSPECT_LABEL[p.status] || p.status);
const PROSPECT_GROUPS: Record<string, string[]> = { needs_approval: ["found"], emailed: ["approved", "queued", "contacted"], interested: ["interested", "converted"], skipped: ["rejected", "not_interested", "unsubscribed", "bounced"] };

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
  { name: "get_xray", description: "The X-ray sourcing for a job (Admins and Rec Ops only): the last run (state, when, the searches it ran, the must-have checklist, any direction given, how many found), counts by outreach status, and EVERY person found for the role (X-ray and Apollo prospects, best fit first) with fit, verdict, status as the app shows it (Needs approval / To contact, Emailed, Interested, Skipped…), LinkedIn link and whether an email was found; overview and gaps too when the list is short. Filter with status and/or query (name, title, company). Use it to judge whether sourcing is finding the right people and how to steer the next run.",
    input_schema: { type: "object", properties: { job_id: { type: "string" }, status: { type: "string", enum: ["all", "needs_approval", "emailed", "interested", "skipped", "talent_pool"], description: "Default: everyone except the talent pool" }, query: { type: "string", description: "Words to match in name, title, company or LinkedIn link" } }, required: ["job_id"] } },
  { name: "find_person", description: "Find a person anywhere in ProNext by name, LinkedIn link, email or company: candidates, every X-ray and Apollo prospect on every role (Needs approval / To contact, Emailed, Interested, Skipped, talent pool) and applications in the Inbox. Use it FIRST whenever the person names someone or pastes a LinkedIn link or email. Returns where each match is (which role, which status) with ids to act on, plus close matches when nothing matches exactly.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "A name, LinkedIn URL, email or company" } }, required: ["query"] } },
  { name: "get_prospect", description: "Everything ProNext holds on one prospect (someone found by X-ray or Apollo): the search result it came from, the AI's reading of it (overview, must-have checklist with met / not met / unconfirmed, gaps to check, location and where it came from, own practice, remote), fit and verdict, email and its status, the drafted outreach email, outreach history and status. Use it before judging or contacting a prospect.",
    input_schema: { type: "object", properties: { prospect_id: { type: "string" } }, required: ["prospect_id"] } },
  { name: "get_bench", description: "The bench check for a job (Admins and Rec Ops): when it last ran, how many people already in ProNext matched the role's parallel titles, how many were reviewed and how many are strong fits, and every review saved for this job (candidate, fit, verdict, summary, open questions, when reviewed). Use it to answer 'who do we already have for this role'.",
    input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
  { name: "sourcing_overview", description: "Sourcing across every open role (Admins and Rec Ops): for each role, the last X-ray run (state, when, found), prospects by status (Needs approval / To contact, Emailed, Interested, Skipped), the last bench check (reviewed, strong fits) and candidates on the role. Use it to see where sourcing is working and where it isn't.",
    input_schema: { type: "object", properties: {} } },
  { name: "list_tasks", description: "To-do tasks: yours (default), the ones you gave others, or everyone's (Admins and Rec Ops). Open by default; with due dates, who it's for, who set it, and the candidate or role it's about.",
    input_schema: { type: "object", properties: { scope: { type: "string", enum: ["mine", "assigned_by_me", "everyone"] }, status: { type: "string", enum: ["open", "done", "all"] } } } },
  { name: "get_inbox", description: "The Inbox (Admins and Rec Ops): applications from apply links, referrals and outreach, with source, role, AI score, whether they've said they're interested, who it's assigned to and status (new or handled).",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["new", "handled", "all"] }, job_id: { type: "string" } } } },
  { name: "list_conversations", description: "Your own chats with candidates (each chat is private to you and the candidate): who, which role, unread messages from them, and the last message. Add link_id to read one chat's recent messages.",
    input_schema: { type: "object", properties: { link_id: { type: "string", description: "Read this chat's last 30 messages" } } } },
  { name: "list_placements", description: "Placements and billing: who was placed where, start date, guarantee end, status (Placed / In guarantee / Ready to invoice / Invoiced / Paid / Fallout) and the recruiter's incentive; client fees only for Admins and Rec Ops. Recruiters see their own placements.",
    input_schema: { type: "object", properties: { status: { type: "string" } } } },
  { name: "recent_activity", description: "What happened in the last N hours (default 24) on the person's own work: their assistant updates (replies, interest, stage changes, client views, interviews, tasks, finished searches), new candidates, pipeline moves, candidate messages, interviews, tasks done, and (Admins and Rec Ops) prospects found, emailed and interested per role. Use it for 'what changed / what moved today', briefs and round-ups.",
    input_schema: { type: "object", properties: { hours: { type: "number", description: "1 to 168, default 24" } } } },
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
  propose_prospect: { name: "propose_prospect", description: "Propose an action on a PROSPECT (someone found by X-ray or Apollo for a role; not a candidate yet). Actions: approve_email (approve their drafted outreach email so it's sent; needs an email address), mark_contacted (after the person messages them on LinkedIn; put the LinkedIn message in 'message' so they can copy it first), skip (not right for the role), put_back (a skipped person back to Needs approval). Admins and Rec Ops only. Use real prospect ids from find_person or get_xray.",
    input_schema: { type: "object", properties: { prospect_id: { type: "string" }, action: { type: "string", enum: ["approve_email", "mark_contacted", "skip", "put_back"] },
      name: { type: "string", description: "The prospect's name, for the card" }, role: { type: "string", description: "The role they were found for, for the card" },
      linkedin_url: { type: "string" }, message: { type: "string", description: "A ready-to-send LinkedIn message (for mark_contacted), in the person's own voice and template if they gave one" },
      why: { type: "string", description: "One line on why" } }, required: ["prospect_id", "action"] } },
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
    const { data: ps0 } = await db.from("prospects").select("id,full_name,title,company,location,source,fit,verdict,fit_reason,status,email,linkedin_url,data,archived_at,created_at").eq("job_id", j.id).order("fit", { ascending: false, nullsFirst: false }).limit(400);
    const all = ps0 || [];
    const counts: Record<string, number> = {};
    for (const p of all) { const l = prospectLabel(p); counts[l] = (counts[l] || 0) + 1; }
    const st = String(input?.status || "");
    let ps = all.filter((p: any) => st === "all" ? true : st === "talent_pool" ? !!p.archived_at : !p.archived_at);
    if (st && PROSPECT_GROUPS[st]) ps = ps.filter((p: any) => PROSPECT_GROUPS[st].includes(p.status));
    const words = String(input?.query || "").toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
    if (words.length) ps = ps.filter((p: any) => { const hay = [p.full_name, p.title, p.company, p.linkedin_url, p.location].join(" ").toLowerCase(); return words.every((w) => hay.includes(w)); });
    const full = ps.length <= 40;
    const x = j.xray || {};
    return {
      job: `${j.role_title} at ${j.client}`, job_id: j.id,
      last_run: x.state ? { state: x.state, at: x.at, found: x.found, reviewed: x.reviewed, searches_run: x.searched, by_site: x.bySite, checklist: x.checklist, queries: x.queries, direction: x.guide || null, note: x.note || x.error || null } : "X-ray has not run for this job yet",
      people_by_status: counts, showing: ps.length + " of " + all.length + (st ? " (" + st + ")" : "") + (words.length ? " matching '" + input.query + "'" : ""),
      people: ps.map((p: any) => ({ id: p.id, name: p.full_name, title: clip(p.title, 90), company: p.company, location: full ? p.location : undefined,
        found_by: p.data?.xray ? "X-ray " + (p.data.site || p.source) : p.source, fit: p.fit, verdict: p.verdict, status: prospectLabel(p), has_email: !!p.email, linkedin: p.linkedin_url || p.data?.profile_url || undefined,
        overview: full ? clip(p.data?.overview || p.fit_reason, 300) : undefined, gaps: full ? p.data?.gaps : undefined })),
    };
  }

  if (name === "find_person") {
    const raw = String(input?.query || "").trim().slice(0, 200);
    if (!raw) return { error: "Give a name, LinkedIn link, email or company" };
    const slug = (/linkedin\.com\/in\/([^/?#\s]+)/i.exec(raw) || [])[1] || "";
    const mail = (/[^\s@]+@[^\s@]+\.[^\s@]+/.exec(raw) || [])[0] || "";
    const words = slug || mail ? [] : raw.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 5);
    if (!slug && !mail && !words.length) return { error: "Give a name, LinkedIn link, email or company" };
    const esc = (w: string) => w.replace(/[%_,()]/g, "");
    // Every word must match (exactly the person); if nothing does, any word (close matches).
    const run = async (table: string, cols: string, nameCols: string[], liCol: string | null, mailCol: string | null, extra?: (q: any) => any, loose = false) => {
      let q = db.from(table).select(cols).limit(loose ? 15 : 25);
      if (extra) q = extra(q);
      if (slug) { if (!liCol) return []; q = q.ilike(liCol, "%" + esc(slug) + "%"); }
      else if (mail) { if (!mailCol) return []; q = q.ilike(mailCol, mail.replace(/[%,()]/g, "")); }
      else if (loose) q = q.or(words.flatMap((w) => nameCols.map((c) => `${c}.ilike.%${esc(w)}%`)).join(","));
      else for (const w of words) q = q.or(nameCols.map((c) => `${c}.ilike.%${esc(w)}%`).join(","));
      const { data, error } = await q;
      return error ? [] : data || [];
    };
    const searchAll = async (loose: boolean) => {
      const cands = await run("candidates", "id,name,current_title,current_company,location,status,linkedin_url,recruiter_id,candidate_jobs(job_id,stage,jobs(role_title,client))",
        ["name", "current_company", "current_title"], "linkedin_url", "email", (q) => { q = q.eq("is_draft", false); return me.scoped ? q.eq("recruiter_id", me.id) : q; }, loose);
      const pros = staff ? await run("prospects", "id,full_name,title,company,location,status,fit,verdict,email,linkedin_url,source,data,archived_at,job_id,jobs(role_title,client,status)",
        ["full_name", "company", "title"], "linkedin_url", "email", undefined, loose) : [];
      const apps = staff ? await run("applications", "id,name,email,linkedin,job_id,role_title,status,source,interest_at,created_at,candidate_id",
        ["name"], "linkedin", "email", undefined, loose) : [];
      return { cands, pros, apps };
    };
    let r = await searchAll(false), close = false;
    if (!r.cands.length && !r.pros.length && !r.apps.length && words.length) { r = await searchAll(true); close = true; }
    return {
      searched: ["candidates" + (me.scoped ? " (your own)" : ""), ...(staff ? ["X-ray and Apollo prospects on every role (all statuses, talent pool included)", "Inbox applications"] : [])].join("; ") + " for " + (slug ? "LinkedIn " + slug : mail ? "email " + mail : "'" + raw + "'"),
      match: close ? "No exact match. These are close matches (share at least one word):" : r.cands.length + r.pros.length + r.apps.length ? "Exact matches" : "Nobody found",
      candidates: r.cands.map((c: any) => ({ candidate_id: c.id, name: c.name, title: c.current_title, company: c.current_company, location: c.location, status: c.status, linkedin: c.linkedin_url || undefined,
        roles: (c.candidate_jobs || []).map((l: any) => ({ job_id: l.job_id, role: l.jobs ? l.jobs.role_title + " (" + l.jobs.client + ")" : "", stage: l.stage })), mine: c.recruiter_id === me.id })),
      prospects: r.pros.map((p: any) => ({ prospect_id: p.id, name: p.full_name, title: clip(p.title, 90), company: p.company, location: p.location, job_id: p.job_id,
        role: p.jobs ? p.jobs.role_title + " (" + p.jobs.client + ")" + (p.jobs.status !== "Open" ? " [" + p.jobs.status + "]" : "") : "",
        found_by: p.data?.xray ? "X-ray " + (p.data.site || p.source) : p.source, status: prospectLabel(p), fit: p.fit, verdict: p.verdict, has_email: !!p.email,
        linkedin: p.linkedin_url || undefined, overview: clip(p.data?.overview, 300), gaps: p.data?.gaps })),
      inbox: r.apps.map((a: any) => ({ application_id: a.id, name: a.name, role: a.role_title, job_id: a.job_id, source: a.source, status: a.status, interested: !!a.interest_at, on: day(a.created_at), candidate_id: a.candidate_id || undefined })),
    };
  }

  if (name === "recent_activity") {
    const h = Math.min(168, Math.max(1, Number(input?.hours) || 24));
    const since = new Date(Date.now() - h * 3600e3).toISOString();
    const [{ data: ups }, { data: newc }, { data: moves }, { data: msgs }, { data: ivs }, { data: done }] = await Promise.all([
      db.from("assistant_updates").select("kind,title,created_at").eq("user_id", me.id).gte("created_at", since).order("created_at", { ascending: false }).limit(40),
      (me.scoped ? db.from("candidates").select("name,current_title,created_at").eq("recruiter_id", me.id) : db.from("candidates").select("name,current_title,created_at")).eq("is_draft", false).gte("created_at", since).limit(40),
      db.from("candidate_jobs").select("stage,updated_at,candidates(name,recruiter_id),jobs(role_title,client)").gte("updated_at", since).order("updated_at", { ascending: false }).limit(60),
      db.from("candidate_job_messages").select("created_at,candidate_jobs(candidates(name))").eq("sender", "candidate").eq("staff_id", me.id).gte("created_at", since).limit(60),
      db.from("interviews").select("starts_at,status,decision,round,recruiter_id,candidates(name),jobs(role_title)").gte("starts_at", since).lte("starts_at", new Date(Date.now() + 864e5).toISOString()).limit(30),
      db.from("tasks").select("title,done_at").eq("assigned_to", me.id).gte("done_at", since).limit(30),
    ]);
    const mv = (moves || []).filter((l: any) => !me.scoped || l.candidates?.recruiter_id === me.id);
    const byCand: Record<string, number> = {};
    for (const m of msgs || []) { const n = (m as any).candidate_jobs?.candidates?.name || "a candidate"; byCand[n] = (byCand[n] || 0) + 1; }
    let sourcing: any = undefined;
    if (staff) {
      const { data: pr } = await db.from("prospects").select("status,created_at,contacted_at,updated_at,jobs(role_title)").or(`created_at.gte.${since},contacted_at.gte.${since},updated_at.gte.${since}`).limit(1000);
      const per: Record<string, { found: number; emailed: number; interested: number }> = {};
      for (const p of pr || []) {
        const k = (p as any).jobs?.role_title || "?"; per[k] = per[k] || { found: 0, emailed: 0, interested: 0 };
        if (p.created_at >= since) per[k].found++;
        if (p.contacted_at && p.contacted_at >= since) per[k].emailed++;
        if (["interested", "converted"].includes(p.status) && p.updated_at >= since) per[k].interested++;
      }
      sourcing = per;
    }
    return {
      window: "last " + h + " hours",
      your_updates: (ups || []).map((u: any) => day(u.created_at) + " " + String(u.created_at).slice(11, 16) + " [" + u.kind + "] " + u.title),
      new_candidates: (newc || []).map((c: any) => c.name + (c.current_title ? " (" + c.current_title + ")" : "")),
      pipeline_changes: mv.map((l: any) => (l.candidates?.name || "?") + " → " + l.stage + " on " + (l.jobs ? l.jobs.role_title + " (" + l.jobs.client + ")" : "?")),
      candidate_messages_to_you: byCand,
      interviews: (ivs || []).filter((i: any) => !me.scoped || i.recruiter_id === me.id).map((i: any) => (i.candidates?.name || "?") + ", " + (i.round || "interview") + " for " + (i.jobs?.role_title || "?") + " at " + i.starts_at + " (" + (i.decision || i.status) + ")"),
      tasks_done: (done || []).map((t: any) => t.title),
      sourcing_per_role: sourcing,
    };
  }

  if (name === "get_prospect") {
    if (!staff) return { error: "Only Admins and Rec Ops can see sourced people" };
    const { data: p } = await db.from("prospects").select("*,jobs(role_title,client,status)").eq("id", String(input?.prospect_id || "")).maybeSingle();
    if (!p) return { error: "Prospect not found" };
    const d = p.data || {};
    return {
      prospect_id: p.id, name: p.full_name, title: p.title, company: p.company, location: p.location, country: p.country, linkedin: p.linkedin_url || d.profile_url || undefined,
      role: p.jobs ? p.jobs.role_title + " (" + p.jobs.client + ")" : "", job_id: p.job_id, status: prospectLabel(p), found_by: d.xray ? "X-ray " + (d.site || p.source) : p.source, found_on: day(p.created_at),
      fit: p.fit, verdict: p.verdict, why: d.why || p.fit_reason || undefined, overview: d.overview || undefined,
      checklist: d.checklist || undefined, gaps_to_check: d.gaps || undefined, own_practice: d.own_practice || undefined, remote_worker: d.remote_worker || undefined,
      location_source: d.location_source || undefined, client_history: d.client_history || undefined,
      search_result: d.result_title || d.snippet ? { title: d.result_title, snippet: clip(d.snippet, 700) } : undefined,
      email: p.email ? { address: p.email, status: p.email_status || "unverified" } : "No email found yet", email_lookup: d.email_lookup || undefined,
      drafted_email: p.subject || p.body ? { subject: p.subject, body: clip(p.body, 1500) } : undefined,
      contacted: day(p.contacted_at) || undefined, history: Array.isArray(d.history) ? d.history.slice(-10) : undefined, recheck: d.recheck || undefined,
    };
  }

  if (name === "get_bench") {
    if (!staff) return { error: "Only Admins and Rec Ops can see the bench check" };
    const jobId = String(input?.job_id || "");
    const { data: j } = await db.from("jobs").select("id,role_title,client,sourcing,parallel_titles").eq("id", jobId).maybeSingle();
    if (!j) return { error: "Job not found" };
    const { data: cs } = await db.from("candidates").select("id,name,current_title,location,status,recruiter_id,matches,candidate_jobs(job_id,stage)").eq("is_draft", false).not("matches", "is", null).limit(2000);
    const reviews: any[] = [];
    for (const c of cs || []) for (const m of Array.isArray(c.matches) ? c.matches : []) if (m?.job_id === jobId) reviews.push({ c, m });
    reviews.sort((a, b) => (b.m.fit || 0) - (a.m.fit || 0));
    const b = j.sourcing?.internal;
    return {
      job: `${j.role_title} at ${j.client}`, job_id: j.id, parallel_titles: j.parallel_titles || [],
      how_it_works: "The bench check looks only at people already in ProNext whose own title or parallel titles match this role's parallel titles, who have a CV, aren't Rejected, aren't already on this role and aren't at Interview or Offer on another role. Each run gives a full AI review to the 5 closest who haven't been reviewed for this role in the last 14 days. Strong fits = Perfect / Good fit at 60%+.",
      last_run: b ? { at: b.at, matched_titles: b.considered, reviewed: b.reviewed, strong_fits: b.goodFits, already_on_role_60_plus: b.onRole } : "The bench check has not run for this role",
      reviews: reviews.slice(0, 40).map(({ c, m }) => ({ candidate_id: c.id, name: c.name, title: c.current_title, location: c.location, status: c.status,
        fit: m.fit, verdict: m.verdict, reviewed: day(m.reviewedAt), summary: clip(m.summary, 450),
        open_questions: (Array.isArray(m.questions) ? m.questions : []).filter((q: any) => !q.already_answered && !q.answer).map((q: any) => clip(q.q, 160)).slice(0, 4),
        on_this_role_now: (c.candidate_jobs || []).some((l: any) => l.job_id === jobId) || undefined })),
    };
  }

  if (name === "sourcing_overview") {
    if (!staff) return { error: "Only Admins and Rec Ops can see sourcing" };
    const { data: jobs } = await db.from("jobs").select("id,role_title,client,status,created_at,xray,sourcing").in("status", ["Open", "On hold"]).order("created_at", { ascending: false }).limit(80);
    const ids = (jobs || []).map((j: any) => j.id);
    const { data: ps } = ids.length ? await db.from("prospects").select("job_id,status,email,data,archived_at").in("job_id", ids).limit(5000) : { data: [] };
    const { data: ls } = ids.length ? await db.from("candidate_jobs").select("job_id,stage,candidate_response").in("job_id", ids) : { data: [] };
    return (jobs || []).map((j: any) => {
      const mine = (ps || []).filter((p: any) => p.job_id === j.id);
      const by: Record<string, number> = {};
      for (const p of mine) { const l = prospectLabel(p); by[l] = (by[l] || 0) + 1; }
      const x = j.xray || {}, b = j.sourcing?.internal;
      return { job_id: j.id, role: j.role_title, client: j.client, status: j.status, days_open: Math.round((Date.now() - new Date(j.created_at).getTime()) / 864e5),
        xray: x.state ? { state: x.state, at: day(x.at), found_last_run: x.found } : "never run", prospects: by,
        bench: b ? { at: day(b.at), reviewed: b.reviewed, strong_fits: b.goodFits } : "never run",
        candidates_on_role: (ls || []).filter((l: any) => l.job_id === j.id && l.candidate_response !== "declined" && !["Rejected", "Withdrawn"].includes(l.stage)).length };
    });
  }

  if (name === "list_tasks") {
    const scope = String(input?.scope || "mine"), st = String(input?.status || "open");
    if (scope === "everyone" && !staff) return { error: "Recruiters see their own tasks and the ones they gave" };
    let q = db.from("tasks").select("id,title,notes,assigned_to,created_by,due_on,status,done_at,candidate_id,job_id,candidates(name),jobs(role_title)").order("due_on", { ascending: true, nullsFirst: false }).limit(80);
    if (scope === "mine") q = q.eq("assigned_to", me.id); else if (scope === "assigned_by_me") q = q.eq("created_by", me.id);
    if (st !== "all") q = q.eq("status", st);
    const { data, error } = await q;
    if (error) return { error: error.message };
    const today = new Date().toISOString().slice(0, 10);
    return (data || []).map((t: any) => ({ task_id: t.id, title: t.title, notes: clip(t.notes, 200) || undefined, for: t.assigned_to, set_by: t.created_by, due: t.due_on, overdue: t.status === "open" && t.due_on && t.due_on < today || undefined,
      status: t.status, done: day(t.done_at) || undefined, candidate: t.candidates?.name, role: t.jobs?.role_title }));
  }

  if (name === "get_inbox") {
    if (!staff) return { error: "The Inbox is for Admins and Rec Ops" };
    const st = String(input?.status || "new");
    let q = db.from("applications").select("id,name,email,role_title,job_id,source,ai_score,status,assigned_to,interest_at,referrer,created_at,handled_at,candidate_id").order("created_at", { ascending: false }).limit(80);
    if (st !== "all") q = st === "new" ? q.eq("status", "new") : q.neq("status", "new");
    if (input?.job_id) q = q.eq("job_id", input.job_id);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return (data || []).map((a: any) => ({ application_id: a.id, name: a.name, role: a.role_title, job_id: a.job_id, source: a.source, ai_score: a.ai_score, status: a.status,
      interested: a.source === "outreach" || !!a.interest_at, referred_by: a.referrer || undefined, assigned_to: a.assigned_to || undefined, candidate_id: a.candidate_id || undefined, on: day(a.created_at) }));
  }

  if (name === "list_conversations") {
    if (input?.link_id) {
      const { data, error } = await db.from("candidate_job_messages").select("sender,body,attachment_name,created_at,recruiter_read_at,deleted_at").eq("link_id", String(input.link_id)).eq("staff_id", me.id).order("created_at", { ascending: false }).limit(30);
      if (error) return { error: error.message };
      return (data || []).reverse().map((m: any) => ({ from: m.sender === "candidate" ? "candidate" : "you", at: m.created_at, text: m.deleted_at ? "(deleted)" : clip(m.body, 600) || (m.attachment_name ? "[file: " + m.attachment_name + "]" : ""), unread: m.sender === "candidate" && !m.recruiter_read_at || undefined }));
    }
    const { data, error } = await db.from("candidate_job_messages").select("link_id,sender,body,attachment_name,created_at,recruiter_read_at,deleted_at,candidate_jobs(candidate_id,candidates(name),jobs(role_title,client))").eq("staff_id", me.id).order("created_at", { ascending: false }).limit(500);
    if (error) return { error: error.message };
    const byLink = new Map<string, any>();
    for (const m of data || []) {
      const t = byLink.get(m.link_id) || { link_id: m.link_id, candidate_id: m.candidate_jobs?.candidate_id, candidate: m.candidate_jobs?.candidates?.name, role: m.candidate_jobs?.jobs ? m.candidate_jobs.jobs.role_title + " (" + m.candidate_jobs.jobs.client + ")" : "", unread: 0, last: null };
      if (!t.last) t.last = { from: m.sender === "candidate" ? "candidate" : "you", at: m.created_at, text: m.deleted_at ? "(deleted)" : clip(m.body, 160) || (m.attachment_name ? "[file]" : "") };
      if (m.sender === "candidate" && !m.recruiter_read_at && !m.deleted_at) t.unread++;
      byLink.set(m.link_id, t);
    }
    return [...byLink.values()].slice(0, 40);
  }

  if (name === "list_placements") {
    let q = db.from("placements").select("id,candidate_name,role_desc,recruiter_id,fee,fee_currency,recruiter_incentive,recruiter_incentive_currency,start_date,guarantee_ends,status,created_at,job_id,candidate_id,pay_type,contract_months").order("created_at", { ascending: false }).limit(80);
    if (me.scoped) q = q.eq("recruiter_id", me.id);
    if (input?.status) q = q.eq("status", input.status);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return (data || []).map((p: any) => ({ placement_id: p.id, candidate: p.candidate_name, role: p.role_desc, recruiter_id: p.recruiter_id, start: p.start_date, guarantee_ends: p.guarantee_ends, status: p.status,
      client_fee: staff ? (p.fee ? p.fee + " " + (p.fee_currency || "") : undefined) : undefined,
      recruiter_incentive: staff || p.recruiter_id === me.id ? (p.recruiter_incentive ? p.recruiter_incentive + " " + (p.recruiter_incentive_currency || "") : undefined) : undefined,
      contract: p.pay_type === "monthly" ? "monthly fee, " + (p.contract_months || "?") + " months" : undefined }));
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

// ---------------------------------------------------------------- how ProNext works
// The assistant's map of the app, so it can guide people step by step by the names on screen.
// Keep it in step with app.jsx when menus, buttons or rules change.
const GUIDE = `PRONEXT GUIDE (how the app works; use it to guide people step by step with the exact menu, tab and button names in quotes. If you're not sure a button exists, where it is, or whether this person's role can use it, say so instead of guessing).
Menus. Recruiter: Overview, My candidates, Messages, To-do, Jobs, Interviews, Outreach, Billing. Rec Ops: Overview, Candidates, Inbox, Messages, To-do, Jobs, Interviews, Outreach, Billing, Ads. Admin: the Rec Ops menu plus Users & permissions, Email tracking, Recruiter audit, Agency settings. On a phone the main pages are tabs at the bottom and the rest are under More.
My profile: click your name and photo at the bottom of the left menu (phone: More, then your name). Tabs: Account (name, phone, photo), Notifications (bell activity, message sound and emails, desktop alerts, Assistant updates, End-of-day round-up, Assistant sound), Security (password, two-factor, sessions), Calendar (connect Google Calendar so interviews get a Meet link and sync both ways).
Overview: Recruiters see how their own candidates are doing, "My submissions and placements" and "Your next steps"; Rec Ops and Admins see how the agency is doing and "Needs attention". Both have Export.
Jobs: "All roles" with tabs All, Open, On hold, Closed and "I'm engaged"; "Post a job" (Save as draft or Publish job; sections Location, Salary, description with AI redraft, Client billing, Recruiter incentive, Screening questions; each job gets its own link). On a job: "Engage" puts the role on your worklist. Recruiters can only add or put forward candidates for roles on their worklist ("Engage first"); "Disengage" takes it off with a reason (shown in the "Engagement log"). Also "Add candidate", "Change status" (Open / On hold / Closed), "Copy link", "Promote", "Edit job", "Delete job", "Reopen", and "Close with AI" (the assistant reviews the role and proposes what to do). Sections: Screening questions ("Copy all"), "Candidates who might fit this role" (the bench check: "Open review", "Route"), "Candidates on this role" (stage, CV, fit), and for Admins and Rec Ops the "Sourcing" section (parallel titles, In ProNext = bench, Apollo (paid), People Data Labs (paid; its "Search" button: Admins confirm the cost, others' clicks go to an Admin), X-ray search (free), "People found outside ProNext").
Stages on a role: Sourced, In review, Screening, Submitted, Interview, Offer, Placed, or Rejected / Withdrawn. A candidate accepts or declines a role on their candidate page.
Candidates ("My candidates" for Recruiters): search, Export, "Add candidate" (pick the job first, then the CV, then the screening answers if you have them). A candidate's profile has "Message", "Forward to client", "Mark as placed" / "Mark hired", "Update status", "Edit details", "Review and route", "Delete candidate", the candidate page link ("Their secure link. No login needed."), and tabs Companies (one card per role: Requirements checklist with MUST-HAVE and NICE TO HAVE, Application questions, AI additional screening follow-up questions), Discussion (team notes; type @ to tag a teammate) and Timeline. "Other roles they could fit" lists roles the full AI review rated a fit; Route puts them forward and they accept on their candidate page.
Inbox (Rec Ops and Admins): applications from apply links, referrals and outreach; tabs New and Handled. "Assign to…" a recruiter creates the candidate, copies the CV and puts them on the job; also "Open CV", "Open candidate", "Reassign", "Unassign", "Dismiss", "Restore to New", "Delete".
Messages: your own chats with candidates, one per candidate per role, private to you and them ("New message" to start one). Messages are also emailed to the candidate. In a chat: attach files and pictures (paperclip), emoji (smiley), voice messages (mic when the box is empty), and tap a message to react, copy or delete it. Ticks: clock = sending, two ticks = delivered, lime = read; a red tick means the email bounced or wasn't sent.
To-do: add tasks, filter Mine / Assigned by me / Everyone and by date; reassign or dismiss a task.
Interviews: "Schedule interview"; Week, Month and "Upcoming list" views; Today and "Needs attention". Candidates are emailed and reminded when reminders are on.
Outreach: Admins and Rec Ops run candidate outreach and client leads. Tabs "Candidate outreach" (Needs approval, Sending, Emailed, Interested, Closed, Skipped), "Talent pool" (people found for roles that closed; never emailed; they come back as Needs approval when a new role fits), "Client leads" (New, Contacted, In talks, Won), "Approvals" and "Setup". On a person: "Find email", "Save email", "Email me a test", "Send it myself", "Mark contacted", "Skip this person", "Not interested", "Mark converted", "Put back in pool". Approve sends their drafted email.
X-ray search (Admins and Rec Ops): free Google searches of public profiles (LinkedIn; GitHub and technical sites for technical roles) for one role. The AI reads each search result (title and snippet only, not the full profile) against the role's must-have checklist, and every person's location is then checked in code against the office (anyone clearly more than about an hour away is left out, or moved to Skipped with the reason if an email lookup later shows where they are; on-site roles with no location shown lose 10 points and can't be "Good fit" until someone checks); people kept become prospects with a fit, a verdict and "Gaps to check". People without an email show as "To contact". An Admin can approve Apollo (paid) for verified emails. Emails for X-ray people are looked up automatically every 10 minutes (ContactOut first, then Apollo, then People Data Labs if connected, within daily limits set in Outreach > Setup). People Data Labs can also search its database for a role (paid, about $0.20–0.28 per person returned, Admin approval).
Bench check: reviews people already in ProNext whose titles match the role's parallel titles, who have a CV, aren't Rejected and aren't at Interview or Offer elsewhere; 5 at a time, reusing reviews from the last 14 days. Results show under "Candidates who might fit this role".
Billing: placements, guarantee periods and fees; fees are invoiced once the guarantee clears. Statuses: Placed / Hired, In guarantee, Ready to invoice, Invoiced, Paid, Fallout. "Check-ins due": talk to each placed person before their payout is at risk. Recruiters see their own placements and incentive, never the client fee.
Ads (Rec Ops and Admins): "Promote a job" across job boards and social channels; spend needs approval.
Admin only: Users & permissions ("Invite user"; roles Recruiter, Rec Ops manager, Admin; edit, set password, disable, delete; "Transfer ownership"), Email tracking (Brevo emails to candidates and Apollo outreach: delivered, opened, clicked, replied, problems), Recruiter audit (what each recruiter did and what each hire cost), Agency settings (Agency, Data & privacy: automatic sign-out, exports, data retention; Integrations; Audit log).
The assistant (the ✨ button): Work mode looks things up and proposes actions as cards to Approve or Decline; Brainstorm mode only thinks with you. The list icon opens saved conversations (and morning briefs), the bell opens Updates. Nothing changes until the person approves a card.`;

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
HONEST AND ACCURATE: being right matters more than sounding sure. Base every fact on a lookup in this conversation or on the guide below. If you're unsure, say so plainly ("I'm not sure", "I couldn't confirm that") and say what would confirm it; never fill a gap with a guess. Separate what ProNext shows from your own judgment ("ProNext has… / My read is…"). When a lookup fails or returns nothing, say so. If you made a mistake earlier in the conversation, say so and correct it.
X-RAY AND BENCH: quote fit, verdict, status and dates exactly as the lookups give them. An X-ray review is based only on a search-result title and snippet, so treat what it doesn't show as unconfirmed, not as missing, and say that. A bench review is a full AI review of the CV; say when it was done and if it's older than 14 days or the bench check never ran, say so and offer to run it. Before saying who fits a role, check both get_bench (people already in ProNext) and get_xray (people found outside).
FINDING PEOPLE: when the person names someone, or pastes a LinkedIn link or an email, call find_person straight away. It searches candidates, every X-ray and Apollo prospect on every role (all statuses, talent pool too) and the Inbox. Don't ask which role first and don't make the person look it up for you. Only say someone isn't in ProNext after find_person found nothing, and then say exactly what you searched. To see everyone found for one role, use get_xray (it lists them all; filter with status or query).
BE EXACT: never say you checked, saw, found or did something unless a tool in this conversation actually did it; say "I searched X and found Y". You cannot open LinkedIn profiles (LinkedIn blocks it): never describe a LinkedIn profile you haven't been given. Use what ProNext holds about the person, or ask.
PROSPECTS are people found by X-ray or Apollo for a role; they are not candidates yet, and their ids are prospect ids. propose_route, propose_message, propose_stage, propose_note and propose_interview only work for candidates. For a prospect use propose_prospect (approve their outreach email, mark them contacted after a LinkedIn message, skip, put back); write a LinkedIn message in its message field so the person can copy it.
For "what changed / what moved today", briefs and round-ups, use recent_activity (and list_jobs / list_interviews) instead of guessing.
After your lookups and proposals, write your whole answer in your final message: what you found, then what you propose. Don't leave the answer in an earlier message.
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
  const help = `
HELPING PEOPLE USE PRONEXT: when someone asks how to do something, answer for their role (${role}) with numbered steps using the exact names in the guide, and say when something is only for Admins or Rec Ops and who to ask instead. Explain what each page shows from their point of view (a Recruiter only sees their own candidates; Rec Ops and Admins see everyone). If the guide doesn't cover it, say you're not sure rather than invent a button.
${GUIDE}`;
  return common + (mode === "brainstorm" ? brainstorm : work) + help + where +
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
  // The stronger model for conversations (it has to search, reason and stay exact); the fast one
  // only for very short follow-ups like "ok" / "yes" with nothing to look up.
  const model = o.forceModel || (o.smart || mode === "brainstorm" || last.length > 12 || o.messages.length < 2 ? SMART : FAST);
  let useFetch = true;
  const tools = () => [...READ_TOOLS, ...(useFetch ? WEB_TOOLS : WEB_TOOLS.slice(0, 1)), ...allowed.map((n) => PROPOSE[n])];
  const system = [{ type: "text", text: systemPrompt(me, mode, today, tz, page || {}, jobs || [], users || []), cache_control: { type: "ephemeral" } }];
  const convo: any[] = [...o.messages];
  const proposals: any[] = [];
  let text = "", inTok = 0, outTok = 0, searches = 0, steps = 0, error = "", status = 200;
  const texts: string[] = [];
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
    if (said) { said.length > 160 && texts.push(said); text = said; } // the last thing it says is the answer; earlier "let me check…" lines are dropped
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
  // A short closing line ("Done, three reminders proposed") after a real answer earlier in the turn:
  // keep the answer too.
  const earlier = texts.filter((t) => t !== text).pop();
  if (text && text.length < 160 && earlier) text = earlier + "\n\n" + text;
  return { error, status, model, proposals, text: text || (proposals.length ? "Here's what I'd do. Approve to go ahead." : "I couldn't find an answer to that.") };
}

const BRIEF_ASK = "Give me my morning brief. In a few short lines: what changed since yesterday, which roles are closest to a hire and what's blocking each, and the 3 most important things to do today to get a hire. Propose the actions for those 3 things (emails, messages, interviews, reminders) so I can approve them. If nothing needs doing, say so in one line.";

const ROUNDUP_ASK = "Give me my end-of-day round-up. In a few short lines: what moved today on my candidates and roles (new candidates, stage changes, replies, interviews, client feedback, placements), what's still waiting on someone and who, and the 3 things to pick up first tomorrow. Propose reminders (propose_task, due tomorrow) for those 3 things so I can approve them. If nothing happened today, say so in one line.";

// Weekday mornings (brief) and evenings (round-up): the next few active people without today's one
// get it, saved as a conversation (kind 'brief' / 'roundup'). The round-up also lands in the
// person's assistant updates (badge, sound, and an email if they don't open ProNext), and is
// skipped for anyone who turned it off (assistRoundup) or turned assistant updates off.
async function briefNext(admin: any, key: string, max: number, kind: "brief" | "roundup" = "brief") {
  const tz = "Africa/Lagos";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const startUtc = new Date(Date.now() - (kind === "brief" ? 20 : 12) * 3600e3).toISOString();
  const ask = kind === "brief" ? BRIEF_ASK : ROUNDUP_ASK;
  const { data: people } = await admin.from("profiles").select("id,full_name,role,status,notification_prefs").eq("status", "Active").in("role", ["admin", "recops", "recruiter"]);
  const { data: done } = await admin.from("assistant_threads").select("user_id").eq("kind", kind).gte("created_at", startUtc);
  const have = new Set((done || []).map((d: any) => d.user_id));
  const wants = (p: any) => kind === "brief" || ((p.notification_prefs || {}).assistRoundup !== false && (p.notification_prefs || {}).assistUpdates !== false);
  const todo = (people || []).filter((p: any) => !have.has(p.id) && wants(p));
  const out: any[] = [];
  for (const p of todo.slice(0, max)) {
    const me = { id: p.id, full_name: p.full_name, role: p.role, status: p.status, scoped: p.role === "recruiter" };
    const r = await runAgent({ admin, db: admin, me, key, mode: "work", messages: [{ role: "user", content: ask }], page: {}, tz, forceModel: SMART });
    if (r.error) { out.push({ id: p.id, error: r.error }); if (r.status === 402) break; continue; }
    const label = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(new Date());
    const { data: th } = await admin.from("assistant_threads").insert({ user_id: p.id, kind, mode: "work", title: (kind === "brief" ? "Morning brief · " : "End-of-day round-up · ") + label,
      messages: [{ role: "user", content: ask }, { role: "assistant", content: r.text, proposals: r.proposals.map((x: any) => ({ ...x, state: x.tool === "propose_email" ? "draft" : "waiting" })) }] }).select("id").single();
    if (kind === "roundup" && th?.id) {
      const { error: uErr } = await admin.rpc("push_update", { p_user: p.id, p_kind: "roundup", p_title: "Your end-of-day round-up · " + label,
        p_body: String(r.text || "").slice(0, 1800) + (r.proposals.length ? "\n\n" + r.proposals.length + " reminder" + (r.proposals.length === 1 ? "" : "s") + " waiting for your approval in ProNext." : ""),
        p_link: { threadId: th.id }, p_dedupe: "roundup:" + today, p_covered: false, p_actor: null });
      if (uErr) console.error("roundup update", uErr.message);
    }
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
      if (body.action === "roundup_next") return json(await briefNext(admin, key, Math.min(Number(body.max) || 2, 4), "roundup"));
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
