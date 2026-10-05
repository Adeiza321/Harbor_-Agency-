import { createClient } from "npm:@supabase/supabase-js@2";

// Public, unauthenticated endpoint: the front door for every inbound source (a future
// public job page, a paste-in from Indeed/LinkedIn, a manual entry tool, a webhook from a
// job board) to land a candidate in Harbor's existing Inbox (`applications` table), which
// already has a UI for recruiters to claim and promote into a real `candidates` row.
//
// This is deliberately the ONLY writer of unauthenticated data: it validates, rate-limits
// by simple dedupe, and uses the service role to get past RLS (applications is staff-only
// otherwise) so no other part of the surface area needs to be opened up.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SOURCES = ["career_page", "linkedin", "indeed", "google_jobs", "facebook", "referral", "manual"];

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

    if (!name || name.length > 200) return json({ error: "Enter a valid name" }, 400);
    if (!email || !email.includes("@") || email.length > 320) return json({ error: "Enter a valid email" }, 400);

    // Resolve the job either by id or by its public link_slug (what a job page URL carries).
    let resolvedJobId: string | null = null;
    let resolvedRoleTitle = roleTitle;
    if (jobId || linkSlug) {
      const q = admin.from("jobs").select("id,role_title,status").limit(1);
      const { data: job } = jobId ? await q.eq("id", jobId).single() : await q.eq("link_slug", linkSlug).single();
      if (!job) return json({ error: "That role could not be found" }, 404);
      if (job.status === "Closed") return json({ error: "This role is no longer accepting applications" }, 400);
      if (job.status === "On hold") return json({ error: "This role is paused and isn't taking applications right now. Please check back soon." }, 400);
      resolvedJobId = job.id;
      resolvedRoleTitle = job.role_title;
    }
    if (!resolvedRoleTitle) return json({ error: "Missing role" }, 400);

    // Dedupe: the same person applying twice to the same role (double form submit, a
    // platform resending the same lead) should not create a second Inbox row. Keyed on
    // email when we have it (more reliable than name), name otherwise.
    if (resolvedJobId) {
      const dupeQuery = admin.from("applications").select("id").eq("job_id", resolvedJobId).limit(1);
      const { data: existing } = email
        ? await dupeQuery.ilike("email", email)
        : await dupeQuery.ilike("name", name);
      if (existing && existing.length) return json({ ok: true, duplicate: true });
    }

    const { data, error } = await admin.from("applications").insert({
      name,
      email: email || null,
      phone: phone || null,
      role_title: resolvedRoleTitle,
      source,
      job_id: resolvedJobId,
    }).select("id").single();
    if (error) return json({ error: error.message }, 500);

    return json({ ok: true, id: data.id });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
