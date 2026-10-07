import { createClient } from "npm:@supabase/supabase-js@2";

// Delivery result of the emails that carry recruiter chat messages to candidates.
// Called every minute by the database (cron "harbor-email-status", ops token). For each message
// still marked 'sent', asks Brevo for the events of its email:
//   delivered (or later opened / clicked / marked as spam, which also means it arrived) -> 'delivered'
//   hard bounce, blocked, invalid address, error                                       -> 'bounced'
//   soft bounce with no delivery after 24 hours                                        -> 'bounced'
// The chat shows two ticks for delivered and one red tick for bounced.

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const DELIVERED = new Set(["delivered", "opened", "clicks", "click", "spam", "loadedByProxy", "unique_opened"]);
const HARD = new Set(["hardBounces", "hard_bounce", "blocked", "invalid", "error", "invalid_email"]);
const SOFT = new Set(["softBounces", "soft_bounce"]);
const REASON: Record<string, string> = {
  hardBounces: "The email address doesn't exist or refused the email", hard_bounce: "The email address doesn't exist or refused the email",
  blocked: "The email was blocked", invalid: "The email address isn't valid", invalid_email: "The email address isn't valid",
  error: "The email couldn't be sent", softBounces: "The inbox kept refusing the email (full or unavailable)", soft_bounce: "The inbox kept refusing the email (full or unavailable)",
};

Deno.serve(async (req: Request) => {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const opsKey = req.headers.get("x-harbor-ops") || "";
    const { data: tok } = opsKey.length >= 32
      ? await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle()
      : { data: null };
    if (!tok) return json({ error: "Not allowed" }, 403);
    const key = Deno.env.get("BREVO_API_KEY");
    if (!key) return json({ error: "BREVO_API_KEY is not set" }, 400);

    const since = new Date(Date.now() - 3 * 864e5).toISOString();
    const { data: rows } = await admin.from("candidate_job_messages").select("id,email_message_id,created_at")
      .eq("email_status", "sent").gt("created_at", since).order("created_at").limit(40);
    let delivered = 0, bounced = 0, waiting = 0;
    for (const m of rows || []) {
      if (!m.email_message_id) continue;
      const r = await fetch("https://api.brevo.com/v3/smtp/statistics/events?limit=50&sort=desc&messageId=" + encodeURIComponent(m.email_message_id),
        { headers: { "api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (!r || !r.ok) { waiting++; continue; }
      const j = await r.json().catch(() => ({}));
      const events: string[] = (j.events || []).map((e: any) => String(e.event || ""));
      const now = new Date().toISOString();
      if (events.some((e) => DELIVERED.has(e))) {
        await admin.from("candidate_job_messages").update({ email_status: "delivered", email_status_at: now, email_error: null }).eq("id", m.id);
        delivered++;
      } else if (events.some((e) => HARD.has(e)) || (events.some((e) => SOFT.has(e)) && Date.now() - new Date(m.created_at).getTime() > 864e5)) {
        const ev = events.find((e) => HARD.has(e)) || events.find((e) => SOFT.has(e)) || "error";
        const detail = (j.events || []).find((e: any) => e.event === ev)?.reason;
        await admin.from("candidate_job_messages").update({ email_status: "bounced", email_status_at: now, email_error: String(detail || REASON[ev] || "The email bounced").slice(0, 300) }).eq("id", m.id);
        bounced++;
      } else waiting++;
    }
    return json({ ok: true, checked: (rows || []).length, delivered, bounced, waiting });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
