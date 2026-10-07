import { createClient } from "npm:@supabase/supabase-js@2";

// Public, unauthenticated endpoint: the front door for every inbound source (the public apply
// page at /?apply=<job link_slug>, a paste-in from Indeed/LinkedIn, a manual entry tool, a webhook
// from a job board) to land a candidate in Pronext's Inbox (`applications` table, status 'new'),
// where Rec Ops / Admins assign it to a recruiter (inbox function) or dismiss it.
//
// This is deliberately the ONLY writer of unauthenticated data: it validates, rate-limits
// by simple dedupe, and uses the service role to get past RLS (applications is staff-only
// otherwise) so no other part of the surface area needs to be opened up.
// Sources: career_page (apply page), outreach (apply button in an outreach email), referral
// (someone referring a friend, with `referrer`), and the job-board / manual ones below.
// A CV, when sent, is stored privately at resumes/applications/<application id>/<file>.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SOURCES = ["career_page", "outreach", "linkedin", "indeed", "google_jobs", "facebook", "referral", "manual"];
const CV_TYPES: Record<string, string> = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MAX_CV = 8 * 1024 * 1024;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));

    // Honeypot: a real browser/candidate never fills this hidden field; a bot filling
    // every input on the form will. Silently pretend success so bots don't learn to skip it.
    if (body.website || body.company_website) return json({ ok: true });

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const roleTitle = String(body.role_title || "").trim();
    const source = SOURCES.includes(body.source) ? body.source : "career_page";
    const jobId = body.job_id ? String(body.job_id) : null;
    const linkSlug = body.link_slug ? String(body.link_slug).trim() : null;
    const linkedinRaw = String(body.linkedin || "").trim();
    const linkedin = /linkedin\.com\//i.test(linkedinRaw) ? linkedinRaw.slice(0, 300) : null;

    // Referrals: someone recommending a friend from the apply page. The friend is the applicant;
    // who referred them is kept with the application ({name, email, note}).
    let referrer: { name: string; email: string; note: string } | null = null;
    if (source === "referral" && body.referrer && typeof body.referrer === "object") {
      const rn = String(body.referrer.name || "").trim().slice(0, 200), re = String(body.referrer.email || "").trim().toLowerCase().slice(0, 320);
      if (!rn) return json({ error: "Enter your name" }, 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(re)) return json({ error: "Enter a valid email for yourself" }, 400);
      if (re === email) return json({ error: "Use your friend's email address, not your own" }, 400);
      referrer = { name: rn, email: re, note: String(body.referrer.note || "").trim().slice(0, 1000) };
    }

    if (!name || name.length > 200) return json({ error: "Enter a valid name" }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320) return json({ error: "Enter a valid email" }, 400);
    if (phone.length > 40 || roleTitle.length > 200) return json({ error: "Some details are too long" }, 400);
    // ilike treats % and _ as wildcards; escape them so "a_b@x.com" only matches itself.
    const emailPattern = email.replace(/[\\%_]/g, (c) => "\\" + c);

    // CV (optional here; the apply page always sends one).
    let cv: { bytes: Uint8Array; name: string; type: string } | null = null;
    if (body.cv && typeof body.cv === "object") {
      const cvName = String(body.cv.name || "CV").replace(/[\\/\u0000-\u001f]/g, "").trim().slice(0, 120) || "CV";
      const ext = (cvName.split(".").pop() || "").toLowerCase();
      const type = CV_TYPES[ext];
      if (!type) return json({ error: "Upload your CV as a PDF or Word document" }, 400);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(String(body.cv.data || "")), (c) => c.charCodeAt(0)); } catch { return json({ error: "Your CV didn't upload properly. Please try again." }, 400); }
      if (bytes.length < 100) return json({ error: "That CV file looks empty" }, 400);
      if (bytes.length > MAX_CV) return json({ error: "Your CV can be up to 8 MB" }, 400);
      cv = { bytes, name: cvName, type };
    }

    // Rate limit: the same address can't flood the Inbox (5 applications a day across all roles).
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: recent } = await admin.from("applications").select("id", { count: "exact", head: true }).ilike("email", emailPattern).gte("created_at", dayAgo);
    if ((recent || 0) >= 5) return json({ error: "We've already received several applications from this email today. Please try again tomorrow." }, 429);

    // Resolve the job either by id or by its public link_slug (what a job page URL carries).
    let resolvedJobId: string | null = null;
    let resolvedRoleTitle = roleTitle;
    let questions: string[] = [];
    if (jobId || linkSlug) {
      const q = admin.from("jobs").select("id,role_title,status,screening_questions").limit(1);
      const { data: job } = jobId ? await q.eq("id", jobId).single() : await q.eq("link_slug", linkSlug).single();
      if (!job) return json({ error: "That role could not be found" }, 404);
      if (job.status === "Closed") return json({ error: "This role is no longer accepting applications" }, 400);
      if (job.status === "On hold") return json({ error: "This role is paused and isn't taking applications right now. Please check back soon." }, 400);
      resolvedJobId = job.id;
      resolvedRoleTitle = job.role_title;
      questions = Array.isArray(job.screening_questions) ? job.screening_questions.map(String) : [];
    }
    if (!resolvedRoleTitle) return json({ error: "Missing role" }, 400);
    // Answers to the job's own screening questions, kept as {q, a} so they survive later edits.
    const given = Array.isArray(body.answers) ? body.answers : [];
    const answers = questions.map((q, i) => ({ q, a: String(given[i] ?? "").trim().slice(0, 3000) })).filter((x) => x.a);

    // Dedupe: the same person applying twice to the same role (double form submit, a
    // platform resending the same lead) should not create a second Inbox row.
    if (resolvedJobId) {
      const { data: existing } = await admin.from("applications").select("id").eq("job_id", resolvedJobId).ilike("email", emailPattern).limit(1);
      if (existing && existing.length) return json({ ok: true, duplicate: true });
    }

    const { data, error } = await admin.from("applications").insert({
      name,
      email: email || null,
      phone: phone || null,
      role_title: resolvedRoleTitle,
      source,
      job_id: resolvedJobId,
      linkedin,
      answers,
      referrer,
      status: "new",
    }).select("id").single();
    if (error) return json({ error: error.message }, 500);

    if (cv) {
      const safe = cv.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "CV";
      const path = `applications/${data.id}/${Date.now()}-${safe}`;
      const { error: upErr } = await admin.storage.from("resumes").upload(path, cv.bytes, { contentType: cv.type, upsert: false });
      if (upErr) console.error("cv upload", data.id, upErr.message);
      else await admin.from("applications").update({ resume_path: path, resume_name: cv.name }).eq("id", data.id);
    }

    return json({ ok: true, id: data.id });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
