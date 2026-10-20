import { createClient } from "npm:@supabase/supabase-js@2";
import { loadBrand, emailShell, esc, sendBrevo } from "./brand.ts";

// "Report to support" on an error pop-up (recruiters in the dashboard, candidates on their pages).
// Emails the ProNext team what went wrong, who saw it and where, so it can be fixed.
//   POST { message, note?, page?, audience: "recruiter" | "candidate", token? }
// Who reported it comes from their sign-in (recruiters) or their candidate link (token), never from
// what the page says. Goes to SUPPORT_EMAIL if that secret is set, otherwise to every active Admin.
// verify_jwt is off so candidates (no sign-in) can report too; a small per-address limit stops floods.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const recent = new Map<string, number[]>();
const tooMany = (key: string) => {
  const now = Date.now(), list = (recent.get(key) || []).filter((t) => now - t < 10 * 60e3);
  list.push(now); recent.set(key, list);
  return list.length > 5;
};
// Page addresses without the private codes in them (candidate links, setup and update links).
const cleanPage = (p: string) => { try { const u = new URL(p); for (const k of [...u.searchParams.keys()]) if (/^(c|u|t|setup|checkin|token|rt|apply)$/i.test(k)) u.searchParams.set(k, "…"); return u.toString().slice(0, 300); } catch { return clip(p, 300); } };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "That request isn't supported." }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const message = clip(body.message, 600);
    if (!message) return json({ error: "There's nothing to report." }, 400);
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    if (tooMany(ip)) return json({ error: "Thanks, we already have your reports. We'll look into it." }, 429);

    // Who: signed-in team member, or the candidate whose link this is.
    let who = { kind: body.audience === "candidate" ? "Candidate" : "Team member", name: "", email: "", role: "" };
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (jwt && jwt.split(".").length === 3) {
      const { data } = await admin.auth.getUser(jwt);
      if (data?.user) {
        const { data: p } = await admin.from("profiles").select("full_name,email,role").eq("id", data.user.id).maybeSingle();
        if (p) who = { kind: "Team member", name: p.full_name || "", email: p.email || data.user.email || "", role: p.role === "recops" ? "Rec Ops" : p.role === "admin" ? "Admin" : "Recruiter" };
      }
    }
    if (!who.email && /^[0-9a-f]{32}$/i.test(String(body.token || ""))) {
      const { data: c } = await admin.from("candidates").select("name,email").eq("portal_token", String(body.token)).maybeSingle();
      if (c) who = { kind: "Candidate", name: c.name || "", email: c.email || "", role: "" };
    }

    let to: { email: string; name?: string }[] = [];
    const support = (Deno.env.get("SUPPORT_EMAIL") || "").trim();
    if (support) to = [{ email: support }];
    else {
      const { data: admins } = await admin.from("profiles").select("email,full_name").eq("role", "admin").eq("status", "Active");
      to = (admins || []).filter((a: any) => a.email).map((a: any) => ({ email: a.email, name: a.full_name || undefined }));
    }
    if (!to.length) return json({ error: "We couldn't send your report right now. Please try again later." }, 500);

    const brand = await loadBrand(admin);
    const note = String(body.note ?? "").trim().slice(0, 1500);
    const page = cleanPage(String(body.page || ""));
    const ua = clip(req.headers.get("user-agent"), 200);
    const at = new Date().toLocaleString("en-GB", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
    const label = who.name ? `${who.name}${who.role ? " (" + who.role + ")" : who.kind === "Candidate" ? " (candidate)" : ""}` : `A ${who.kind.toLowerCase()}`;
    const subject = `Problem reported by ${label}`.slice(0, 180);
    const row = (k: string, v: string) => (v ? `<tr><td style="padding:4px 12px 4px 0;color:#56605A;font-size:13px;vertical-align:top;white-space:nowrap;">${esc(k)}</td><td style="padding:4px 0;font-size:13px;color:#14201B;">${esc(v)}</td></tr>` : "");
    const html = emailShell(brand, subject,
      `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;"><b>${esc(label)}</b> hit a problem in ${esc(brand.name)} and reported it.</div>
       <div style="margin-top:14px;padding:12px 14px;background:#FBE9E7;border-radius:10px;font-family:Arial,sans-serif;font-size:14px;color:#9A2B1E;">${esc(message)}</div>
       ${note ? `<div style="margin-top:12px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;font-weight:700;color:#56605A;">WHAT THEY WERE DOING</div><div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(note)}</div>` : ""}
       <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px;font-family:Arial,sans-serif;">${row("Who", label)}${row("Email", who.email)}${row("When", at + " (Lagos)")}${row("Page", page)}${row("Device", ua)}</table>`,
      `Sent from the "Report to support" button in ${brand.name}.`);
    let sent = 0;
    for (const t of to) if (await sendBrevo(brand, t, subject, html)) sent++;
    if (!sent) return json({ error: "We couldn't send your report right now. Please try again later." }, 502);
    return json({ ok: true });
  } catch (e) {
    console.error("report-issue", String((e as Error)?.message || e));
    return json({ error: "We couldn't send your report right now. Please try again later." }, 500);
  }
});
