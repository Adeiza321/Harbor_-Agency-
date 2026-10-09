import { createClient } from "npm:@supabase/supabase-js@2";

// Public: redeems the one-time "Set your password" link from the welcome email (/?setup=<code>).
//   check {token}            -> { ok, name, email } while the link is valid
//   set   {token, password}  -> sets the password and uses up the link
// Only a hash of the code is stored (account_setup_tokens); links expire after 72 hours.

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
const EXPIRED = "This link has expired or has already been used. Ask your admin to send a new welcome email.";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "");
    if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: EXPIRED }, 400);
    const hash = await sha256(token);
    const nowIso = new Date().toISOString();

    if (body.action === "check") {
      const { data: t } = await admin.from("account_setup_tokens").select("user_id").eq("token_hash", hash).is("used_at", null).gt("expires_at", nowIso).maybeSingle();
      if (!t) return json({ error: EXPIRED }, 400);
      const { data: p } = await admin.from("profiles").select("full_name,email,status").eq("id", t.user_id).maybeSingle();
      if (!p || p.status !== "Active") return json({ error: "This account isn't active. Ask your admin." }, 400);
      return json({ ok: true, name: p.full_name || "", email: p.email || "" });
    }

    if (body.action === "set") {
      const password = String(body.password || "");
      if (password.length < 8) return json({ error: "Use at least 8 characters" }, 400);
      if (password.length > 128) return json({ error: "That password is too long" }, 400);
      // Use the link up first, so it can only ever work once.
      const { data: used } = await admin.from("account_setup_tokens").update({ used_at: nowIso })
        .eq("token_hash", hash).is("used_at", null).gt("expires_at", nowIso).select("user_id").maybeSingle();
      if (!used) return json({ error: EXPIRED }, 400);
      const { data: p } = await admin.from("profiles").select("email,status").eq("id", used.user_id).maybeSingle();
      if (!p || p.status !== "Active") return json({ error: "This account isn't active. Ask your admin." }, 400);
      const { error } = await admin.auth.admin.updateUserById(used.user_id, { password });
      if (error) {
        await admin.from("account_setup_tokens").update({ used_at: null }).eq("token_hash", hash);
        return json({ error: /weak|pwned|leak/i.test(error.message) ? "That password is too common or has appeared in a data breach. Choose another." : error.message }, 400);
      }
      try { await admin.from("audit_log").insert({ actor_id: used.user_id, action: "password set from welcome email", entity_type: "profile", entity_id: used.user_id }); } catch (_) { /* best effort */ }
      return json({ ok: true, email: p.email || "" });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
