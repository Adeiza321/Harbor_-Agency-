import { createClient } from "npm:@supabase/supabase-js@2";

// Google Indexing API for job pages: tells Google the moment a job page is published, changed or
// taken down, instead of waiting for Google to re-crawl the sitemap (Google supports this API for
// pages with JobPosting data, which ours are).
//
// Called by the "Publish site and job pages" workflow right after each deploy, with the job page
// URLs that deploy put live: POST { urls: ["https://recruitment.pronextglobal.com/jobs/<slug>/", ...] }.
//   URL_UPDATED  for a live page that's new, or whose job details changed since we last told Google
//   URL_DELETED  for a page we told Google about whose job is no longer open (closed or deleted)
// Safe to call from anywhere: it only acts on URLs of jobs that the database itself says are open,
// and only removes pages of jobs the database says are closed. A record of what Google was told is
// kept in google_index_log, so nothing is sent twice.
// Setup: secret GOOGLE_INDEXING_KEY = the service account's JSON key; that service account must be an
// Owner of the site in Google Search Console. Without the secret it does nothing.

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const SITE = (Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com").replace(/\/+$/, "");
const DAILY = 180; // Google's default quota is 200 notifications a day.

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function accessToken(key: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: key.client_email, scope: "https://www.googleapis.com/auth/indexing", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const pem = key.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, new TextEncoder().encode(head + "." + claim));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: head + "." + claim + "." + b64url(sig) }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error("Google sign-in failed: " + String(j.error_description || j.error || res.status));
  return j.access_token as string;
}

async function hashOf(o: unknown) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(o)));
  return Array.from(new Uint8Array(d)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: true });
  try {
    const raw = Deno.env.get("GOOGLE_INDEXING_KEY") || "";
    if (!raw) return json({ ok: true, skipped: "GOOGLE_INDEXING_KEY isn't set" });
    let key: any;
    try { key = JSON.parse(raw); } catch { return json({ error: "GOOGLE_INDEXING_KEY isn't valid JSON" }, 500); }
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const live = new Set((Array.isArray(body.urls) ? body.urls : []).map(String).filter((u: string) => u.startsWith(SITE + "/jobs/")).slice(0, 500));

    // What the database says: open jobs and their public details (the same list the pages are built from).
    const { data: pub } = await admin.rpc("public_jobs");
    const jobs: any[] = Array.isArray(pub?.jobs) ? pub.jobs : [];
    const urlOf = (slug: string) => `${SITE}/jobs/${encodeURIComponent(slug)}/`;
    const openUrls = new Map<string, any>(jobs.map((j) => [urlOf(j.slug), j]));
    const { data: log } = await admin.from("google_index_log").select("url,hash,deleted_at");
    const known = new Map<string, any>((log || []).map((r: any) => [r.url, r]));

    const todo: { url: string; type: "URL_UPDATED" | "URL_DELETED"; hash?: string }[] = [];
    for (const [url, j] of openUrls) {
      if (!live.has(url)) continue; // not on the site yet: next deploy
      const h = await hashOf([j.title, j.description, j.location, j.country, j.pay, j.workSetup, j.employmentType, j.headcount]);
      const k = known.get(url);
      if (!k || k.deleted_at || k.hash !== h) todo.push({ url, type: "URL_UPDATED", hash: h });
    }
    for (const [url, k] of known) if (!k.deleted_at && !openUrls.has(url)) todo.push({ url, type: "URL_DELETED" });

    const since = new Date(Date.now() - 864e5).toISOString();
    const { count: today } = await admin.from("google_index_log").select("url", { count: "exact", head: true }).gte("notified_at", since);
    const room = Math.max(0, DAILY - (today || 0));
    if (!todo.length) return json({ ok: true, sent: 0, note: "Google is up to date" });
    if (!room) return json({ ok: true, sent: 0, waiting: todo.length, note: "Daily limit reached; the rest go out on a later deploy" });

    const token = await accessToken(key);
    const out: any[] = [];
    for (const t of todo.slice(0, room)) {
      const res = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ url: t.url, type: t.type }),
      });
      const j = await res.json().catch(() => ({}));
      const err = res.ok ? null : String(j?.error?.message || res.status).slice(0, 300);
      const now = new Date().toISOString();
      if (t.type === "URL_UPDATED") await admin.from("google_index_log").upsert({ url: t.url, hash: err ? null : t.hash, notified_at: now, deleted_at: null, last_error: err }, { onConflict: "url" });
      else await admin.from("google_index_log").update({ notified_at: now, deleted_at: err ? null : now, last_error: err }).eq("url", t.url);
      out.push({ url: t.url, type: t.type, ok: !err, error: err || undefined });
      if (err && res.status === 403) break; // not an Owner in Search Console yet: no point trying the rest
    }
    return json({ ok: true, sent: out.filter((x) => x.ok).length, failed: out.filter((x) => !x.ok).length, waiting: Math.max(0, todo.length - out.length), results: out });
  } catch (e) {
    console.error("google-indexing", String((e as Error)?.message || e));
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
