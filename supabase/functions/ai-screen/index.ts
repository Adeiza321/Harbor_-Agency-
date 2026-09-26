import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";

async function askClaude(system: string, content: string | unknown[], maxTokens = 800) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("AI is not configured yet (missing ANTHROPIC_API_KEY).");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("AI request failed (" + res.status + "): " + t.slice(0, 300));
  }
  const data = await res.json();
  const text = (data.content || []).map((b: any) => b.text || "").join("").trim();
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("AI returned something unexpected: " + text.slice(0, 300));
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);

    const { data: me } = await admin.from("profiles").select("id,role,status").eq("id", caller.user.id).single();
    if (!me || me.status !== "Active") return json({ error: "Your account is not active" }, 403);
    const isStaff = me.role === "admin" || me.role === "recops";

    const body = await req.json();
    const { action, candidateId } = body;
    if (!candidateId) return json({ error: "candidateId is required" }, 400);

    const { data: candidate } = await admin.from("candidates").select("*").eq("id", candidateId).single();
    if (!candidate) return json({ error: "Candidate not found" }, 404);
    if (!isStaff && candidate.recruiter_id !== me.id) return json({ error: "Not your candidate" }, 403);

    let job: any = null;
    if (body.jobId) {
      const { data: j } = await admin.from("jobs").select("*").eq("id", body.jobId).single();
      job = j;
    }

    // ---------------------------------------------------------------
    // 1) Score a CV — extracts skills/experience, produces a numeric score.
    //    A fresh PDF upload is stored in the "cvs" bucket so it can be
    //    re-scored later (e.g. against a different job) without re-uploading.
    // ---------------------------------------------------------------
    if (action === "score_cv") {
      let { fileBase64 } = body;
      const mediaType = "application/pdf";
      const cvPath = candidateId + ".pdf";

      if (fileBase64) {
        // New upload: store it, so it can be re-scored later.
        const bytes = Uint8Array.from(atob(fileBase64), (c) => c.charCodeAt(0));
        const { error: upErr } = await admin.storage.from("cvs").upload(cvPath, bytes, { contentType: mediaType, upsert: true });
        if (upErr) return json({ error: "Could not store the CV: " + upErr.message }, 500);
        await admin.from("candidates").update({ cv_path: cvPath }).eq("id", candidateId);
      } else if (candidate.cv_path) {
        // Re-score using the CV already on file.
        const { data: file, error: dlErr } = await admin.storage.from("cvs").download(candidate.cv_path);
        if (dlErr || !file) return json({ error: "Could not read the stored CV. Try re-uploading it." }, 500);
        const buf = new Uint8Array(await file.arrayBuffer());
        fileBase64 = bytesToBase64(buf);
      } else {
        return json({ error: "No CV on file for this candidate. Attach a PDF to score one." }, 400);
      }

      const jdBlock = job
        ? `They are being considered for: ${job.role_title} at ${job.client}.\nJob description:\n${job.description || "(no description given)"}\nSalary range: ${job.min_pay || "?"} - ${job.max_pay || "?"} NGN/year.`
        : `No specific job is attached yet — score general employability and extract a broad skill profile.`;
      const system =
        "You are a recruitment analyst. Read the attached CV and reply with STRICT JSON only, no markdown, no commentary, matching exactly this shape: " +
        `{"skills": string[], "strengths": string[], "gaps": string[], "score": number (0-100), "experience": string, "notice": string, "pay": string}. ` +
        "score reflects how strong a fit the candidate is for the context given, based only on skills and experience — never penalize or reward based on job tenure/duration at past employers. " +
        "'experience' is a short summary like '6 yrs backend engineering'. 'notice' and 'pay' are short strings extracted from the CV if stated, else '-'.";
      const result = await askClaude(system, [
        { type: "document", source: { type: "base64", media_type: mediaType, data: fileBase64 } },
        { type: "text", text: jdBlock },
      ]);
      await admin.from("candidates").update({
        skills: result.skills || [],
        strengths: result.strengths || [],
        gaps: result.gaps || [],
        ai_score: Math.max(0, Math.min(100, Math.round(result.score || 0))),
        experience: result.experience || "-",
        notice: result.notice || "-",
        pay: result.pay || "-",
      }).eq("id", candidateId);
      return json({ ok: true, result });
    }

    // ---------------------------------------------------------------
    // 2) Draft screening questions for a candidate against a specific job.
    // ---------------------------------------------------------------
    if (action === "draft_questions") {
      if (!job) return json({ error: "jobId is required to draft screening questions" }, 400);
      const system =
        "You write short candidate screening questions for a recruiter. Reply with STRICT JSON only: " +
        `{"questions": string[]} with EXACTLY 3 questions: one verifying a specific skill or requirement from the job description against the candidate's background, one asking their salary expectation, and one asking their earliest available start date. Keep each question under 25 words.`;
      const content =
        `Candidate: ${candidate.name}, current/last role: ${candidate.role_title}. Known skills: ${(candidate.skills || []).join(", ") || "not yet known"}.\n` +
        `Job: ${job.role_title} at ${job.client}.\nDescription: ${job.description || "(none given)"}\nSalary range: ${job.min_pay || "?"} - ${job.max_pay || "?"} NGN/year.`;
      const result = await askClaude(system, content, 400);
      const questions = (result.questions || []).slice(0, 3);
      await admin.from("candidates").update({
        screening: { state: "pending", questions, jobId: body.jobId },
      }).eq("id", candidateId);
      return json({ ok: true, questions });
    }

    // ---------------------------------------------------------------
    // 3) Review the candidate's reply and return a fit verdict + reasoning.
    // ---------------------------------------------------------------
    if (action === "review_answer") {
      const { answerText } = body;
      if (!answerText || !answerText.trim()) return json({ error: "answerText is required" }, 400);
      const screeningJobId = candidate.screening?.jobId || body.jobId;
      let reviewJob = job;
      if (!reviewJob && screeningJobId) {
        const { data: j } = await admin.from("jobs").select("*").eq("id", screeningJobId).single();
        reviewJob = j;
      }
      if (!reviewJob) return json({ error: "No job on file for this screening — pass jobId" }, 400);
      const questions = candidate.screening?.questions || [];
      const system =
        "You are reviewing a candidate's screening-question reply for a recruiter. Reply with STRICT JSON only: " +
        `{"verdict": "Perfect fit" | "Possible fit" | "Not a fit", "reasoning": string}. ` +
        "Judge STRICTLY on three things only: (1) skills vs the job's stated requirements — never consider how long they held past roles/tenure, that is irrelevant, (2) salary expectation — be flexible, only count against them if it is clearly and substantially over the job's budget, a normal negotiation-range gap is fine, (3) stated start date — only count against them if it is clearly incompatible with the role's timeline. " +
        "'reasoning' is 2-4 sentences a recruiter will read, explicitly touching on skills fit, salary, and start date so they can see why you reached this verdict.";
      const content =
        `Job: ${reviewJob.role_title} at ${reviewJob.client}.\nDescription: ${reviewJob.description || "(none given)"}\nBudget: ${reviewJob.min_pay || "?"} - ${reviewJob.max_pay || "?"} NGN/year.\n` +
        `Candidate known skills: ${(candidate.skills || []).join(", ") || "not yet known"}.\n` +
        `Screening questions asked: ${questions.join(" | ") || "(none recorded)"}\n` +
        `Candidate's reply: ${answerText}`;
      const result = await askClaude(system, content, 500);
      const verdict = ["Perfect fit", "Possible fit", "Not a fit"].includes(result.verdict) ? result.verdict : "Possible fit";
      await admin.from("candidates").update({
        screening: {
          ...(candidate.screening || {}),
          state: "answered",
          qa: [{ q: "Candidate reply", a: answerText.trim() }],
          verdict,
          reasoning: result.reasoning || "",
        },
      }).eq("id", candidateId);
      return json({ ok: true, verdict, reasoning: result.reasoning });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
