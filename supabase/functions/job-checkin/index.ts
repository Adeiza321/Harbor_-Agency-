import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, emailShell, button, esc, sendBrevo } from "./brand.ts";

// "Ask for an update" on a job (job_checkins).
//   send   {jobId, subject, message, recruiterIds?}  Admin / Rec Ops: emails the recruiters engaged on
//          the role (or the ones picked) asking how sourcing is going. {first}, {role} and {client} in
//          the subject or message are filled in per recruiter.
//   check  {token}                                   public: what the one-time link is for
//   answer {token | checkinId, progress, candidates?, issues?, reply?}
//          the recruiter's answer, from the email link (token, no sign-in) or the job page (checkinId,
//          signed in as that recruiter). It shows on the job and is emailed to whoever asked.
// Every error is a plain sentence the app can show as it is.

const APP_URL = () => (Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com").replace(/\/+$/, "");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
async function sha256(t: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const PROGRESS: Record<string, string> = { on_track: "Going well", slow: "Slower than hoped", stuck: "Stuck, needs help" };
const LINK_GONE = "This update link has expired or was already used. Open the job in ProNext to send your update.";
const fill = (t: string, v: Record<string, string>) => String(t || "").replace(/\{(first|role|client)\}/g, (_, k) => v[k] || "");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "That request isn't supported." }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const caller = async () => {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data } = await admin.auth.getUser(token);
      if (!data?.user) return null;
      const { data: me } = await admin.from("profiles").select("id,role,status,full_name,email").eq("id", data.user.id).maybeSingle();
      return me && me.status === "Active" ? me : null;
    };

    if (action === "send") {
      const me = await caller();
      if (!me) return json({ error: "Your session has ended. Sign in again." }, 401);
      if (!["admin", "recops"].includes(me.role)) return json({ error: "Only Admins and Rec Ops can ask recruiters for an update." }, 403);
      const jobId = String(body.jobId || "");
      const subject = String(body.subject || "").trim().slice(0, 200);
      const message = String(body.message || "").trim().slice(0, 4000);
      if (!subject || !message) return json({ error: "Add a subject and a message first." }, 400);
      const { data: job } = await admin.from("jobs").select("id,role_title,client").eq("id", jobId).maybeSingle();
      if (!job) return json({ error: "We couldn't find this job. Refresh the page and try again." }, 404);
      // Who's on it now: open engagements plus the job's current recruiter list.
      const [{ data: eng }, { data: jr }] = await Promise.all([
        admin.from("job_engagements").select("recruiter_id").eq("job_id", jobId).is("disengaged_at", null),
        admin.from("job_recruiters").select("recruiter_id").eq("job_id", jobId),
      ]);
      let ids = [...new Set([...(eng || []), ...(jr || [])].map((r: any) => r.recruiter_id).filter(Boolean))] as string[];
      const picked = Array.isArray(body.recruiterIds) ? body.recruiterIds.map(String) : null;
      if (picked && picked.length) ids = ids.filter((id) => picked.includes(id));
      ids = ids.filter((id) => id !== me.id);
      if (!ids.length) return json({ error: "Nobody is engaged on this role right now, so there's no one to ask." }, 400);
      const { data: people } = await admin.from("profiles").select("id,full_name,email,status").in("id", ids);
      const brand = await loadBrand(admin);
      const sent: string[] = [], failed: string[] = [];
      for (const p of (people || []) as any[]) {
        if (!p.email || p.status !== "Active") { failed.push(p.full_name || "A recruiter"); continue; }
        const vars = { first: String(p.full_name || "").trim().split(/\s+/)[0] || "there", role: job.role_title || "this role", client: job.client || "" };
        const subj = fill(subject, vars), msg = fill(message, vars);
        const code = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
        const { data: row, error } = await admin.from("job_checkins").insert({ job_id: jobId, recruiter_id: p.id, sent_by: me.id, subject: subj, message: msg, token_hash: await sha256(code) }).select("id").single();
        if (error || !row) { failed.push(p.full_name || p.email); continue; }
        const html = emailShell(brand, subj,
          `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#14201B;white-space:pre-wrap;">${esc(msg)}</div>
           <div style="margin-top:16px;padding:12px 14px;background:#F6F4EE;border-radius:10px;font-family:Arial,sans-serif;font-size:13px;color:#56605A;">Role: <b style="color:#14201B;">${esc(job.role_title)}${job.client ? " at " + esc(job.client) : ""}</b></div>
           ${button(brand, `${APP_URL()}/?checkin=${code}`, "Send your update")}
           <div style="font-family:Arial,sans-serif;font-size:12px;color:#8A8578;margin-top:12px;">It takes under a minute. The link works once and expires in 14 days; you can also answer on the job page in ProNext.</div>`,
          `You're receiving this because ${me.full_name || "your Rec Ops team"} asked for an update on a role you're engaged on at ${brand.legal || brand.name}.`);
        const ok = await sendBrevo(brand, { email: p.email, name: p.full_name || undefined }, subj, html);
        if (ok) sent.push(p.full_name || p.email);
        else { failed.push(p.full_name || p.email); await admin.from("job_checkins").delete().eq("id", row.id); }
      }
      try { await admin.from("audit_log").insert({ actor_id: me.id, action: "asked for an update", entity_type: "job", entity_id: jobId, detail: sent.join(", ") || null }); } catch (_) { /* best effort */ }
      if (!sent.length) return json({ error: "The update request couldn't be sent. Try again in a minute." }, 502);
      return json({ ok: true, sent, failed });
    }

    // Find the check-in from the email link, or from the job page for the signed-in recruiter.
    const find = async (): Promise<{ row?: any; error?: string; status?: number }> => {
      if (body.token) {
        const token = String(body.token);
        if (!/^[0-9a-f]{64}$/.test(token)) return { error: LINK_GONE, status: 400 };
        const { data } = await admin.from("job_checkins").select("*").eq("token_hash", await sha256(token)).maybeSingle();
        if (!data || data.answered_at || new Date(data.expires_at) < new Date()) return { error: LINK_GONE, status: 400 };
        return { row: data };
      }
      const me = await caller();
      if (!me) return { error: "Your session has ended. Sign in again.", status: 401 };
      const { data } = await admin.from("job_checkins").select("*").eq("id", String(body.checkinId || "")).maybeSingle();
      if (!data || data.recruiter_id !== me.id) return { error: "We couldn't find this update request.", status: 404 };
      if (data.answered_at) return { error: "You've already answered this update request.", status: 400 };
      return { row: data };
    };

    if (action === "check") {
      const f = await find();
      if (!f.row) return json({ error: f.error }, f.status || 400);
      const [{ data: job }, { data: rec }, { data: asker }] = await Promise.all([
        admin.from("jobs").select("role_title,client").eq("id", f.row.job_id).maybeSingle(),
        admin.from("profiles").select("full_name").eq("id", f.row.recruiter_id).maybeSingle(),
        f.row.sent_by ? admin.from("profiles").select("full_name").eq("id", f.row.sent_by).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      return json({ ok: true, role: job?.role_title || "", client: job?.client || "", name: rec?.full_name || "", askedBy: (asker as any)?.full_name || "", message: f.row.message });
    }

    if (action === "answer") {
      const f = await find();
      if (!f.row) return json({ error: f.error }, f.status || 400);
      const progress = String(body.progress || "");
      if (!PROGRESS[progress]) return json({ error: "Choose how sourcing is going first." }, 400);
      const n = body.candidates === "" || body.candidates == null ? null : Math.max(0, Math.min(999, Math.round(Number(body.candidates))));
      const issues = String(body.issues || "").trim().slice(0, 2000) || null;
      const reply = String(body.reply || "").trim().slice(0, 2000) || null;
      if (progress === "stuck" && !issues) return json({ error: "Tell us what's in your way, so we can help." }, 400);
      const { data: done } = await admin.from("job_checkins").update({ answered_at: new Date().toISOString(), progress, candidates_in_progress: Number.isFinite(n as number) ? n : null, issues, reply, token_hash: null })
        .eq("id", f.row.id).is("answered_at", null).select("id").maybeSingle();
      if (!done) return json({ error: "This update was already sent." }, 400);
      // Let whoever asked know.
      try {
        const [{ data: job }, { data: rec }, { data: asker }] = await Promise.all([
          admin.from("jobs").select("role_title,client").eq("id", f.row.job_id).maybeSingle(),
          admin.from("profiles").select("full_name").eq("id", f.row.recruiter_id).maybeSingle(),
          f.row.sent_by ? admin.from("profiles").select("full_name,email,status").eq("id", f.row.sent_by).maybeSingle() : Promise.resolve({ data: null }),
        ]);
        const a = asker as any;
        if (a?.email && a.status === "Active") {
          const brand = await loadBrand(admin);
          const who = rec?.full_name || "A recruiter";
          const subj = `${who}'s update on ${job?.role_title || "a role"}: ${PROGRESS[progress]}`;
          const line = (l: string, v: string | null) => (v ? `<div style="margin-top:10px;"><div style="font-size:11px;letter-spacing:1px;font-weight:700;color:#56605A;">${esc(l)}</div><div style="font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(v)}</div></div>` : "");
          const html = emailShell(brand, subj,
            `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;"><b>${esc(who)}</b> answered your update request on <b>${esc(job?.role_title || "")}${job?.client ? " at " + esc(job.client) : ""}</b>.</div>
             <div style="font-family:Arial,sans-serif;margin-top:8px;">${line("HOW IT'S GOING", PROGRESS[progress])}${line("CANDIDATES IN PROGRESS", n == null ? null : String(n))}${line("ISSUES", issues)}${line("ANYTHING ELSE", reply)}</div>
             ${button(brand, `${APP_URL()}/?page=jobs`, "Open the job in ProNext")}`,
            `You're receiving this because you asked for an update in ${brand.name}.`);
          await sendBrevo(brand, { email: a.email, name: a.full_name || undefined }, subj, html);
        }
      } catch (e) { console.error("job-checkin notify", String((e as Error)?.message || e)); }
      return json({ ok: true });
    }

    return json({ error: "That request isn't supported." }, 400);
  } catch (e) {
    console.error("job-checkin", String((e as Error)?.message || e));
    return json({ error: "Something went wrong on our side. Try again in a minute." }, 500);
  }
});
