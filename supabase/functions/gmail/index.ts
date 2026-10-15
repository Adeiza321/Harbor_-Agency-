// Gmail drafts: emails the assistant writes are saved to the person's own Gmail drafts, ready
// to check and send from Gmail. Pronext never reads the inbox and never sends.
//
// Uses the Google connection from interviews (google_calendar_connections, one per person) and
// adds one permission to it, gmail.compose, only when the person asks for it. The Google redirect
// still lands on /interviews/oauth, which saves the refreshed token and returns to Pronext.
// Google Workspace: set the OAuth consent screen to "Internal" and enable the Gmail API in the
// same Google Cloud project (see supabase/INTERVIEWS_SETUP.md, Gmail drafts).
//
// Actions (the person's own login): status, connect, draft {to, cc, subject, body}.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const errMsg = (e: unknown) => String((e as Error)?.message || e);

const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
// The interview scopes are asked again so the refreshed token keeps them.
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.app.created", "https://www.googleapis.com/auth/calendar.freebusy", COMPOSE];
const configured = () => !!(Deno.env.get("GOOGLE_CLIENT_ID") && Deno.env.get("GOOGLE_CLIENT_SECRET"));

async function accessToken(refresh: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return { token: "", scope: "", revoked: data?.error === "invalid_grant" };
  return { token: String(data.access_token), scope: String(data.scope || ""), revoked: false };
}

const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let out = ""; for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(out); };
const b64url = (s: string) => b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hdr = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + b64(s) + "?=");
const line = (s: unknown, n: number) => String(s || "").replace(/[\r\n]+/g, " ").trim().slice(0, n);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: caller } = await admin.auth.getUser((req.headers.get("Authorization") || "").replace("Bearer ", ""));
    if (!caller?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("id,status").eq("id", caller.user.id).single();
    if (!me || me.status !== "Active") return json({ error: "Your account is not active" }, 403);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (!configured()) return json({ error: "Google sign-in isn't set up yet. An admin needs to add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." }, 400);
    const { data: conn } = await admin.from("google_calendar_connections").select("google_email,refresh_token").eq("profile_id", me.id).maybeSingle();

    if (action === "connect") {
      const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const returnTo = typeof body.returnTo === "string" && /^https?:\/\/[^\s]+$/.test(body.returnTo) ? body.returnTo.slice(0, 500) : null;
      await admin.from("google_oauth_states").insert({ state, profile_id: me.id, return_to: returnTo });
      const q = new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, redirect_uri: Deno.env.get("SUPABASE_URL") + "/functions/v1/interviews/oauth", response_type: "code",
        scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
        ...(conn?.google_email ? { login_hint: conn.google_email } : {}),
      });
      return json({ ok: true, url: "https://accounts.google.com/o/oauth2/v2/auth?" + q });
    }

    if (!conn) return json({ ok: true, connected: false, needConnect: true });
    const t = await accessToken(conn.refresh_token);
    const can = !!t.token && t.scope.split(" ").includes(COMPOSE);
    if (action === "status") return json({ ok: true, connected: can, email: conn.google_email || "" });

    if (action === "draft") {
      if (!can) return json({ ok: false, needConnect: true, email: conn.google_email || "" });
      const mime = [
        ...(line(body.to, 500) ? ["To: " + line(body.to, 500)] : []),
        ...(line(body.cc, 500) ? ["Cc: " + line(body.cc, 500)] : []),
        "Subject: " + hdr(line(body.subject, 300)),
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        (b64(String(body.body || "").slice(0, 50000).replace(/\r?\n/g, "\r\n")).match(/.{1,76}/g) || []).join("\r\n"),
      ].join("\r\n");
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
        method: "POST", headers: { Authorization: "Bearer " + t.token, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { raw: b64url(mime) } }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        const m = String(data?.error?.message || "");
        // Gmail API switched off in the Google Cloud project: an admin fixes it once, reconnecting won't help.
        if (/has not been used|is disabled/i.test(m)) return json({ error: "The Gmail API is switched off in your Google Cloud project. An admin needs to enable it (Google Cloud > APIs & Services > Gmail API > Enable)." }, 400);
        return json({ ok: false, needConnect: true, email: conn.google_email || "" });
      }
      if (!res.ok) return json({ error: "Gmail " + res.status + ": " + String(data?.error?.message || "").slice(0, 200) }, 502);
      const msgId = data?.message?.id || "";
      return json({ ok: true, id: data.id, email: conn.google_email, url: "https://mail.google.com/mail/u/" + encodeURIComponent(conn.google_email || "0") + "/#drafts" + (msgId ? "?compose=" + msgId : "") });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("gmail", errMsg(e));
    return json({ error: errMsg(e) }, 500);
  }
});
