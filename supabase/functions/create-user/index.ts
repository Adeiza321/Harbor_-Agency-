import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, sendBrevo } from "./brand.ts";
import { welcomeEmail } from "./welcome.ts";

// Admin-only account management: create, delete, set a password, and send the welcome email.
// New accounts no longer need a password: activating one sends a welcome email with a one-time
// "Set your password" link (account_setup_tokens; the account-setup function redeems it).
const PORTAL_BASE = () => (Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com").replace(/\/+$/, "");
const SETUP_HOURS = 72;
async function sha256(t: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);

    const { data: me } = await admin.from("profiles").select("role,status,full_name").eq("id", caller.user.id).single();
    if (!me || me.role !== "admin" || me.status !== "Active") return json({ error: "Only admins can manage accounts" }, 403);

    const body = await req.json();
    const action = body.action || "create";

    if (action === "create") {
      const { email, password, full_name, role } = body;
      if (!["admin", "recops", "recruiter"].includes(role)) return json({ error: "Invalid role" }, 400);
      if (!email || !String(email).includes("@")) return json({ error: "Enter a valid email" }, 400);
      // A password is optional: without one, the person sets their own from the welcome email.
      if (password && String(password).length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

      const { data, error } = await admin.auth.admin.createUser({
        email: String(email).trim().toLowerCase(),
        ...(password ? { password } : {}),
        email_confirm: true,
        user_metadata: { full_name: full_name || "" },
        app_metadata: { role },
      });
      if (error) return json({ error: error.message }, 400);

      const level = role === "admin" ? "Admin, owner" : role === "recops" ? "Rec Ops manager" : "Recruiter";
      // New accounts start "Invited": the login exists, but app_role() only grants access
      // once an admin activates them from Users and permissions (status -> "Active").
      const { error: pErr } = await admin.from("profiles")
        .update({ status: "Invited", role, level, full_name: full_name || "" }).eq("id", data.user.id);
      if (pErr) return json({ error: pErr.message }, 500);
      return json({ ok: true, id: data.user.id });
    }

    // Welcome email with a fresh one-time "Set your password" link (any earlier link stops working).
    if (action === "send_welcome") {
      const { id } = body;
      if (!id) return json({ error: "Missing id" }, 400);
      const { data: p } = await admin.from("profiles").select("id,full_name,email,role,status").eq("id", id).single();
      if (!p) return json({ error: "User not found" }, 404);
      if (p.status !== "Active") return json({ error: "Activate the account first, then send the welcome email" }, 400);
      if (!p.email) return json({ error: "This account has no email address" }, 400);
      const code = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
      const now = new Date().toISOString();
      await admin.from("account_setup_tokens").update({ used_at: now }).eq("user_id", id).is("used_at", null);
      const { error: tErr } = await admin.from("account_setup_tokens").insert({
        token_hash: await sha256(code), user_id: id, created_by: caller.user.id,
        expires_at: new Date(Date.now() + SETUP_HOURS * 3600e3).toISOString(),
      });
      if (tErr) return json({ error: tErr.message }, 500);
      const b = await loadBrand(admin);
      const m = welcomeEmail(b, { name: p.full_name || "", email: p.email, role: p.role, inviter: me.full_name || "Your admin",
        setupUrl: `${PORTAL_BASE()}/?setup=${code}`, signInUrl: PORTAL_BASE(), hours: SETUP_HOURS });
      const sent = await sendBrevo(b, { email: p.email, name: p.full_name || undefined }, m.subject, m.html);
      if (!sent) return json({ error: "The welcome email couldn't be sent. Try again in a minute." }, 502);
      await admin.from("profiles").update({ welcome_sent_at: now }).eq("id", id);
      try { await admin.from("audit_log").insert({ actor_id: caller.user.id, action: "welcome email sent", entity_type: "user", entity_id: id, detail: p.full_name || p.email }); } catch (_) { /* best effort */ }
      return json({ ok: true, to: p.email });
    }

    if (action === "delete") {
      const { id } = body;
      if (!id) return json({ error: "Missing id" }, 400);
      if (id === caller.user.id) return json({ error: "You can't delete your own account" }, 400);
      const { data: target } = await admin.from("profiles").select("is_owner,full_name").eq("id", id).single();
      if (!target) return json({ error: "User not found" }, 404);
      if (target.is_owner) return json({ error: "The owner can't be deleted. Transfer ownership first." }, 400);

      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) {
        // Postgres FK violation: this person created jobs, placements, engagements or
        // campaigns that reference their profile, so a hard delete would orphan those
        // records and is blocked at the database level. Disable them instead.
        const msg = /foreign key|violates/i.test(error.message)
          ? "Can't delete " + (target.full_name || "this user") + " — they have jobs, placements or other records tied to their account. Disable them instead."
          : error.message;
        return json({ error: msg }, 400);
      }
      return json({ ok: true });
    }

    if (action === "set_password") {
      const { id, password } = body;
      if (!id) return json({ error: "Missing id" }, 400);
      if (!password || String(password).length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
