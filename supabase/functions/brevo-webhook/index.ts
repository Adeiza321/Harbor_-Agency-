import { createClient } from "npm:@supabase/supabase-js@2";
import { storeEvents, toRow } from "./events.ts";

// Brevo's transactional webhook: every email event (sent, delivered, opened, clicked, bounced,
// spam, unsubscribed...) is pushed here as it happens and stored in public.email_events, which the
// Email tracking page reads. Set it up in Brevo > Transactional > Settings > Webhook with the URL
//   https://<project>.supabase.co/functions/v1/brevo-webhook?token=<vault secret brevo_webhook_token>
// Accepts one event or a batch (a JSON array). Runs without a login (verify_jwt off); the token
// in the URL is the check. Nothing is sent back to Brevo except "ok".

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: true });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = new URL(req.url).searchParams.get("token") || "";
    const { data: ok } = await admin.rpc("check_brevo_webhook", { p_token: token });
    if (!ok) return json({ error: "Invalid token" }, 401);
    const body = await req.json().catch(() => null);
    const list = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : body ? [body] : [];
    const rows = list.slice(0, 5000).map((e: any) => toRow(e, "webhook")).filter(Boolean) as any[];
    if (rows.length) await storeEvents(admin, rows);
    return json({ ok: true, stored: rows.length });
  } catch (e) {
    console.error("brevo webhook", String((e as Error)?.message || e));
    // A 5xx makes Brevo retry later, which is what we want if the database was briefly unavailable.
    return json({ error: "Couldn't store the event" }, 500);
  }
});
