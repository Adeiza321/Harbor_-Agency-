import { createClient } from "npm:@supabase/supabase-js@2";

// Two-factor once per browser, then every 30 days (trusted_devices / trusted_sessions, migration 20261020o).
//   remember  right after the code was entered (the caller's session is aal2): this browser gets a
//             secret, kept in its local storage; only a hash is stored here. Valid 30 days from the code.
//   use       {secret} after a password-only sign-in (aal1) on that browser: if the secret is valid
//             for this person, this session is accepted as if the code had been entered (app_role()).
// Anything wrong answers { ok: false } and the app simply asks for the code.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const DAYS = 30;
async function sha256(t: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const claims = (jwt: string) => { try { return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; } };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "That request isn't supported." }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: caller } = await admin.auth.getUser(jwt); // checks the token is real and current
    if (!caller?.user) return json({ ok: false, error: "Your session has ended. Sign in again." }, 401);
    const c = claims(jwt);
    const sessionId = String(c.session_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return json({ ok: false });
    const body = await req.json().catch(() => ({}));
    const now = new Date();

    if (body.action === "remember") {
      if (c.aal !== "aal2") return json({ ok: false, error: "Enter your two-factor code first." }, 403);
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
      const expires = new Date(now.getTime() + DAYS * 864e5).toISOString();
      // An earlier secret from this browser is replaced, so each browser has one.
      if (/^[0-9a-f]{64}$/.test(String(body.previous || ""))) await admin.from("trusted_devices").delete().eq("token_hash", await sha256(String(body.previous))).eq("user_id", caller.user.id);
      const { data: dev, error } = await admin.from("trusted_devices").insert({ user_id: caller.user.id, token_hash: await sha256(secret), user_agent: String(req.headers.get("user-agent") || "").slice(0, 200), expires_at: expires }).select("id").single();
      if (error || !dev) return json({ ok: false });
      await admin.from("trusted_sessions").upsert({ session_id: sessionId, user_id: caller.user.id, device_id: dev.id, expires_at: expires });
      // Tidy up: expired browsers and sessions.
      await admin.from("trusted_devices").delete().lt("expires_at", now.toISOString());
      await admin.from("trusted_sessions").delete().lt("expires_at", now.toISOString());
      return json({ ok: true, secret, expiresAt: expires });
    }

    if (body.action === "use") {
      const secret = String(body.secret || "");
      if (!/^[0-9a-f]{64}$/.test(secret)) return json({ ok: false });
      const { data: dev } = await admin.from("trusted_devices").select("id,user_id,expires_at").eq("token_hash", await sha256(secret)).maybeSingle();
      if (!dev || dev.user_id !== caller.user.id || new Date(dev.expires_at) <= now) return json({ ok: false });
      await admin.from("trusted_sessions").upsert({ session_id: sessionId, user_id: dev.user_id, device_id: dev.id, expires_at: dev.expires_at });
      await admin.from("trusted_devices").update({ last_used_at: now.toISOString() }).eq("id", dev.id);
      return json({ ok: true, expiresAt: dev.expires_at });
    }

    return json({ error: "That request isn't supported." }, 400);
  } catch (e) {
    console.error("trust-device", String((e as Error)?.message || e));
    return json({ ok: false });
  }
});
