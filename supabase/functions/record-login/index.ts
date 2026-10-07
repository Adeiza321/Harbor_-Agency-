import { createClient } from "npm:@supabase/supabase-js@2";

// Called by the client right after a successful sign-in. Reads the caller's IP from the
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
    if (!caller?.user) return json({ error: "Not signed in" }, 401);

    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
    const location = await geolocate(ip);
    const now = new Date().toISOString();

    await admin.from("profile_security").upsert({ user_id: caller.user.id, last_ip: ip || null, last_location: location || null, last_login_at: now, updated_at: now });
    await admin.from("audit_log").insert({ actor_id: caller.user.id, action: "login", entity_type: "session", entity_id: caller.user.id, detail: [ip, location].filter(Boolean).join(" · ") || null });

    return json({ ok: true, ip, location });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
