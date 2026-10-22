import { createClient } from "npm:@supabase/supabase-js@2";
import { emailShell, esc, loadBrand, sendBrevo } from "./brand.ts";

// "Edit my information" on the candidate page. Their saved job information isn't shown on the page;
// to see or change it they get a 6-digit code at the email we already have.
//   send    { token }          emails a code (valid 10 minutes; one a minute at most)
//   verify  { token, code }    the right code opens a 30-minute edit session: { session }, which
//                              candidate_preferences_edit / candidate_set_preferences check.
// Five wrong codes and that code stops working (ask for a new one). Deployed with verify_jwt off:
// the candidate page link (portal token) is the check, as for the other candidate-page actions.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const hash = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const masked = (e: string) => { const at = e.indexOf("@"); return at > 0 ? e[0] + "•••" + e.slice(at) : ""; };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const { token, action, code } = await req.json().catch(() => ({}));
    if (!token || typeof token !== "string" || token.length < 12) return json({ error: "Invalid link" }, 403);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: c } = await admin.from("candidates").select("id,name,email,email_opt_out,edit_otp_hash,edit_otp_expires_at,edit_otp_tries,edit_otp_sent_at").eq("portal_token", token).maybeSingle();
    if (!c) return json({ error: "Invalid link" }, 403);
    if (!c.email) return json({ error: "We don't have an email for you yet. Ask your recruiter to update your details." }, 400);

    if (action === "send") {
      if (c.edit_otp_sent_at && Date.now() - Date.parse(c.edit_otp_sent_at) < 60e3) return json({ ok: true, sent: true, to: masked(c.email), wait: true });
      const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
      const otp = String(n).padStart(6, "0");
      await admin.from("candidates").update({ edit_otp_hash: await hash(c.id + ":" + otp), edit_otp_expires_at: new Date(Date.now() + 10 * 60e3).toISOString(), edit_otp_tries: 0, edit_otp_sent_at: new Date().toISOString() }).eq("id", c.id);
      const b = await loadBrand(admin);
      const first = esc(String(c.name || "there").split(" ")[0]);
      const subject = otp + " is your code to edit your information";
      // Sent even if they unsubscribed from updates: they asked for this code themselves.
      const html = emailShell(b, subject, `
        <div style="font-size:20px;margin-bottom:8px;">Hi ${first},</div>
        <div style="font-size:15px;line-height:1.6;">Here's your code to see and edit your job information on your ${esc(b.name)} candidate page:</div>
        <div style="margin:18px 0;font-family:Arial,sans-serif;font-size:32px;font-weight:700;letter-spacing:8px;color:${b.color};">${otp}</div>
        <div style="font-size:14px;line-height:1.6;color:#56605A;">It works for 10 minutes. If you didn't ask for it, you can ignore this email: nothing changes without the code.</div>`);
      const ok = await sendBrevo(b, { email: c.email, name: c.name }, subject, html);
      if (!ok) return json({ error: "We couldn't send the code just now. Try again in a minute." }, 502);
      return json({ ok: true, sent: true, to: masked(c.email) });
    }

    if (action === "verify") {
      const given = String(code || "").replace(/\D/g, "");
      if (given.length !== 6) return json({ error: "Enter the 6-digit code from the email." }, 400);
      if (!c.edit_otp_hash || !c.edit_otp_expires_at || Date.parse(c.edit_otp_expires_at) < Date.now()) return json({ error: "That code has expired. Ask for a new one." }, 400);
      if ((c.edit_otp_tries || 0) >= 5) return json({ error: "Too many wrong codes. Ask for a new one." }, 429);
      if ((await hash(c.id + ":" + given)) !== c.edit_otp_hash) {
        await admin.from("candidates").update({ edit_otp_tries: (c.edit_otp_tries || 0) + 1 }).eq("id", c.id);
        return json({ error: "That code isn't right. Check the email and try again." }, 400);
      }
      const session = hex(crypto.getRandomValues(new Uint8Array(24)).buffer);
      await admin.from("candidates").update({ edit_otp_hash: null, edit_otp_expires_at: null, edit_otp_tries: 0, edit_session: session, edit_session_expires_at: new Date(Date.now() + 30 * 60e3).toISOString() }).eq("id", c.id);
      return json({ ok: true, session });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("candidate-otp", String((e as Error)?.message || e));
    return json({ error: "Something went wrong on our side. Please try again in a minute." }, 500);
  }
});
