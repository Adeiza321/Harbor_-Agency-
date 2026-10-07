import { createClient } from "npm:@supabase/supabase-js@2";

// Files and pictures in candidate <-> recruiter chats. Stored in the private `chat-files` bucket
// at <link id>/<time>-<name>; nobody reads the bucket directly, only through here.
//   send    candidate (portal token): stores the file and posts it as their message
//   upload  recruiter / staff (signed in): stores the file and returns it; the message itself is
//           then posted through send-message, which also emails the candidate
//   urls    either side: short-lived links (1 hour) for the files in one conversation

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
  "application/pdf", "text/plain", "text/csv",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const linkId = String(body.linkId || "");
    if (!/^[0-9a-f-]{36}$/i.test(linkId)) return json({ error: "Conversation not found" }, 400);

    // Who is asking: a candidate with their portal token, or a signed-in Pronext user.
    let side: "candidate" | "recruiter";
    if (body.token) {
      const token = String(body.token);
      if (token.length < 12) return json({ error: "This link isn't valid" }, 403);
      const { data: cand } = await admin.from("candidates").select("id").eq("portal_token", token).maybeSingle();
      if (!cand) return json({ error: "This link isn't valid" }, 403);
      const { data: link } = await admin.from("candidate_jobs").select("id").eq("id", linkId).eq("candidate_id", cand.id).maybeSingle();
      if (!link) return json({ error: "This conversation is no longer available" }, 404);
      side = "candidate";
    } else {
      const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      const { data: caller } = await admin.auth.getUser(jwt);
      if (!caller?.user) return json({ error: "Not signed in" }, 401);
      const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: "Bearer " + jwt } } });
      const { data: ok } = await asUser.rpc("can_chat", { p_link_id: linkId });
      if (!ok) return json({ error: "You don't have access to this conversation" }, 403);
      side = "recruiter";
    }

    if (body.action === "urls") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 100);
      if (!ids.length) return json({ ok: true, urls: {} });
      const { data: rows } = await admin.from("candidate_job_messages").select("id,attachment_path").eq("link_id", linkId).in("id", ids).not("attachment_path", "is", null);
      const list = rows || [];
      if (!list.length) return json({ ok: true, urls: {} });
      const { data: signed } = await admin.storage.from("chat-files").createSignedUrls(list.map((r: any) => r.attachment_path), 3600);
      const urls: Record<string, string> = {};
      list.forEach((r: any, i: number) => { const s = (signed || [])[i]; if (s?.signedUrl) urls[r.id] = s.signedUrl; });
      return json({ ok: true, urls });
    }

    if (body.action !== "send" && body.action !== "upload") return json({ error: "Unknown action" }, 400);
    if (body.action === "send" && side !== "candidate") return json({ error: "Use send-message to post as a recruiter" }, 400);
    if (body.action === "upload" && side !== "recruiter") return json({ error: "Not allowed" }, 403);

    const type = String(body.type || "").toLowerCase();
    if (!TYPES.has(type)) return json({ error: "That kind of file can't be sent. Try a picture, PDF, Word, Excel, PowerPoint or text file." }, 400);
    const name = String(body.name || "file").replace(/[\\/\u0000-\u001f]/g, "").trim().slice(0, 120) || "file";
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(String(body.data || "")), (c) => c.charCodeAt(0)); } catch { return json({ error: "The file didn't arrive in one piece. Try again." }, 400); }
    if (!bytes.length) return json({ error: "That file is empty" }, 400);
    if (bytes.length > MAX_BYTES) return json({ error: "Files can be up to 8 MB" }, 400);

    const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "file";
    const path = `${linkId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safe}`;
    const { error: upErr } = await admin.storage.from("chat-files").upload(path, bytes, { contentType: type, upsert: false });
    if (upErr) return json({ error: "Couldn't save the file: " + upErr.message }, 500);
    const file = { path, name, type, size: bytes.length };

    if (body.action === "upload") return json({ ok: true, file });

    const caption = String(body.caption || "").trim().slice(0, 4000);
    const now = new Date().toISOString();
    const { data: msg, error } = await admin.from("candidate_job_messages").insert({
      link_id: linkId, sender: "candidate", body: caption, candidate_read_at: now,
      attachment_path: path, attachment_name: name, attachment_type: type, attachment_size: bytes.length,
    }).select("id").single();
    if (error) { await admin.storage.from("chat-files").remove([path]); return json({ error: error.message }, 500); }
    return json({ ok: true, id: msg.id });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
