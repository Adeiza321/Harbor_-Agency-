import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, sendBrevo } from "./brand.ts";
import { referralEmail } from "./referral.ts";
import { assignApplication } from "./assign.ts";

// Inbox: applications that came in through the apply page (or outreach "interested" clicks).
// Rec Ops and Admins only.
//   cv       10-minute link to the CV the applicant uploaded
//   assign   turn the application into a candidate for a recruiter: reuse the candidate with the
//            same email if there is one, copy the CV over, put them on the job (which starts the
//            automatic AI screening) and record it on their timeline
//   dismiss  not suitable / spam; restore puts it back in New
//   reassign give an assigned application (and its candidate) to someone else
//   unassign put an assigned application back in New (the candidate is kept, without a recruiter)
//   followup remind someone who was referred (at most 2 reminders, a day apart). A referral
//            can't be assigned until they've said they're interested.
//   delete   remove the application from the Inbox for good, with the CV uploaded with it. A
//            candidate it was assigned to keeps their profile and their own copy of the CV.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("id,role,status,full_name").eq("id", caller.user.id).single();
    if (!me || me.status !== "Active") return json({ error: "Your account is not active" }, 403);
    if (me.role !== "admin" && me.role !== "recops") return json({ error: "Only Rec Ops or Admins can manage the Inbox" }, 403);

    const body = await req.json().catch(() => ({}));
    const { data: app } = await admin.from("applications").select("*").eq("id", String(body.applicationId || "")).maybeSingle();
    if (!app) return json({ error: "That application could not be found" }, 404);
    const now = new Date().toISOString();

    if (body.action === "cv") {
      if (!app.resume_path) return json({ error: "No CV was uploaded with this application" }, 404);
      const { data: s, error } = await admin.storage.from("resumes").createSignedUrl(app.resume_path, 600);
      if (error || !s) return json({ error: error?.message || "Couldn't open the CV" }, 500);
      return json({ ok: true, url: s.signedUrl });
    }

    if (body.action === "dismiss" || body.action === "restore") {
      if (body.action === "dismiss" && app.status !== "new") return json({ error: "This application was already handled" }, 409);
      if (body.action === "restore" && app.status !== "dismissed") return json({ error: "Only dismissed applications can be restored" }, 409);
      const patch = body.action === "dismiss"
        ? { status: "dismissed", handled_at: now, handled_by: me.id, note: String(body.note || "").trim().slice(0, 500) || null }
        : { status: "new", handled_at: null, handled_by: null, note: null };
      await admin.from("applications").update(patch).eq("id", app.id);
      return json({ ok: true });
    }

    if (body.action === "delete") {
      // The CV goes too, unless a candidate still points at this exact file (their copy normally lives
      // in their own folder, made when the application was assigned).
      if (app.resume_path) {
        const { count } = await admin.from("candidates").select("id", { count: "exact", head: true }).eq("resume_path", app.resume_path);
        if (!count) await admin.storage.from("resumes").remove([app.resume_path]).then(() => {}, () => {});
      }
      const { error } = await admin.from("applications").delete().eq("id", app.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    const timeline = (candidateId: string, title: string) => admin.from("candidate_timeline").insert({ candidate_id: candidateId, title, done: true }).then(() => {}, () => {});

    if (body.action === "followup") {
      if (app.source !== "referral" || !app.referral_token) return json({ error: "Only referrals get follow-ups" }, 400);
      if (app.interest_at) return json({ error: "They've already said they're interested" }, 409);
      if (app.status !== "new") return json({ error: "This referral was already handled" }, 409);
      if ((app.followups || 0) >= 2) return json({ error: "Two follow-ups have already been sent" }, 409);
      const lastAt = new Date(app.last_followup_at || app.created_at).getTime();
      if (Date.now() - lastAt < 24 * 3600e3) return json({ error: "Wait a day after the last email before following up" }, 409);
      const { data: job } = app.job_id ? await admin.from("jobs").select("link_slug,role_title").eq("id", app.job_id).maybeSingle() : { data: null };
      const b = await loadBrand(admin);
      const m = referralEmail(b, { name: app.name, referrer: app.referrer?.name || "A friend", role: job?.role_title || app.role_title, slug: job?.link_slug || null, token: app.referral_token, followup: true });
      if (!(await sendBrevo(b, { email: app.email, name: app.name }, m.subject, m.html))) return json({ error: "The email couldn't be sent. Please try again." }, 502);
      await admin.from("applications").update({ followups: (app.followups || 0) + 1, last_followup_at: now }).eq("id", app.id);
      return json({ ok: true, followups: (app.followups || 0) + 1 });
    }

    if (body.action === "unassign") {
      if (app.status !== "assigned") return json({ error: "This application isn't assigned" }, 409);
      if (app.candidate_id) {
        await admin.from("candidates").update({ recruiter_id: null }).eq("id", app.candidate_id).eq("recruiter_id", app.assigned_to);
        await timeline(app.candidate_id, "Unassigned from the Inbox by " + (me.full_name || "Rec Ops"));
      }
      await admin.from("applications").update({ status: "new", assigned_to: null, handled_at: null, handled_by: null }).eq("id", app.id);
      return json({ ok: true });
    }

    const { data: rec } = await admin.from("profiles").select("id,full_name,status").eq("id", String(body.recruiterId || "")).maybeSingle();
    if (!rec || rec.status !== "Active") return json({ error: "Pick an active team member" }, 400);

    if (body.action === "reassign") {
      if (app.status !== "assigned") return json({ error: "Only assigned applications can be reassigned" }, 409);
      if (app.assigned_to === rec.id) return json({ error: "It's already assigned to " + (rec.full_name || "them") }, 409);
      if (app.candidate_id) {
        await admin.from("candidates").update({ recruiter_id: rec.id }).eq("id", app.candidate_id);
        await timeline(app.candidate_id, "Reassigned to " + (rec.full_name || "a recruiter") + " by " + (me.full_name || "Rec Ops"));
      }
      await admin.from("applications").update({ assigned_to: rec.id, handled_at: now, handled_by: me.id }).eq("id", app.id);
      return json({ ok: true, candidateId: app.candidate_id });
    }

    if (body.action !== "assign") return json({ error: "Unknown action" }, 400);
    if (app.status !== "new") return json({ error: "This application was already handled" }, 409);
    if (app.source === "referral" && !app.interest_at) return json({ error: "Waiting for them to say they're interested. Send a follow-up, or wait for their reply." }, 409);

    const r = await assignApplication(admin, app, rec, { id: me.id, name: me.full_name || "Rec Ops" });
    return json({ ok: true, ...r });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
