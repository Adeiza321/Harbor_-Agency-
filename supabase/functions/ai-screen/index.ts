import { createClient } from "npm:@supabase/supabase-js@2";
import { prepareResume, findLinkedIn, type ResumeInput } from "./resume.ts";
import { screenLink, reviewMatch, benchFits, jobParallelTitles, parallelTitles, draftFollowups, dedupeQuestions, answersOn, cleanTitles, PARALLEL_RULE, RUBRIC, REQS_SHAPE, LOCKED_MSG, enforceChecklist } from "./screening.ts";
import { lookupIndustries, industryText } from "./industry.ts";
import { PROFILE_SHAPE, PROFILE_RULES, cleanProfile } from "./profile.ts";

// AI screening for Pronext: CV scoring, screening-question drafting and the fit verdict.
//
// Provider: Claude ONLY (ANTHROPIC_API_KEY; model from ANTHROPIC_MODEL, default the
// low-cost claude-haiku-4-5) — deliberately no Gemini fallback here. Two different models
// judging the same rubric can land on different verdicts for the same candidate, which reads
// as "the ranking keeps changing"; one model keeps every rescreen comparable. Temperature is
// pinned to 0 for the same reason: this is a rubric checklist, not creative writing, so the
// answer should be as repeatable as the inputs allow. The checklist guard (enforceChecklist)
// still applies on top.
//
// Resumes: PDF, Word (.docx/.doc), OpenDocument, RTF, text and images are all read
// (see resume.ts). Screening material: every judgement uses BOTH the resume and their
// screening answers — the job's own screening questions (candidate_jobs.screening_answers)
// and the AI-drafted questions plus the candidate's reply (candidates.screening).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";
const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  throw new Error("AI returned something unexpected: " + text.slice(0, 300));
}

// A resume that arrived as text goes into the prompt; PDFs and images go in as files.
const withResumeText = (text: string, resume: ResumeInput | null) =>
  resume?.kind === "text" ? `Candidate's resume (text extracted from their file):\n"""\n${resume.text}\n"""\n\n${text}` : text;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Models to try in order. When one is overloaded (503) or rate-limited (429), Pronext
// waits briefly, retries, then moves to the next model instead of failing.
const GEMINI_FALLBACKS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"];

async function askGemini(key: string, system: string, text: string, resume: ResumeInput | null, maxTokens: number) {
  const models = [...new Set([Deno.env.get("GEMINI_MODEL") || GEMINI_DEFAULT_MODEL, ...GEMINI_FALLBACKS])];
  const parts: unknown[] = [];
  if (resume?.kind === "pdf") parts.push({ inline_data: { mime_type: "application/pdf", data: resume.data } });
  if (resume?.kind === "image") parts.push({ inline_data: { mime_type: resume.mime, data: resume.data } });
  parts.push({ text: withResumeText(text, resume) });
  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    // Gemini counts its internal reasoning against this limit, so leave generous room.
    generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: Math.max(maxTokens * 4, 4096) },
  });
  let lastErr = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: payload,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const cand = data.candidates?.[0];
        const out = (cand?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
        if (out) return parseJson(out);
        lastErr = "AI returned no answer (" + (cand?.finishReason || data.promptFeedback?.blockReason || "unknown reason") + ")";
        break; // try the next model
      }
      lastErr = "AI request failed (" + res.status + "): " + String(data?.error?.message || res.statusText).slice(0, 300);
      console.error("gemini", model, res.status, String(data?.error?.message || "").slice(0, 200));
      if (res.status === 404) break;                                  // model not available: next model
      if (res.status === 429 && /quota/i.test(String(data?.error?.message || "")))  // quota is per account: other models won't help
        throw new Error("Gemini's free quota is used up (turn on billing for the key in Google AI Studio)");
      if (![429, 500, 503].includes(res.status)) throw new Error(lastErr); // bad key, bad request: stop
      await sleep(attempt === 0 ? 1500 : 3000);                        // busy: wait, retry, then next model
    }
  }
  throw new Error(lastErr.includes("(503)") || lastErr.includes("(429)")
    ? "Google's AI is very busy right now. Please try again in a minute."
    : lastErr || "AI request failed. Try again.");
}

async function askAnthropic(key: string, system: string, text: string, resume: ResumeInput | null, maxTokens: number) {
  const content: unknown[] = [];
  if (resume?.kind === "pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: resume.data } });
  if (resume?.kind === "image") {
    if (!["image/jpeg", "image/png", "image/webp"].includes(resume.mime)) throw new Error("This AI setup can't read HEIC photos. Upload the resume as JPG, PNG or PDF.");
    content.push({ type: "image", source: { type: "base64", media_type: resume.mime, data: resume.data } });
  }
  content.push({ type: "text", text: withResumeText(text, resume) });
  // Generous output room: a full requirement checklist is long, and a cut-off reply can't be read.
  const payload = JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: Math.max(maxTokens * 3, 8000), temperature: 0, system, messages: [{ role: "user", content }] });
  let res: Response | null = null;
  // When Claude is busy (429 rate limit, 529 overloaded, 5xx) wait briefly and retry twice.
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: payload,
    });
    if (res.ok || ![429, 500, 502, 503, 529].includes(res.status)) break;
    console.error("claude busy", res.status);
    await sleep(attempt === 0 ? 2000 : 5000);
  }
  if (!res!.ok) {
    const body = (await res!.text()).slice(0, 300);
    if ([429, 529].includes(res!.status)) throw new Error("Claude is very busy right now. Please try again in a minute.");
    if (/credit balance/i.test(body)) throw new Error("The Claude account is out of credit. Top up at console.anthropic.com, then try again.");
    throw new Error("AI request failed (" + res!.status + "): " + body);
  }
  const data = await res!.json();
  if (data.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off before it finished");
  return parseJson((data.content || []).map((b: any) => b.text || "").join(""));
}

async function askAI(system: string, text: string, resume: ResumeInput | null = null, maxTokens = 800) {
  const anthropic = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropic) throw new Error("AI is not configured yet: add an ANTHROPIC_API_KEY secret to this Supabase project.");
  // Claude only — see the note above. askAnthropic already retries on 429/5xx, so a
  // transient failure is handled without switching models.
  return await askAnthropic(anthropic, system, text, resume, maxTokens);
}

// The resume on file, ready for the AI (any supported format), or a reason it can't be read.
async function loadResume(admin: any, candidate: any): Promise<{ resume: ResumeInput | null; why?: string; linkedin?: string }> {
  const path = candidate.resume_path || candidate.cv_path;
  if (!path) return { resume: null, why: "No resume on file for this candidate. Upload one to score them." };
  const bucket = candidate.resume_path ? "resumes" : "cvs";
  const { data: file, error } = await admin.storage.from(bucket).download(path);
  if (error || !file) return { resume: null, why: "Could not read the stored resume. Try re-uploading it." };
  const bytes = new Uint8Array(await file.arrayBuffer()), fname = (candidate.resume_path && candidate.resume_name) || path;
  const r = await prepareResume(bytes, fname);
  const linkedin = await findLinkedIn(bytes, fname);
  return r.input ? { resume: r.input, linkedin } : { resume: null, why: r.why, linkedin };
}

// Everything the candidate has answered for this job, as readable Q&A lines.
// includeAiReply=false leaves out a stored reply (used when a fresh reply is being reviewed).
async function screeningMaterial(admin: any, candidate: any, job: any, includeAiReply = true) {
  const lines: string[] = [];
  let linkId: string | null = null;
  if (job) {
    const { data: link } = await admin.from("candidate_jobs").select("id,screening_answers")
      .eq("candidate_id", candidate.id).eq("job_id", job.id).maybeSingle();
    if (link) {
      linkId = link.id;
      const qs: string[] = Array.isArray(job.screening_questions) ? job.screening_questions : [];
      const answers: any[] = Array.isArray(link.screening_answers) ? link.screening_answers : [];
      answers.forEach((a, i) => {
        const q = typeof a === "object" && a ? a.q : qs[i];
        const ans = typeof a === "object" && a ? a.a : a;
        if (q && ans && String(ans).trim()) lines.push(`Q: ${q}\nA: ${String(ans).trim()}`);
      });
    }
  }
  const s = candidate.screening || {};
  const sameJob = !job || !s.jobId || s.jobId === job.id;
  if (sameJob && includeAiReply && Array.isArray(s.qa) && s.qa.length) {
    const asked = (s.questions || []).map((q: string, i: number) => `${i + 1}. ${q}`).join("\n");
    const replies = s.qa.map((x: any) => String(x?.a || "").trim()).filter(Boolean).join("\n");
    if (replies) lines.push(`AI screening questions sent:\n${asked || "(not recorded)"}\nCandidate's reply:\n${replies}`);
  }
  return { text: lines.join("\n\n"), count: lines.length, linkId };
}

const jobBlock = (job: any) =>
  `Job: ${job.role_title} at ${job.client}.\nDescription:\n${job.description || "(no description given)"}\n` +
  `Salary range: ${job.min_pay || "?"} - ${job.max_pay || "?"} ${job.currency || "NGN"}/year.` +
  (job.location ? `\nLocation: ${job.location}` : "") + (job.country ? `\nHiring country: ${job.country}` : "") +
  (job.work_setup ? `\nWork setup: ${job.work_setup}` : "") + (job.employment_type ? `\nEmployment type: ${job.employment_type}` : "");

const clampScore = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

// Re-read profile facts (current title/employer, experience, location, phone, notice, pay,
// skills) from the resume and everything the candidate has answered. Replaces those fields.
// Allowed on locked candidates, except skills, which are part of the locked review.
async function readProfile(admin: any, candidate: any) {
  const { resume, why, linkedin: fileLinkedIn } = await loadResume(admin, candidate);
  if (!resume) return { error: why || "No resume on file" };
  const { data: links } = await admin.from("candidate_jobs").select("*").eq("candidate_id", candidate.id);
  const { data: ljobs } = (links || []).length ? await admin.from("jobs").select("*").in("id", [...new Set((links || []).map((l: any) => l.job_id))]) : { data: [] };
  const answers = (links || []).flatMap((l: any) => answersOn(l, (ljobs || []).find((j: any) => j.id === l.job_id)));
  const system = "You read a candidate's resume for a recruitment agency and record their profile facts. Reply with STRICT JSON only: " +
    `{${PROFILE_SHAPE}}. ` + PROFILE_RULES + "For 'notice' and 'pay', the candidate's own answers win over the CV.";
  const text = "The candidate's CV is included.\n\nTheir answers to screening questions (their own words):\n" +
    (answers.length ? answers.map((x: any) => `Q: ${x.q}\nA: ${x.a}`).join("\n\n") : "(none yet)");
  const prof = cleanProfile(await askAI(system, text, resume, 1500));
  const patch: Record<string, unknown> = {
    current_title: prof.current_title || null, current_company: prof.current_company || null,
    experience: prof.experience || "-", location: prof.location || null, notice: prof.notice || null, pay: prof.pay || null,
    profile_read_at: new Date().toISOString(),
  };
  if (prof.phone) patch.phone = prof.phone;
  const li = prof.linkedin || fileLinkedIn || "";
  if (li) patch.linkedin_url = li;
  const skillsLocked = !!candidate.ai_locked;
  if (!skillsLocked && prof.skills.length) patch.skills = prof.skills;
  const { error } = await admin.from("candidates").update(patch).eq("id", candidate.id);
  if (error) throw new Error(error.message);
  return { profile: prof, skillsLocked };
}

async function refreshCandidate(admin: any, candidate: any, step: string, force = false) {
  if (step === "profile") {
    const r = await readProfile(admin, candidate);
    return "error" in r ? { ok: false, step, error: r.error } : { ok: true, step, skillsLocked: r.skillsLocked };
  }
  if (step === "industries") {
    if (!force && Array.isArray(candidate.industries) && candidate.industries.length) return { ok: true, step, skipped: "already looked up" };
    const { resume, why } = await loadResume(admin, candidate);
    if (!resume) return { ok: false, step, error: why };
    const { items, error } = await lookupIndustries(resume);
    if (!items.length) return { ok: false, step, error: "Couldn't look up the companies: " + (error || "no employers found") };
    await admin.from("candidates").update({ industries: items, industries_checked_at: new Date().toISOString() }).eq("id", candidate.id);
    return { ok: true, step, industries: items.length };
  }
  if (step === "titles") return { ok: true, step, titles: await parallelTitles(admin, candidate.id, askAI, loadResume) };
  if (step === "screen") {
    if (candidate.ai_locked) return { ok: true, step, skipped: "locked (manually reviewed)" };
    const { data: cards } = await admin.from("candidate_jobs").select("id").eq("candidate_id", candidate.id).eq("candidate_response", "accepted").limit(5);
    let rescreened = 0; const errors: string[] = [];
    for (const c of cards || []) { try { await screenLink(admin, c.id, askAI, loadResume); rescreened++; } catch (e) { errors.push(String((e as Error)?.message || e).slice(0, 160)); } }
    return { ok: !errors.length, step, rescreened, errors };
  }
  return { ok: false, step, error: "Unknown step" };
}

// Screens one card on its own (no one has to press "Screen now"), then drafts follow-up questions
// if the screening didn't already. Each attempt is stamped on ai.auto so the database call and
// the sweep never screen the same card twice at once, and a failing card is retried at most 3 times.
async function autoScreen(admin: any, linkId: string) {
  const { data: link } = await admin.from("candidate_jobs").select("id,ai,candidate_response,candidate_id").eq("id", linkId).maybeSingle();
  if (!link) return { ok: false, skipped: "not found" };
  if ((link.candidate_response || "accepted") !== "accepted") return { ok: true, skipped: "not accepted yet" };
  if (link.ai?.stage) return { ok: true, skipped: "already screened" };
  const auto = link.ai?.auto || {};
  if (auto.at && Date.now() - new Date(auto.at).getTime() < 3 * 60e3) return { ok: true, skipped: "already running" };
  const { data: cand } = await admin.from("candidates").select("ai_locked,is_draft").eq("id", link.candidate_id).maybeSingle();
  if (!cand || cand.ai_locked || cand.is_draft) return { ok: true, skipped: "locked or draft" };
  const stamp = { tries: (auto.tries || 0) + 1, at: new Date().toISOString() };
  await admin.from("candidate_jobs").update({ ai: { ...(link.ai || {}), auto: stamp } }).eq("id", linkId);
  try {
    const ai: any = await screenLink(admin, linkId, askAI, loadResume);
    if (!ai?.followups && ai?.verdict !== "Reject") { try { await draftFollowups(admin, linkId, askAI); } catch (_) { /* nothing open to ask about */ } }
    return { ok: true, screened: true };
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 200);
    console.error("auto screen", linkId, msg);
    const { data: cur } = await admin.from("candidate_jobs").select("ai").eq("id", linkId).maybeSingle();
    if (!cur?.ai?.stage) await admin.from("candidate_jobs").update({ ai: { ...(cur?.ai || {}), auto: { ...stamp, error: msg } } }).eq("id", linkId);
    return { ok: false, error: msg };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json();

    // ---------------------------------------------------------------
    // Candidate page actions. No staff login: the candidate's secret portal token
    // proves who they are, and they can only act on their own job cards.
    // ---------------------------------------------------------------
    if (body.action === "portal_respond" || body.action === "portal_answer") {
      const portalToken = String(body.token || "");
      if (portalToken.length < 16) return json({ error: "Invalid link" }, 403);
      const { data: cand } = await admin.from("candidates").select("id,name").eq("portal_token", portalToken).maybeSingle();
      if (!cand) return json({ error: "Invalid link" }, 403);
      const { data: link } = await admin.from("candidate_jobs").select("*").eq("id", body.linkId).eq("candidate_id", cand.id).maybeSingle();
      if (!link) return json({ error: "This role is no longer available" }, 404);
      const { data: pj } = await admin.from("jobs").select("role_title,client").eq("id", link.job_id).maybeSingle();
      const roleName = pj ? pj.role_title + ", " + pj.client : "a role";

      if (body.action === "portal_respond") {
        if (link.candidate_response !== "pending") return json({ ok: true, already: true });
        const accept = body.accept === true;
        await admin.from("candidate_jobs").update({
          candidate_response: accept ? "accepted" : "declined",
          responded_at: new Date().toISOString(),
          ...(accept ? { stage: "In review" } : { stage: "Withdrawn" }),
        }).eq("id", link.id);
        await admin.from("candidate_timeline").insert({ candidate_id: cand.id, title: (accept ? "Accepted " : "Declined ") + roleName + " on their candidate page", done: true });
        if (accept) { try { const sc: any = await screenLink(admin, link.id, askAI, loadResume); if (!sc?.followups && sc?.verdict !== "Reject") await draftFollowups(admin, link.id, askAI).catch(() => {}); } catch (e) { console.error("screen after accept", String((e as Error)?.message || e)); } }
        return json({ ok: true });
      }

      // portal_answer
      const f = link.ai?.followups;
      if (!f || f.state !== "sent") return json({ error: "These questions have already been answered" }, 409);
      const answers: unknown[] = Array.isArray(body.answers) ? body.answers : [];
      const questions = (f.questions || []).map((x: any, i: number) => ({ q: x.q, a: String(answers[i] ?? "").trim().slice(0, 4000) }));
      if (questions.some((x: any) => !x.a)) return json({ error: "Please answer every question" }, 400);
      const ai = { ...(link.ai || {}), followups: { ...f, state: "answered", questions, answeredAt: new Date().toISOString() } };
      await admin.from("candidate_jobs").update({ ai }).eq("id", link.id);
      await admin.from("candidate_timeline").insert({ candidate_id: cand.id, title: "Answered screening questions for " + roleName, done: true });
      try { await screenLink(admin, link.id, askAI, loadResume); } catch (e) { console.error("screen after answers", String((e as Error)?.message || e)); }
      return json({ ok: true });
    }

    // Maintenance runs (e.g. refreshing every candidate after a screening change) carry a
    // short-lived token from public.ops_tokens instead of a staff login. Refresh only.
    const opsKey = req.headers.get("x-harbor-ops") || "";
    if (opsKey) {
      const { data: tok } = await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!tok || opsKey.length < 32) return json({ error: "Invalid ops token" }, 403);
      // The sourcing function's scheduled runs check the bench for newly live jobs.
      if (body.action === "bench_fits" && body.jobId) return json({ ok: true, ...(await benchFits(admin, body.jobId, askAI, loadResume)) });
      // Automatic screening: called by the database the moment a candidate is added to a role,
      // and by a sweep every 2 minutes for anything that slipped through (a few per run).
      if (body.action === "screen_link" && body.linkId) return json(await autoScreen(admin, String(body.linkId)));
      if (body.action === "screen_pending") {
        const since = new Date(Date.now() - 3 * 864e5).toISOString(), settled = new Date(Date.now() - 90e3).toISOString();
        const { data: rows } = await admin.from("candidate_jobs").select("id,ai,candidate_response,candidates!inner(ai_locked,is_draft)")
          .gt("created_at", since).lt("created_at", settled).eq("candidates.ai_locked", false).eq("candidates.is_draft", false)
          .order("created_at").limit(40);
        const due = (rows || []).filter((r: any) => (r.candidate_response || "accepted") === "accepted" && !r.ai?.stage
          && (r.ai?.auto?.tries || 0) < 3 && Date.now() - new Date(r.ai?.auto?.at || 0).getTime() > 10 * 60e3).slice(0, 3);
        const out = [];
        for (const r of due) out.push({ id: r.id, ...(await autoScreen(admin, r.id)) });
        return json({ ok: true, screened: out });
      }
      if (body.action !== "refresh_candidate") return json({ error: "Only refresh_candidate, bench_fits or screening run with an ops token" }, 400);
      const { data: cand } = await admin.from("candidates").select("*").eq("id", body.candidateId).maybeSingle();
      if (!cand) return json({ error: "Candidate not found" }, 404);
      const r = await refreshCandidate(admin, cand, String(body.step || ""), !!body.force);
      if (!r.ok) console.error("ops refresh", cand.id, JSON.stringify(r));
      return json(r);
    }

    // ---------------------------------------------------------------
    // Everything below needs a signed-in, active Pronext user.
    // ---------------------------------------------------------------
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);

    const { data: me } = await admin.from("profiles").select("id,role,status,full_name").eq("id", caller.user.id).single();
    if (!me || me.status !== "Active") return json({ error: "Your account is not active" }, 403);
    const isStaff = me.role === "admin" || me.role === "recops";
    const { action } = body;

    // Card-level actions take a linkId (one candidate on one job).
    if (action === "screen" || action === "approve_questions" || action === "draft_followups" || action === "save_followups") {
      const { data: link } = await admin.from("candidate_jobs").select("*").eq("id", body.linkId).maybeSingle();
      if (!link) return json({ error: "Screening card not found" }, 404);
      const { data: owner } = await admin.from("candidates").select("recruiter_id,ai_locked").eq("id", link.candidate_id).single();
      if (!isStaff && owner?.recruiter_id !== me.id) return json({ error: "Not your candidate" }, 403);
      if (action === "screen" && owner?.ai_locked) return json({ error: LOCKED_MSG, locked: true }, 409);
      if (link.candidate_response !== "accepted") return json({ error: "The candidate hasn't accepted this role yet" }, 409);

      if (action === "screen") return json({ ok: true, ai: await screenLink(admin, link.id, askAI, loadResume) });
      // Draft follow-up questions from the card's review (allowed on locked cards).
      if (action === "draft_followups") {
        const f0 = link.ai?.followups;
        if (f0 && f0.state !== "draft") return json({ error: "Questions were already sent to this candidate" }, 409);
        return json({ ok: true, ai: await draftFollowups(admin, link.id, askAI) });
      }

      // Recruiter edits the follow-up questions by hand: removes ones that aren't needed (never
      // suggested again) and types in answers the candidate gave on a call or message. Once every
      // question has an answer the card is rescreened with them (unless the review is locked).
      if (action === "save_followups") {
        const f0 = link.ai?.followups || null;
        if (f0 && f0.state === "answered" && !f0.enteredBy) return json({ error: "The candidate already answered these on their candidate page" }, 409);
        const items = (Array.isArray(body.questions) ? body.questions : [])
          .map((x: any) => ({ q: String(x?.q || "").trim().slice(0, 300), a: String(x?.a || "").trim().slice(0, 4000) }))
          .filter((x: any) => x.q).slice(0, 8);
        const nq = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const kept = new Set(items.map((x: any) => nq(x.q)));
        const before = (f0?.questions || []).map((x: any) => String(x?.q || "")).filter(Boolean);
        const removed = before.filter((q: string) => !kept.has(nq(q)));
        const added = items.some((x: any) => !before.some((q: string) => nq(q) === nq(x.q)));
        const dismissed = [...new Set([...(Array.isArray(link.ai?.dismissedQuestions) ? link.ai.dismissedQuestions : []), ...removed])].slice(-40);
        const now = new Date().toISOString();
        const allAnswered = items.length > 0 && items.every((x: any) => x.a);
        const anyAnswer = items.some((x: any) => x.a);
        const ai: Record<string, unknown> = { ...(link.ai || {}), dismissedQuestions: dismissed };
        if (!items.length) delete ai.followups;
        else {
          const fu: Record<string, unknown> = { ...(f0 || {}), questions: items };
          if (added) fu.manual = true;
          fu.state = allAnswered ? "answered" : f0 && f0.state !== "answered" ? f0.state : (f0?.approvedBy ? "sent" : "draft");
          if (anyAnswer) { fu.enteredBy = me.full_name || "Recruiter"; fu.enteredAt = now; }
          if (allAnswered) fu.answeredAt = now; else delete fu.answeredAt;
          ai.followups = fu;
        }
        const { error: upErr } = await admin.from("candidate_jobs").update({ ai }).eq("id", link.id);
        if (upErr) return json({ error: upErr.message }, 500);
        if (anyAnswer) await admin.from("candidate_timeline").insert({ candidate_id: link.candidate_id, title: "Screening answers entered by " + (me.full_name || "a recruiter"), done: true });
        if (allAnswered && body.rescreen !== false) {
          if (owner?.ai_locked) return json({ ok: true, ai, rescreened: false, locked: true });
          return json({ ok: true, ai: await screenLink(admin, link.id, askAI, loadResume), rescreened: true });
        }
        return json({ ok: true, ai, rescreened: false, removed: removed.length });
      }

      // approve_questions: only Rec Ops and Admins can send follow-up questions to a candidate.
      if (!isStaff) return json({ error: "Only Rec Ops or Admins can approve screening questions" }, 403);
      const f = link.ai?.followups;
      if (f && f.state !== "draft") return json({ error: "These questions were already sent" }, 409);
      const qs = (Array.isArray(body.questions) ? body.questions : []).map((q: unknown) => String(q || "").trim()).filter(Boolean).slice(0, 6);
      if (!qs.length) return json({ error: "Add at least one question" }, 400);
      // Drafted questions left out when approving count as removed: never suggested again.
      const nq = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const dropped = (f?.questions || []).map((x: any) => String(x?.q || "")).filter((q: string) => q && !qs.some((k: string) => nq(k) === nq(q)));
      const dismissedQuestions = [...new Set([...(Array.isArray(link.ai?.dismissedQuestions) ? link.ai.dismissedQuestions : []), ...dropped])].slice(-40);
      const ai = { ...(link.ai || {}), dismissedQuestions, followups: { state: "sent", questions: qs.map((q: string) => ({ q })), approvedBy: me.full_name || "Rec Ops", approvedAt: new Date().toISOString() } };
      await admin.from("candidate_jobs").update({ ai }).eq("id", link.id);
      await admin.from("candidate_timeline").insert({ candidate_id: link.candidate_id, title: "Screening questions sent by " + (me.full_name || "Rec Ops"), done: true });
      return json({ ok: true, ai });
    }

    // Regenerate a job's parallel titles (other titles the same role is advertised under).
    if (action === "job_titles") {
      if (!isStaff) return json({ error: "Only Rec Ops or Admins can change a job's titles" }, 403);
      const { data: j } = await admin.from("jobs").select("*").eq("id", body.jobId).maybeSingle();
      if (!j) return json({ error: "Job not found" }, 404);
      return json({ ok: true, titles: await jobParallelTitles(admin, j, askAI, true) });
    }

    // Bench check (Rec Ops/Admin): review the closest non-busy people in Pronext against a job.
    if (action === "bench_fits") {
      if (!isStaff) return json({ error: "Only Rec Ops or Admins can check the bench" }, 403);
      if (!body.jobId) return json({ error: "jobId is required" }, 400);
      return json({ ok: true, ...(await benchFits(admin, body.jobId, askAI, loadResume)) });
    }

    // Review a candidate against a role they're not on yet, and route them to it with
    // questions attached. Routing keeps the normal flow: the candidate accepts on their page,
    // then the card appears under Companies. Rec Ops/Admin questions go out as sent;
    // a recruiter's wait for approval like any other follow-up.
    if (action === "review_match" || action === "route_with_questions") {
      const { data: cand } = await admin.from("candidates").select("id,recruiter_id").eq("id", body.candidateId).maybeSingle();
      if (!cand) return json({ error: "Candidate not found" }, 404);
      if (!isStaff && cand.recruiter_id !== me.id) return json({ error: "Not your candidate" }, 403);
      if (!body.jobId) return json({ error: "jobId is required" }, 400);
      if (action === "review_match") return json({ ok: true, ...(await reviewMatch(admin, cand.id, body.jobId, askAI, loadResume)) });

      const { data: existing } = await admin.from("candidate_jobs").select("id").eq("candidate_id", cand.id).eq("job_id", body.jobId).maybeSingle();
      if (existing) return json({ error: "They're already on this job" }, 409);
      const qs = (Array.isArray(body.questions) ? body.questions : []).map((q: unknown) => String(q || "").trim()).filter(Boolean).slice(0, 8);
      const r = body.review && typeof body.review === "object" ? body.review : null;
      const ai: Record<string, unknown> = r ? {
        stage: "first", summary: String(r.summary || "").slice(0, 1200), score: r.fit ?? null, verdict: r.verdict || "", verdict_reason: String(r.verdict_reason || "").slice(0, 400),
        requirements: Array.isArray(r.requirements) ? r.requirements.slice(0, 25) : [], strengths: [], gaps: [], usedResume: !!r.usedResume, answersUsed: r.answersUsed || 0, updatedAt: new Date().toISOString(),
      } : {};
      if (qs.length) ai.followups = isStaff
        ? { state: "sent", manual: true, questions: qs.map((q: string) => ({ q })), approvedBy: me.full_name || "Rec Ops", approvedAt: new Date().toISOString() }
        : { state: "draft", manual: true, questions: qs.map((q: string) => ({ q })) };
      const { data: link, error } = await admin.from("candidate_jobs").insert({
        candidate_id: cand.id, job_id: body.jobId, stage: "Sourced", candidate_response: "pending",
        fit: r && r.fit != null ? clampScore(r.fit) : null, ai,
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      const { data: j } = await admin.from("jobs").select("role_title,client").eq("id", body.jobId).maybeSingle();
      await admin.from("candidate_timeline").insert({ candidate_id: cand.id, title: "Routed to " + (j ? j.role_title + ", " + j.client : "a role") + (qs.length ? " with " + qs.length + " screening question" + (qs.length > 1 ? "s" : "") : ""), done: true });
      return json({ ok: true, linkId: link.id, questionsState: qs.length ? (isStaff ? "sent" : "draft") : null });
    }

    const { candidateId } = body;
    if (!candidateId) return json({ error: "candidateId is required" }, 400);

    const { data: candidate } = await admin.from("candidates").select("*").eq("id", candidateId).single();
    if (!candidate) return json({ error: "Candidate not found" }, 404);
    if (!isStaff && candidate.recruiter_id !== me.id) return json({ error: "Not your candidate" }, 403);
    if (candidate.ai_locked && ["score_cv", "draft_questions", "review_answer"].includes(action))
      return json({ error: LOCKED_MSG, locked: true }, 409);

    // Remove the resume: delete the stored file (service role, so recruiters can remove
    // their own candidate's resume too) and clear it from the profile.
    if (action === "remove_resume") {
      if (candidate.resume_path) await admin.storage.from("resumes").remove([candidate.resume_path]);
      if (candidate.cv_path) await admin.storage.from("cvs").remove([candidate.cv_path]);
      await admin.from("candidates").update({ resume_path: null, resume_name: null, cv_path: null }).eq("id", candidateId);
      return json({ ok: true });
    }

    // Re-read profile facts (current title/employer, experience, location, phone, notice, pay,
    // skills) from the resume and everything the candidate has answered. Replaces those fields.
    // Allowed on locked candidates, except skills, which are part of the locked review.
    if (action === "read_profile") {
      const r = await readProfile(admin, candidate);
      if ("error" in r) return json({ error: r.error }, 400);
      return json({ ok: true, ...r });
    }

    // Full AI refresh of one candidate, one step per request so nothing hits the time limit:
    // profile -> industries -> titles -> screen (rescreens every accepted company card).
    if (action === "refresh_candidate") return json(await refreshCandidate(admin, candidate, String(body.step || ""), !!body.force));

    // Parallel titles from the full CV. Allowed on locked candidates (not part of the review).
    if (action === "parallel_titles") return json({ ok: true, titles: await parallelTitles(admin, candidateId, askAI, loadResume) });

    // Industry experience: look up every employer on the resume. Allowed on locked candidates
    // (employer facts, not the review). Nothing is saved if the lookup fails.
    if (action === "industries") {
      const { resume, why } = await loadResume(admin, candidate);
      if (!resume) return json({ error: why }, 400);
      const { items, error } = await lookupIndustries(resume);
      if (!items.length) return json({ error: "Couldn't look up the companies: " + (error || "no employers found") }, 502);
      await admin.from("candidates").update({ industries: items, industries_checked_at: new Date().toISOString() }).eq("id", candidateId);
      return json({ ok: true, industries: items });
    }

    let job: any = null;
    if (body.jobId) {
      const { data: j } = await admin.from("jobs").select("*").eq("id", body.jobId).single();
      job = j;
    }

    // ---------------------------------------------------------------
    // 0) Quick "check fit" for an unsubmitted draft candidate — resume ONLY, never
    //    screening-question answers, so a recruiter can tell whether it's worth asking
    //    the candidate the job's screening questions at all. Only the recruiter who
    //    created the draft can run this (staff bypass does not apply here); the result
    //    is written to the still-draft candidate row, which RLS keeps invisible to
    //    everyone but them until they Submit. The caller still writes its own audit-log
    //    entry, same as every other action here.
    // ---------------------------------------------------------------
    if (action === "check_fit") {
      if (!candidate.is_draft) return json({ error: "This candidate has already been submitted" }, 400);
      if (candidate.recruiter_id !== me.id) return json({ error: "Not your candidate" }, 403);
      if (!job) return json({ error: "jobId is required to check fit" }, 400);
      const { resume, why } = await loadResume(admin, candidate);
      if (!resume) return json({ error: why || "Upload a resume first" }, 400);

      const system =
        "You are helping a recruiter decide whether to pursue a candidate for a role, using ONLY their CV — no screening-question answers exist yet. Reply with STRICT JSON only: " +
        `{${REQS_SHAPE}, "verdict": "Perfect fit" | "Good fit" | "Possible fit" | "Not a fit", "score": number (0-100), "verdict_reason": string, "reasoning": string}. ` +
        RUBRIC +
        "Judge ONLY on the requirement checklist above, from the CV alone. Do not penalise for salary or availability — those aren't known yet. " +
        "'reasoning' is 2-3 sentences telling the recruiter whether this candidate is worth screening further for this specific role, and why.";
      const content = jobBlock(job) + "\n\nThe candidate's CV is included.";
      const result = await askAI(system, content, resume, 1200);
      const rawVerdict = ["Perfect fit", "Good fit", "Possible fit", "Not a fit"].includes(result.verdict) ? result.verdict : "Possible fit";
      const checked = enforceChecklist(result.requirements, clampScore(result.score), rawVerdict, "Perfect fit", "Possible fit", "Not a fit");
      // No screening answers exist yet, so a rejection is only ever "possible".
      const verdict = checked.verdict === "Not a fit" ? "Possible reject" : checked.verdict;
      const score = checked.score;
      await admin.from("candidates").update({
        screening: { state: "checked_fit", jobId: job.id, verdict, score, reasoning: String(result.reasoning || "").slice(0, 800), checkedAt: new Date().toISOString() },
      }).eq("id", candidateId);
      return json({ ok: true, verdict, score, reasoning: result.reasoning || "" });
    }

    // ---------------------------------------------------------------
    // 1) Score a candidate — their resume (any format) plus any screening answers for the job.
    //    Resumes live in the private "resumes" bucket at <candidateId>/<file>
    //    (candidates.resume_path); older ones in "cvs" (cv_path) are still read.
    //    A fresh base64 upload is stored first so it can be re-scored later.
    // ---------------------------------------------------------------
    if (action === "score_cv") {
      let resume: ResumeInput | null = null, fileLinkedIn = "";
      if (body.fileBase64) {
        const cvPath = candidateId + "/" + Date.now() + "-cv.pdf";
        const bytes = Uint8Array.from(atob(body.fileBase64), (c) => c.charCodeAt(0));
        const { error: upErr } = await admin.storage.from("resumes").upload(cvPath, bytes, { contentType: "application/pdf", upsert: true });
        if (upErr) return json({ error: "Could not store the CV: " + upErr.message }, 500);
        await admin.from("candidates").update({ resume_path: cvPath, resume_name: "CV.pdf" }).eq("id", candidateId);
        resume = { kind: "pdf", data: body.fileBase64 };
        fileLinkedIn = await findLinkedIn(bytes, "CV.pdf");
      } else {
        const r = await loadResume(admin, candidate);
        if (!r.resume) return json({ error: r.why }, 400);
        resume = r.resume; fileLinkedIn = r.linkedin || "";
      }

      const material = await screeningMaterial(admin, candidate, job);
      const context =
        (job ? `They are being considered for this role.\n${jobBlock(job)}` : "No specific job is attached yet — score general employability and extract a broad skill profile.") +
        "\n\n" + industryText(candidate.industries) + "\n\n" +
        (material.count
          ? `Candidate's screening answers (their own words):\n${material.text}`
          : "Screening answers: none recorded yet — score from the resume alone.");

      const system =
        "You are a recruitment analyst screening a candidate. You are given their CV (attached, or as extracted text) and, when available, their answers to screening questions. " +
        "Use BOTH together: the CV shows their track record; the screening answers add or clarify skills, experience, salary expectation, notice period and availability. " +
        "Where an answer adds a relevant skill or experience the CV doesn't show, give credit for it. Where an answer contradicts the CV, list that in 'gaps' so the recruiter can check it. " +
        "Reply with STRICT JSON only, no markdown, no commentary, matching exactly this shape: " +
        `{${REQS_SHAPE}, ${PROFILE_SHAPE}, "strengths": string[], "gaps": string[], "score": number (0-100), "parallel_titles": string[]}. ` +
        PROFILE_RULES + PARALLEL_RULE +
        (job ? RUBRIC + "score is the checklist score for this job, adjusted only for (if answered) salary and availability fit. " : "No job is attached: score general employability, list requirements as []. ") +
        "Salary: be flexible, only count it against them if it is clearly and substantially over the job's budget. " +
        "For 'notice' and 'pay', the candidate's screening answers win over the CV.";

      const result = await askAI(system, context, resume, 2500);
      const score = job ? enforceChecklist(result.requirements, clampScore(result.score), "", "", "").score : clampScore(result.score);
      const prof = cleanProfile(result);
      const patch: Record<string, unknown> = {
        skills: prof.skills,
        strengths: result.strengths || [],
        gaps: result.gaps || [],
        ai_score: score,
        experience: prof.experience || "-",
        current_title: prof.current_title || null,
        current_company: prof.current_company || null,
        profile_read_at: new Date().toISOString(),
      };
      const titles = cleanTitles(result.parallel_titles);
      if (titles.length) { patch.parallel_titles = titles; patch.parallel_titles_at = new Date().toISOString(); }
      // Notice and salary expectation: answers to screening questions win, so the resume
      // only fills these when nothing is on file yet.
      const blank = (v: unknown) => !v || String(v).trim() === "" || String(v).trim() === "-";
      if (blank(candidate.notice)) patch.notice = prof.notice || "-";
      if (blank(candidate.pay)) patch.pay = prof.pay || "-";
      // Only fill phone/location from the CV if the candidate doesn't already have one on
      // file — never let a re-score silently overwrite a value staff typed in themselves.
      if (prof.phone && !candidate.phone) patch.phone = prof.phone;
      if (prof.location && !candidate.location) patch.location = prof.location;
      const li = prof.linkedin || fileLinkedIn;
      if (li && !candidate.linkedin_url) patch.linkedin_url = li;
      await admin.from("candidates").update(patch).eq("id", candidateId);
      // The per-job fit shown on the job page and the candidate's Jobs card.
      if (job && material.linkId) await admin.from("candidate_jobs").update({ fit: score }).eq("id", material.linkId);
      // A new resume changes every company card: rescreen the ones the candidate is on.
      let rescreened = 0;
      if (body.rescreenCards) {
        const { data: cards } = await admin.from("candidate_jobs").select("id").eq("candidate_id", candidateId).eq("candidate_response", "accepted").limit(5);
        for (const c of cards || []) { try { await screenLink(admin, c.id, askAI, loadResume); rescreened++; } catch (e) { console.error("rescreen", c.id, String((e as Error)?.message || e)); } }
      }
      return json({ ok: true, result, usedScreeningAnswers: material.count > 0, rescreened });
    }

    // ---------------------------------------------------------------
    // 2) Draft screening questions for a candidate against a specific job.
    //    Reads the resume too (when there is one), so the skills question
    //    targets what the CV leaves unclear.
    // ---------------------------------------------------------------
    if (action === "draft_questions") {
      if (!job) return json({ error: "jobId is required to draft screening questions" }, 400);
      const { resume } = await loadResume(admin, candidate);
      const jobQs: string[] = Array.isArray(job.screening_questions) ? job.screening_questions : [];
      const system =
        "You write short candidate screening questions for a recruiter. Reply with STRICT JSON only: " +
        `{"questions": string[]} with EXACTLY 3 questions: one verifying a specific skill or requirement from the job description that the candidate's CV/background does not clearly prove, one asking their salary expectation, and one asking their earliest available start date. ` +
        "Keep each question under 25 words. Don't repeat anything the job's own screening questions already ask.";
      const content =
        `Candidate: ${candidate.name}, current/last role: ${candidate.role_title}. Known skills: ${(candidate.skills || []).join(", ") || "not yet known"}.` +
        (resume ? " Their CV is included." : " No readable CV is on file.") + "\n" +
        jobBlock(job) +
        (jobQs.length ? `\nThe job's own screening questions (already asked separately):\n${jobQs.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "");
      const result = await askAI(system, content, resume, 400);
      const questions = dedupeQuestions(result.questions, jobQs, 3);
      await admin.from("candidates").update({
        screening: { state: "pending", questions, jobId: body.jobId },
      }).eq("id", candidateId);
      return json({ ok: true, questions });
    }

    // ---------------------------------------------------------------
    // 3) Fit verdict from the resume AND all screening answers for the job.
    // ---------------------------------------------------------------
    if (action === "review_answer") {
      const { answerText } = body;
      if (!answerText || !answerText.trim()) return json({ error: "answerText is required" }, 400);
      const screeningJobId = candidate.screening?.jobId || body.jobId;
      let reviewJob = job;
      if (!reviewJob || (screeningJobId && reviewJob.id !== screeningJobId)) {
        if (screeningJobId) {
          const { data: j } = await admin.from("jobs").select("*").eq("id", screeningJobId).single();
          reviewJob = j || reviewJob;
        }
      }
      if (!reviewJob) return json({ error: "No job on file for this screening — pass jobId" }, 400);

      const { resume } = await loadResume(admin, candidate);
      const material = await screeningMaterial(admin, candidate, reviewJob, false);
      const questions = candidate.screening?.questions || [];
      const system =
        "You are screening a candidate for a recruiter, using BOTH their CV (attached or as extracted text, when present) and their screening answers. Reply with STRICT JSON only: " +
        `{${REQS_SHAPE}, "verdict": "Perfect fit" | "Good fit" | "Possible fit" | "Not a fit", "score": number (0-100), "verdict_reason": string, "reasoning": string}. ` +
        RUBRIC +
        "Judge STRICTLY on three things only: (1) the requirement checklist above, from the CV and anything the answers add, (2) salary expectation — be flexible, only count against them if it is clearly and substantially over the job's budget, a normal negotiation-range gap is fine, (3) stated start date — only count against them if it is clearly incompatible with the role's timeline. " +
        "If an answer contradicts the CV, say so. " +
        "'reasoning' is 2-4 sentences a recruiter will read, explicitly touching on skills fit (saying what the CV shows and what the answers added), salary, and start date so they can see why you reached this verdict.";
      const content =
        jobBlock(reviewJob) + "\n\n" +
        (resume ? "The candidate's CV is included.\n" : `No readable CV on file. Known skills: ${(candidate.skills || []).join(", ") || "not yet known"}.\n`) +
        (material.count ? `\nAnswers to the job's screening questions:\n${material.text}\n` : "") +
        `\nAI screening questions sent:\n${questions.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n") || "(none recorded)"}\n` +
        `Candidate's reply:\n${answerText}`;
      const result = await askAI(system, content, resume, 2500);
      const rawVerdict = ["Perfect fit", "Good fit", "Possible fit", "Not a fit"].includes(result.verdict) ? result.verdict : "Possible fit";
      const checked = enforceChecklist(result.requirements, clampScore(result.score), rawVerdict, "Perfect fit", "Possible fit", "Not a fit");
      const verdict = checked.verdict;
      result.score = checked.score;
      await admin.from("candidates").update({
        screening: {
          ...(candidate.screening || {}),
          state: "answered",
          qa: [{ q: "Candidate reply", a: answerText.trim() }],
          verdict,
          reasoning: result.reasoning || "",
          usedResume: !!resume,
        },
      }).eq("id", candidateId);
      if (material.linkId && result.score != null) await admin.from("candidate_jobs").update({ fit: clampScore(result.score) }).eq("id", material.linkId);
      return json({ ok: true, verdict, reasoning: result.reasoning });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
