import { createClient } from "npm:@supabase/supabase-js@2";

// Self-service password reset: a user who forgot their password requests a one-time code,
// which is emailed to them (never shown in the response). Every admin is also notified by
// email so the agency has visibility into reset activity. The user then verifies the code to
// set a new password themselves -- no admin action is required to complete the reset.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

import { emailShell as brandShell, esc, loadBrand, sendBrevo as brandSend, type Brand } from "./brand.ts";
let brand: Brand = { name: "Pronext", logo: null, color: "#1F6F54" };
const sendBrevo = (to: { email: string; name?: string }, subject: string, html: string) => brandSend(brand, to, subject, html);
const emailShell = (preheader: string, bodyHtml: string) => brandShell(brand, preheader, bodyHtml, brand.name + " account security");

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    brand = await loadBrand(admin);
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";

    if (action === "request") {
      const email = String(body.email || "").trim().toLowerCase();
      // Always the same reply, found or not -- never reveal whether an email has an account.
      const genericOk = { ok: true, message: "If that email has a Pronext account, a code has been sent to it." };
      if (!email || !email.includes("@")) return json(genericOk);

      const { data: profile } = await admin.from("profiles").select("id,email,full_name,status").ilike("email", email).maybeSingle();
      if (!profile || profile.status !== "Active") return json(genericOk);

      const otp = genOtp();
      const expires_at = new Date(Date.now() + OTP_TTL_MS).toISOString();
      const { error: insErr } = await admin.from("password_resets").insert({ user_id: profile.id, email: profile.email, otp_code: otp, expires_at, requested_ip: ip });
      if (insErr) return json({ error: insErr.message }, 500);

      const first = String(profile.full_name || "there").split(" ")[0];
      const userHtml = emailShell("Your " + brand.name + " password reset code",
        `<div style="font-size:20px;margin-bottom:8px;">Hi ${esc(first)},</div>
         <div style="font-size:15px;line-height:1.6;">Use this code to reset your ${esc(brand.name)} password. It expires in 10 minutes.</div>
         <div style="margin-top:16px;font-size:32px;letter-spacing:8px;font-weight:700;font-family:Arial,sans-serif;">${otp}</div>
         <div style="margin-top:16px;font-size:13px;color:#8A8578;font-family:Arial,sans-serif;">If you didn't request this, you can ignore this email -- your password won't change.</div>`);
      const sent = await sendBrevo({ email: profile.email, name: profile.full_name }, "Your " + brand.name + " password reset code", userHtml);

      // Notify every active admin, for visibility -- the user can complete the reset
      // themselves with the OTP, no admin action is required.
      const { data: admins } = await admin.from("profiles").select("email,full_name").eq("role", "admin").eq("status", "Active");
      for (const a of admins || []) {
        if (!a.email) continue;
        const adminHtml = emailShell("Password reset requested",
          `<div style="font-size:20px;margin-bottom:8px;">Password reset requested</div>
           <div style="font-size:15px;line-height:1.6;"><b>${esc(profile.full_name || profile.email)}</b> (${esc(profile.email)}) requested a ${esc(brand.name)} password reset${ip ? " from IP " + esc(ip) : ""}. They can complete it themselves with a one-time code -- no action is needed from you unless this looks suspicious.</div>`);
        sendBrevo({ email: a.email, name: a.full_name }, brand.name + ": password reset requested for " + (profile.full_name || profile.email), adminHtml).catch(() => {});
      }

      // Best-effort: never let a logging failure break the actual password-reset flow. The
      // Supabase JS query builder is PromiseLike (has .then) but not a real Promise, so
      // .catch() on it throws "catch is not a function" -- await inside try/catch instead.
      try { await admin.from("audit_log").insert({ actor_id: profile.id, action: "password_reset_requested", entity_type: "profile", entity_id: profile.id, detail: ip ? "from " + ip : null }); } catch (e) { console.error("audit_log insert", String((e as Error)?.message || e)); }
      return json({ ...genericOk, sent });
    }

    if (action === "verify") {
      const email = String(body.email || "").trim().toLowerCase();
      const otp = String(body.otp || "").trim();
      const newPassword = String(body.newPassword || "");
      if (!email || !otp) return json({ error: "Enter the code that was emailed to you" }, 400);
      if (newPassword.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

      const { data: row } = await admin.from("password_resets").select("*").ilike("email", email).eq("used", false).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!row) return json({ error: "Request a new code first" }, 400);
      if (new Date(row.expires_at).getTime() < Date.now()) return json({ error: "That code has expired. Request a new one." }, 400);
      if (row.attempts >= 5) return json({ error: "Too many attempts. Request a new code." }, 400);
      if (row.otp_code !== otp) {
        await admin.from("password_resets").update({ attempts: row.attempts + 1 }).eq("id", row.id);
        return json({ error: "Incorrect code" }, 400);
      }

      const { error: pwErr } = await admin.auth.admin.updateUserById(row.user_id, { password: newPassword });
      if (pwErr) return json({ error: pwErr.message }, 400);
      await admin.from("password_resets").update({ used: true }).eq("id", row.id);
      try { await admin.from("audit_log").insert({ actor_id: row.user_id, action: "password_reset_completed", entity_type: "profile", entity_id: row.user_id, detail: ip ? "from " + ip : null }); } catch (e) { console.error("audit_log insert", String((e as Error)?.message || e)); }
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
