import { createClient } from "npm:@supabase/supabase-js@2";
import { prepareResume, type ResumeInput } from "./resume.ts";
import { screenLink } from "./screening.ts";

// AI screening for Harbor: CV scoring, screening-question drafting and the fit verdict.
//
// Provider: Gemini when the GEMINI_API_KEY secret is set (model from GEMINI_MODEL,
// default gemini-3.8-flash); otherwise Anthropic via ANTHROPIC_API_KEY. To switch back
// to Claude, delete the GEMINI_API_KEY secret — no code change needed.
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

const ANTHROPIC_MODEL = "claude-sonnet-5";
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

// Models to try in order. When one is overloaded (503) or rate-limited (429), Harbor
// waits briefly, retries, then moves to the next model instead of failing.
const GEMINI_FALLBACKS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error("AI request failed (" + res.status + "): " + (await res.text()).slice(0, 300));
  const data = await res.json();
  return parseJson((data.content || []).map((b: any) => b.text || "").join(""));
}

async function askAI(system: string, text: string, resume: ResumeInput | null = null, maxTokens = 800) {
  const gemini = Deno.env.get("GEMINI_API_KEY");
  if (gemini) return askGemini(gemini, system, text, resume, maxTokens);
  const anthropic = Deno.env.get("ANTHROPIC_API_KEY");
  if (anthropic) return askAnthropic(anthropic, system, text, resume, maxTokens);
  throw new Error("AI is not configured yet: add a GEMINI_API_KEY secret to this Supabase project.");
}

// The resume on file, ready for the AI (any supported format), or a reason it can't be read.
async function loadResume(admin: any, candidate: any): Promise<{ resume: ResumeInput | null; why?: string }> {
  const path = candidate.resume_path || candidate.cv_path;
  if (!path) return { resume: null, why: "No resume on file for this candidate. Upload one to score them." };
  const bucket = candidate.resume_path ? "resumes" : "cvs";
  const { data: file, error } = await admin.storage.from(bucket).download(path);
  if (error || !file) return { resume: null, why: "Could not read the stored resume. Try re-uploading it." };
  const r = await prepareResume(new Uint8Array(await file.arrayBuffer()), (candidate.resume_path && candidate.resume_name) || path);
  return r.input ? { resume: r.input } : { resume: null, why: r.why };
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
  (job.location ? `\nLocation: ${job.location}` : "") + (job.country ? `\nHiring country: ${job.country}` : "");

const clampScore = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

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
        if (accept) { try { await screenLink(admin, link.id, askAI, loadResume); } catch (e) { console.error("screen after accept", String((e as Error)?.message || e)); } }
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

    // ---------------------------------------------------------------
    // Everything below needs a signed-in, active Harbor user.
    // ---------------------------------------------------------------
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);

    const { data: me } = await admin.from("profiles").select("id,role,status,full_name").eq("id", caller.user.id).single();
    if (!me || me.status !== "Active") return json({ error: "Your account is not active" }, 403);
    const isStaff = me.role === "admin" || me.role === "recops";
    const { action } = body;

    // Card-level actions take a linkId (one candidate on one job).
    if (action === "screen" || action === "approve_questions") {
      const { data: link } = await admin.from("candidate_jobs").select("*").eq("id", body.linkId).maybeSingle();
      if (!link) return json({ error: "Screening card not found" }, 404);
      const { data: owner } = await admin.from("candidates").select("recruiter_id").eq("id", link.candidate_id).single();
      if (!isStaff && owner?.recruiter_id !== me.id) return json({ error: "Not your candidate" }, 403);
      if (link.candidate_response !== "accepted") return json({ error: "The candidate hasn't accepted this role yet" }, 409);

      if (action === "screen") return json({ ok: true, ai: await screenLink(admin, link.id, askAI, loadResume) });

      // approve_questions: only Rec Ops and Admins can send follow-up questions to a candidate.
      if (!isStaff) return json({ error: "Only Rec Ops or Admins can approve screening questions" }, 403);
      const f = link.ai?.followups;
      if (f && f.state !== "draft") return json({ error: "These questions were already sent" }, 409);
      const qs = (Array.isArray(body.questions) ? body.questions : []).map((q: unknown) => String(q || "").trim()).filter(Boolean).slice(0, 6);
      if (!qs.length) return json({ error: "Add at least one question" }, 400);
      const ai = { ...(link.ai || {}), followups: { state: "sent", questions: qs.map((q: string) => ({ q })), approvedBy: me.full_name || "Rec Ops", approvedAt: new Date().toISOString() } };
      await admin.from("candidate_jobs").update({ ai }).eq("id", link.id);
      await admin.from("candidate_timeline").insert({ candidate_id: link.candidate_id, title: "Screening questions sent by " + (me.full_name || "Rec Ops"), done: true });
      return json({ ok: true, ai });
    }

    const { candidateId } = body;
    if (!candidateId) return json({ error: "candidateId is required" }, 400);

    const { data: candidate } = await admin.from("candidates").select("*").eq("id", candidateId).single();
    if (!candidate) return json({ error: "Candidate not found" }, 404);
    if (!isStaff && candidate.recruiter_id !== me.id) return json({ error: "Not your candidate" }, 403);

    // Remove the resume: delete the stored file (service role, so recruiters can remove
    // their own candidate's resume too) and clear it from the profile.
    if (action === "remove_resume") {
      if (candidate.resume_path) await admin.storage.from("resumes").remove([candidate.resume_path]);
      if (candidate.cv_path) await admin.storage.from("cvs").remove([candidate.cv_path]);
      await admin.from("candidates").update({ resume_path: null, resume_name: null, cv_path: null }).eq("id", candidateId);
      return json({ ok: true });
    }

    let job: any = null;
    if (body.jobId) {
      const { data: j } = await admin.from("jobs").select("*").eq("id", body.jobId).single();
      job = j;
    }

    // ---------------------------------------------------------------
    // 1) Score a candidate — their resume (any format) plus any screening answers for the job.
    //    Resumes live in the private "resumes" bucket at <candidateId>/<file>
    //    (candidates.resume_path); older ones in "cvs" (cv_path) are still read.
    //    A fresh base64 upload is stored first so it can be re-scored later.
    // ---------------------------------------------------------------
    if (action === "score_cv") {
      let resume: ResumeInput | null = null;
      if (body.fileBase64) {
        const cvPath = candidateId + "/" + Date.now() + "-cv.pdf";
        const bytes = Uint8Array.from(atob(body.fileBase64), (c) => c.charCodeAt(0));
        const { error: upErr } = await admin.storage.from("resumes").upload(cvPath, bytes, { contentType: "application/pdf", upsert: true });
        if (upErr) return json({ error: "Could not store the CV: " + upErr.message }, 500);
        await admin.from("candidates").update({ resume_path: cvPath, resume_name: "CV.pdf" }).eq("id", candidateId);
        resume = { kind: "pdf", data: body.fileBase64 };
      } else {
        const r = await loadResume(admin, candidate);
        if (!r.resume) return json({ error: r.why }, 400);
        resume = r.resume;
      }

      const material = await screeningMaterial(admin, candidate, job);
      const context =
        (job ? `They are being considered for this role.\n${jobBlock(job)}` : "No specific job is attached yet — score general employability and extract a broad skill profile.") +
        "\n\n" +
        (material.count
          ? `Candidate's screening answers (their own words):\n${material.text}`
          : "Screening answers: none recorded yet — score from the resume alone.");

      const system =
        "You are a recruitment analyst screening a candidate. You are given their CV (attached, or as extracted text) and, when available, their answers to screening questions. " +
        "Use BOTH together: the CV shows their track record; the screening answers add or clarify skills, experience, salary expectation, notice period and availability. " +
        "Where an answer adds a relevant skill or experience the CV doesn't show, give credit for it. Where an answer contradicts the CV, list that in 'gaps' so the recruiter can check it. " +
        "Reply with STRICT JSON only, no markdown, no commentary, matching exactly this shape: " +
        `{"skills": string[], "strengths": string[], "gaps": string[], "score": number (0-100), "experience": string, "notice": string, "pay": string, "phone": string, "location": string}. ` +
        "score reflects how strong a fit the candidate is for the context given, based only on skills, experience and (if answered) salary and availability fit — never penalize or reward based on job tenure/duration at past employers. " +
        "Salary: be flexible, only count it against them if it is clearly and substantially over the job's budget. " +
        "'experience' is a short summary like '6 yrs backend engineering'. 'notice' is their notice period and 'pay' their salary expectation (amount, currency and period as stated): short strings taken from the screening answers if given there, else from the CV if stated, else '-'. " +
        "'phone' is the candidate's phone/mobile number exactly as written on the CV (digits, spaces, dashes, parens as given), or '' if none is present. " +
        "'location' is the candidate's city and state/region (and country if not obviously the same country as the job) as stated on the CV, e.g. 'Austin, TX', or '' if none is present — never guess a location from an area code or any other indirect clue, only use it if the CV states it directly.";

      const result = await askAI(system, context, resume, 1200);
      const score = clampScore(result.score);
      const patch: Record<string, unknown> = {
        skills: result.skills || [],
        strengths: result.strengths || [],
        gaps: result.gaps || [],
        ai_score: score,
        experience: result.experience || "-",
      };
      // Notice and salary expectation: answers to screening questions win, so the resume
      // only fills these when nothing is on file yet.
      const blank = (v: unknown) => !v || String(v).trim() === "" || String(v).trim() === "-";
      if (blank(candidate.notice)) patch.notice = result.notice || "-";
      if (blank(candidate.pay)) patch.pay = result.pay || "-";
      // Only fill phone/location from the CV if the candidate doesn't already have one on
      // file — never let a re-score silently overwrite a value staff typed in themselves.
      if (result.phone && !candidate.phone) patch.phone = result.phone;
      if (result.location && !candidate.location) patch.location = result.location;
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
      const questions = (result.questions || []).slice(0, 3);
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
        `{"verdict": "Perfect fit" | "Possible fit" | "Not a fit", "score": number (0-100), "reasoning": string}. ` +
        "Judge STRICTLY on three things only: (1) skills and experience vs the job's stated requirements, from the CV and anything the answers add — never consider how long they held past roles/tenure, that is irrelevant, (2) salary expectation — be flexible, only count against them if it is clearly and substantially over the job's budget, a normal negotiation-range gap is fine, (3) stated start date — only count against them if it is clearly incompatible with the role's timeline. " +
        "If an answer contradicts the CV, say so. " +
        "'reasoning' is 2-4 sentences a recruiter will read, explicitly touching on skills fit (saying what the CV shows and what the answers added), salary, and start date so they can see why you reached this verdict.";
      const content =
        jobBlock(reviewJob) + "\n\n" +
        (resume ? "The candidate's CV is included.\n" : `No readable CV on file. Known skills: ${(candidate.skills || []).join(", ") || "not yet known"}.\n`) +
        (material.count ? `\nAnswers to the job's screening questions:\n${material.text}\n` : "") +
        `\nAI screening questions sent:\n${questions.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n") || "(none recorded)"}\n` +
        `Candidate's reply:\n${answerText}`;
      const result = await askAI(system, content, resume, 700);
      const verdict = ["Perfect fit", "Possible fit", "Not a fit"].includes(result.verdict) ? result.verdict : "Possible fit";
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
