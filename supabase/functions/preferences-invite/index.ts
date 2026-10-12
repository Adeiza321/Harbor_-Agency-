import { createClient } from "npm:@supabase/supabase-js@2";
import { button, emailShell, esc, loadBrand, sendBrevo, type Brand } from "./brand.ts";

// Job-preference invites. Candidates who already agreed to be kept on file and recommended for
// roles (pitch_consent) but haven't answered the job-preference questions get one email asking
// them to; the link opens their candidate page with the questions ready (?prefs=1).
//   count   how many would get it (nothing sent)
//   send    email up to `limit` of them (default 50) and stamp preferences_invited_at, so nobody
//           gets it twice; unsubscribed candidates and drafts are never emailed
//   test    send the email to the person asking (or `to`), with the link on the preview page
//   test_journey  send the first email a candidate gets (assigned a recruiter, with the "keep your
//           profile and recommend you" Yes / No question), with every link on the preview page
// Rec Ops / Admins only, or a short-lived ops token (public.ops_tokens) for scheduled runs.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-harbor-ops",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const PORTAL_BASE = (Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com").replace(/\/+$/, "");

export function inviteEmail(b: Brand, o: { name: string; link: string }) {
  const first = esc(String(o.name || "there").split(" ")[0] || "there");
  const subject = "A few quick questions so we match you to the right roles";
  const html = emailShell(b, subject,
    `<div style="font-size:20px;margin-bottom:8px;">Hi ${first},</div>
     <div style="font-size:15px;line-height:1.6;">Thanks for letting ${esc(b.legal || b.name)} keep your profile on file and recommend you for roles that fit.</div>
     <div style="font-size:15px;line-height:1.6;margin-top:12px;">To make sure we only put you forward for the right opportunities, please tell us what you're looking for: the roles and level you want, your salary expectation, where you'd like to work (remote, hybrid or on-site), your right to work, the languages you speak, when you could start and your industry experience.</div>
     <div style="font-size:15px;line-height:1.6;margin-top:12px;">It takes about two minutes, and you can update your answers any time on your candidate page.</div>
     ${button(b, o.link, "Answer the questions")}
     <div style="font-size:13px;line-height:1.6;margin-top:16px;color:#56605A;">Your answers are only seen by our recruitment team. Visa details are never shared with employers.</div>`,
    undefined, o.link.replace(/([?&])prefs=1/, "$1unsub=1"));
  return { subject, html };
}

// Same Yes / No block as candidate emails (send-message), for the journey test.
function pitchYesNo(b: Brand, portalUrl: string) {
  const btn = (href: string, label: string, solid: boolean) =>
    `<a href="${esc(href)}" style="display:inline-block;margin:10px 8px 0 0;padding:10px 22px;border:1.5px solid ${b.color};${solid ? `background:${b.color};color:#ffffff;` : `color:${b.color};`}text-decoration:none;border-radius:10px;font-family:Arial,sans-serif;font-size:14px;font-weight:600;">${label}</a>`;
  return `<div style="margin-top:26px;padding:16px 18px;border:1px solid #E4DED2;border-radius:12px;background:#FAF8F3;">
    <div style="font-size:15px;line-height:1.6;">Would you like us to pitch your profile anonymously for future roles we think you might be a good fit for? We won't submit your full profile unless you show interest.</div>
    ${btn(portalUrl + "&pitch=yes", "Yes", true)}${btn(portalUrl + "&pitch=no", "No", false)}
  </div>`;
}
function journeyEmail(b: Brand, o: { name: string; recruiter: string; role: string; client: string; portalUrl: string }) {
  const first = esc(String(o.name || "there").split(" ")[0] || "there");
  const subject = `Your application for ${o.role} is under review`;
  const html = emailShell(b, subject,
    `<div style="font-size:20px;margin-bottom:8px;">Hi ${first},</div>
     <div style="font-size:15px;line-height:1.6;">Good news: you've been assigned a recruiter, <b>${esc(o.recruiter)}</b>, for the <b>${esc(o.role)}</b> role at <b>${esc(o.client)}</b>, and your application is now under review. Once a decision is made, you'll get another email updating you on its status.</div>
     <div style="font-size:15px;line-height:1.6;margin-top:12px;">Message ${esc(o.recruiter.split(" ")[0])} any time if you have questions or want to stay connected.</div>
     ${button(b, o.portalUrl, "Message your recruiter")}
     ${pitchYesNo(b, o.portalUrl)}`, undefined, o.portalUrl + "&unsub=1");
  return { subject, html };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    let me: { id: string | null; email: string; full_name: string } | null = null;
    const opsKey = req.headers.get("x-harbor-ops") || "";
    if (opsKey) {
      const { data: tok } = await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!tok || opsKey.length < 32) return json({ error: "Invalid ops token" }, 403);
      me = { id: null, email: "", full_name: "ProNext" };
    } else {
      const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      const { data: caller } = await admin.auth.getUser(jwt);
      if (!caller?.user) return json({ error: "Not signed in" }, 401);
      const { data: p } = await admin.from("profiles").select("id,role,status,full_name,email").eq("id", caller.user.id).single();
      if (!p || p.status !== "Active") return json({ error: "Your account is not active" }, 403);
      if (p.role !== "admin" && p.role !== "recops") return json({ error: "Only Rec Ops or Admins can send these" }, 403);
      me = { id: p.id, email: p.email || caller.user.email || "", full_name: p.full_name || "" };
    }
    const b = await loadBrand(admin);
    const action = String(body.action || "count");

    if (action === "test") {
      const to = String(body.to || me.email || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ error: "No email address to send the test to" }, 400);
      const m = inviteEmail(b, { name: String(body.name || me.full_name || "there"), link: `${PORTAL_BASE}/?c=preview&prefs=1` });
      const ok = await sendBrevo(b, { email: to }, "[Test] " + m.subject, m.html);
      return ok ? json({ ok: true, sentTo: to }) : json({ error: "The email couldn't be sent (Brevo)" }, 502);
    }

    if (action === "test_journey") {
      const to = String(body.to || me.email || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ error: "No email address to send the test to" }, 400);
      const m = journeyEmail(b, { name: String(body.name || me.full_name || "there"), recruiter: String(body.recruiter || "Ada Obi"), role: String(body.role || "Financial Controller"),
        client: String(body.client || "a sample client"), portalUrl: `${PORTAL_BASE}/?c=preview` });
      const ok = await sendBrevo(b, { email: to }, "[Test] " + m.subject, m.html);
      return ok ? json({ ok: true, sentTo: to }) : json({ error: "The email couldn't be sent (Brevo)" }, 502);
    }

    const pending = () => admin.from("candidates").select("id,name,email,portal_token", { count: "exact" })
      .eq("pitch_consent", true).is("preferences", null).is("preferences_invited_at", null)
      .eq("is_draft", false).not("email", "is", null).not("portal_token", "is", null).or("email_opt_out.is.null,email_opt_out.eq.false");

    if (action === "count") {
      const { count, error } = await pending().limit(1);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, pending: count || 0 });
    }

    if (action !== "send") return json({ error: "Unknown action" }, 400);
    const limit = Math.max(1, Math.min(Number(body.limit) || 50, 200));
    const { data: list, error } = await pending().order("pitch_consent_at", { ascending: true }).limit(limit);
    if (error) return json({ error: error.message }, 500);
    let sent = 0; const failed: string[] = [];
    for (const c of list || []) {
      const m = inviteEmail(b, { name: c.name, link: `${PORTAL_BASE}/?c=${c.portal_token}&prefs=1` });
      if (await sendBrevo(b, { email: c.email, name: c.name }, m.subject, m.html)) {
        sent++;
        await admin.from("candidates").update({ preferences_invited_at: new Date().toISOString() }).eq("id", c.id);
        await admin.from("candidate_timeline").insert({ candidate_id: c.id, title: "Emailed the job-preference questions", done: true }).then(() => {}, () => {});
      } else failed.push(c.name);
      await new Promise((r) => setTimeout(r, 250));
    }
    const { count } = await pending().limit(1);
    return json({ ok: true, sent, failed, remaining: count || 0 });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
