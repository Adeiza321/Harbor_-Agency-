import { createClient } from "npm:@supabase/supabase-js@2";

// Called by the client right after a successful sign-in. The first sign-in of an Invited account
// makes it Active (the welcome email went out when the account was added). Reads the caller's IP from the
// request headers (the browser can't learn its own public IP reliably), looks up an
// approximate location for it, and records both on the profile -- visible only to admins via
// RLS on profile_security -- plus a 'login' row in audit_log for the per-user activity feed.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function geolocate(ip: string): Promise<string> {
  if (!ip || ip === "127.0.0.1" || ip.startsWith("192.168.") || ip.startsWith("10.")) return "";
  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return "";
    const d = await res.json();
    if (d?.error) return "";
    return [d.city, d.region, d.country_name].filter(Boolean).join(", ").slice(0, 200);
  } catch { return ""; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Your session has ended. Sign in again." }, 401);

    // First sign-in: an Invited account becomes Active by itself (a Disabled one never does).
    const { data: prof } = await admin.from("profiles").select("status").eq("id", caller.user.id).maybeSingle();
    let activated = false;
    if (prof?.status === "Invited") {
      const { data: up } = await admin.from("profiles").update({ status: "Active" }).eq("id", caller.user.id).eq("status", "Invited").select("id");
      activated = !!(up && up.length);
      if (activated) { try { await admin.from("audit_log").insert({ actor_id: caller.user.id, action: "account activated on first sign-in", entity_type: "profile", entity_id: caller.user.id }); } catch (_) { /* best effort */ } }
    }
    const body = await req.json().catch(() => ({}));
    if (body?.activateOnly) return json({ ok: true, activated, status: activated ? "Active" : prof?.status || null });

    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
    const location = await geolocate(ip);
    const now = new Date().toISOString();

    await admin.from("profile_security").upsert({ user_id: caller.user.id, last_ip: ip || null, last_location: location || null, last_login_at: now, updated_at: now });
    await admin.from("audit_log").insert({ actor_id: caller.user.id, action: "login", entity_type: "session", entity_id: caller.user.id, detail: [ip, location].filter(Boolean).join(" · ") || null });

    return json({ ok: true, ip, location, activated });
  } catch (e) {
    console.error("record-login", String((e as Error)?.message || e));
    return json({ error: "Something went wrong on our side. Try again in a minute." }, 500);
  }
});
