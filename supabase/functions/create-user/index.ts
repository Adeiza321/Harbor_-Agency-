import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, sendBrevo } from "./brand.ts";
import { welcomeEmail } from "./welcome.ts";

// Admin-only account management: create, delete, set a password, and send the welcome email.
// Adding someone sends the welcome email straight away, with a one-time "Set your password" link
// (account_setup_tokens; the account-setup function redeems it). The account is "Invited" until the
// person signs in for the first time, which makes it Active on its own (account-setup / record-login).
const PORTAL_BASE = () => (Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com").replace(/\/+$/, "");
const SETUP_HOURS = 72;
async function sha256(t: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Sends the welcome email with a fresh one-time "Set your password" link (any earlier link stops working).
// Works for Invited (not signed in yet) and Active accounts; never for a disabled one.
async function sendWelcome(admin: any, id: string, callerId: string, inviter: string): Promise<{ ok: boolean; to?: string; error?: string; status?: number }> {
  const { data: p } = await admin.from("profiles").select("id,full_name,email,role,status").eq("id", id).single();
  if (!p) return { ok: false, error: "We couldn't find that account.", status: 404 };
  if (p.status === "Disabled") return { ok: false, error: "This account is turned off. Turn it back on first, then send the welcome email." };
  if (!p.email) return { ok: false, error: "This account has no email address." };
  const code = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = new Date().toISOString();
  await admin.from("account_setup_tokens").update({ used_at: now }).eq("user_id", id).is("used_at", null);
  const { error: tErr } = await admin.from("account_setup_tokens").insert({
    token_hash: await sha256(code), user_id: id, created_by: callerId,
    expires_at: new Date(Date.now() + SETUP_HOURS * 3600e3).toISOString(),
  });
  if (tErr) return { ok: false, error: "We couldn't create the sign-in link. Try again in a minute.", status: 500 };
  const b = await loadBrand(admin);
  const m = welcomeEmail(b, { name: p.full_name || "", email: p.email, role: p.role, inviter,
    setupUrl: `${PORTAL_BASE()}/?setup=${code}`, signInUrl: PORTAL_BASE(), hours: SETUP_HOURS });
  const sent = await sendBrevo(b, { email: p.email, name: p.full_name || undefined }, m.subject, m.html);
  if (!sent) return { ok: false, error: "The welcome email couldn't be sent. Try again in a minute.", status: 502 };
  await admin.from("profiles").update({ welcome_sent_at: now }).eq("id", id);
  try { await admin.from("audit_log").insert({ actor_id: callerId, action: "welcome email sent", entity_type: "user", entity_id: id, detail: p.full_name || p.email }); } catch (_) { /* best effort */ }
  return { ok: true, to: p.email };
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
    if (!caller?.user) return json({ error: "Your session has ended. Sign in again." }, 401);

    const { data: me } = await admin.from("profiles").select("role,status,full_name").eq("id", caller.user.id).single();
    if (!me || me.role !== "admin" || me.status !== "Active") return json({ error: "Only admins can add or change team accounts." }, 403);

    const body = await req.json();
    const action = body.action || "create";

    if (action === "create") {
      const { email, password, full_name, role } = body;
      if (!["admin", "recops", "recruiter"].includes(role)) return json({ error: "Choose a role: Admin, Rec Ops or Recruiter." }, 400);
      if (!email || !String(email).includes("@")) return json({ error: "Enter a valid email address." }, 400);
      // A password is optional: without one, the person sets their own from the welcome email.
      if (password && String(password).length < 8) return json({ error: "The password needs at least 8 characters." }, 400);

      const { data, error } = await admin.auth.admin.createUser({
        email: String(email).trim().toLowerCase(),
        ...(password ? { password } : {}),
        email_confirm: true,
        user_metadata: { full_name: full_name || "" },
        app_metadata: { role },
      });
      if (error) return json({ error: /already|registered|exists/i.test(error.message) ? "Someone with this email address already has an account." : "We couldn't create the account. Check the email address and try again." }, 400);

      const level = role === "admin" ? "Admin, owner" : role === "recops" ? "Rec Ops manager" : "Recruiter";
      // New accounts start "Invited": the login exists, but app_role() only grants access once
      // they're Active, which happens by itself the first time they sign in.
      const { error: pErr } = await admin.from("profiles")
        .update({ status: "Invited", role, level, full_name: full_name || "" }).eq("id", data.user.id);
      if (pErr) return json({ error: "The account was created but its details couldn't be saved. Try again." }, 500);
      // The welcome email goes out straight away; they become Active the first time they sign in.
      const w = await sendWelcome(admin, data.user.id, caller.user.id, me.full_name || "Your admin");
      return json({ ok: true, id: data.user.id, welcomed: w.ok, to: w.to, welcome_error: w.ok ? undefined : w.error });
    }

    // Welcome email with a fresh one-time "Set your password" link (any earlier link stops working).
    if (action === "send_welcome") {
      const { id } = body;
      if (!id) return json({ error: "Choose who to send the welcome email to." }, 400);
      const w = await sendWelcome(admin, id, caller.user.id, me.full_name || "Your admin");
      if (!w.ok) return json({ error: w.error }, w.status || 400);
      return json({ ok: true, to: w.to });
    }

    // Two-factor: who has it on (Users and permissions), and turning it off for someone who lost their phone.
    if (action === "mfa_status") {
      const on: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) return json({ error: "We couldn't check two-factor right now. Try again in a minute." }, 500);
        for (const u of data.users || []) if ((u.factors || []).some((f: any) => f.status === "verified")) on.push(u.id);
        if ((data.users || []).length < 200) break;
      }
      return json({ ok: true, on });
    }
    if (action === "reset_mfa") {
      const { id } = body;
      if (!id) return json({ error: "Choose an account first." }, 400);
      const { data: list, error } = await admin.auth.admin.mfa.listFactors({ userId: id });
      if (error) return json({ error: "We couldn't turn off two-factor for this account. Try again in a minute." }, 500);
      for (const f of list?.factors || []) await admin.auth.admin.mfa.deleteFactor({ userId: id, id: f.id });
      try { await admin.from("audit_log").insert({ actor_id: caller.user.id, action: "two-factor turned off by an admin", entity_type: "user", entity_id: id }); } catch (_) { /* best effort */ }
      return json({ ok: true, removed: (list?.factors || []).length });
    }

    if (action === "delete") {
      const { id } = body;
      if (!id) return json({ error: "Choose an account first." }, 400);
      if (id === caller.user.id) return json({ error: "You can't delete your own account" }, 400);
      const { data: target } = await admin.from("profiles").select("is_owner,full_name").eq("id", id).single();
      if (!target) return json({ error: "We couldn't find that account." }, 404);
      if (target.is_owner) return json({ error: "The owner can't be deleted. Transfer ownership first." }, 400);

      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) {
        // Postgres FK violation: this person created jobs, placements, engagements or
        // campaigns that reference their profile, so a hard delete would orphan those
        // records and is blocked at the database level. Disable them instead.
        const msg = /foreign key|violates/i.test(error.message)
          ? "Can't delete " + (target.full_name || "this user") + " — they have jobs, placements or other records tied to their account. Disable them instead."
          : "We couldn't delete this account. Try again, or disable it instead.";
        return json({ error: msg }, 400);
      }
      return json({ ok: true });
    }

    if (action === "set_password") {
      const { id, password } = body;
      if (!id) return json({ error: "Choose an account first." }, 400);
      if (!password || String(password).length < 8) return json({ error: "The password needs at least 8 characters." }, 400);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) return json({ error: /weak|pwned|leak/i.test(error.message) ? "That password is too common or has appeared in a data breach. Choose another." : "We couldn't change the password. Try again." }, 400);
      return json({ ok: true });
    }

    return json({ error: "That action isn't available." }, 400);
  } catch (e) {
    console.error("create-user", String((e as Error)?.message || e));
    return json({ error: "Something went wrong on our side. Try again in a minute." }, 500);
  }
});
