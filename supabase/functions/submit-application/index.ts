import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, sendBrevo } from "./brand.ts";
import { newReferralToken, referralEmail } from "./referral.ts";

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
// A referral also emails the person referred (through Brevo): who referred them, for which role,
// and "I'm interested" (referral.ts). Until they say yes, the Inbox can only view the referral.
// Someone can refer at most 10 people a day.
// An application from an outreach email's "I'm interested" button carries the prospect's token
// (pt), which marks that prospect as interested.

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
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: byReferrer } = await admin.from("applications").select("id", { count: "exact", head: true }).eq("referrer->>email", re).gte("created_at", since);
      if ((byReferrer || 0) >= 10) return json({ error: "You've already sent several referrals today. Please try again tomorrow." }, 429);
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
    let slug: string | null = null;
    if (jobId || linkSlug) {
      const q = admin.from("jobs").select("id,role_title,status,screening_questions,link_slug").limit(1);
      const { data: job } = jobId ? await q.eq("id", jobId).single() : await q.eq("link_slug", linkSlug).single();
      if (!job) return json({ error: "That role could not be found" }, 404);
      if (job.status === "Closed") return json({ error: "This role is no longer accepting applications" }, 400);
      if (job.status === "On hold") return json({ error: "This role is paused and isn't taking applications right now. Please check back soon." }, 400);
      resolvedJobId = job.id;
      resolvedRoleTitle = job.role_title;
      slug = job.link_slug || null;
      questions = Array.isArray(job.screening_questions) ? job.screening_questions.map(String) : [];
    }
    if (!resolvedRoleTitle) return json({ error: "Missing role" }, 400);
    // Answers to the job's own screening questions, kept as {q, a} so they survive later edits.
    const given = Array.isArray(body.answers) ? body.answers : [];
    const answers = questions.map((q, i) => ({ q, a: String(given[i] ?? "").trim().slice(0, 3000) })).filter((x) => x.a);

    // Dedupe: the same person applying twice to the same role (double form submit, a
    // platform resending the same lead) should not create a second Inbox row. The one exception:
    // someone who was referred and now applies themselves fills in the referral's row (their
    // CV, phone, answers), keeping who referred them.
    let data: { id: string; referral_token?: string | null } | null = null;
    if (resolvedJobId) {
      const { data: existing } = await admin.from("applications").select("id,source,status,resume_path").eq("job_id", resolvedJobId).ilike("email", emailPattern).limit(1);
      const ex = existing && existing[0];
      if (ex) {
        if (!(ex.source === "referral" && !referrer && ex.status === "new")) return json({ ok: true, duplicate: true });
        await admin.from("applications").update({ name, phone: phone || undefined, linkedin: linkedin || undefined, ...(answers.length ? { answers } : {}) }).eq("id", ex.id);
        // Applying themselves is the clearest "I'm interested".
        await admin.from("applications").update({ interest_at: new Date().toISOString() }).eq("id", ex.id).is("interest_at", null);
        data = { id: ex.id };
      }
    }

    if (!data) {
      const { data: row, error } = await admin.from("applications").insert({
        name,
        email: email || null,
        phone: phone || null,
        role_title: resolvedRoleTitle,
        source,
        job_id: resolvedJobId,
        linkedin,
        answers,
        referrer,
        referral_token: referrer ? newReferralToken() : null,
        status: "new",
      }).select("id,referral_token").single();
      if (error) return json({ error: error.message }, 500);
      data = row;
    }
    const appId = data!.id;
    if (cv) {
      const safe = cv.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "CV";
      const path = `applications/${appId}/${Date.now()}-${safe}`;
      const { error: upErr } = await admin.storage.from("resumes").upload(path, cv.bytes, { contentType: cv.type, upsert: false });
      if (upErr) console.error("cv upload", appId, upErr.message);
      else await admin.from("applications").update({ resume_path: path, resume_name: cv.name }).eq("id", appId);
    }

    // Outreach "I'm interested": that prospect is now interested.
    const pt = String(body.pt || "").trim();
    if (source === "outreach" && /^[A-Za-z0-9_-]{8,64}$/.test(pt)) {
      await admin.from("prospects").update({ status: "interested" }).eq("unsub_token", pt).in("status", ["found", "approved", "queued", "contacted"]);
    }

    // Referral: let the person know who referred them and ask if they're interested.
    if (referrer && data?.referral_token) {
      try {
        const b = await loadBrand(admin);
        const m = referralEmail(b, { name, referrer: referrer.name, role: resolvedRoleTitle, slug, token: data.referral_token });
        const sent = await sendBrevo(b, { email, name }, m.subject, m.html);
        if (!sent) console.error("referral email not sent", appId);
      } catch (e) { console.error("referral email", appId, String((e as Error)?.message || e)); }
    }

    return json({ ok: true, id: appId });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
