import { createClient } from "npm:@supabase/supabase-js@2";

// Profile photo a candidate adds (or removes) on their own candidate page (/?c=<portal token>).
// No login: the portal token identifies them. The picture is resized in the browser first, then
// stored in the public `avatars` bucket at candidates/<candidate id>/<time>.<ext> and its URL
// saved on candidates.photo_url, so recruiters see the same photo in the dashboard and chats.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_BYTES = 2 * 1024 * 1024;
const EXT: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp" };

// Our own files only: never delete anything outside this candidate's folder.
const ownPath = (url: string | null, id: string) => {
  const m = String(url || "").match(/\/storage\/v1\/object\/public\/avatars\/(candidates\/[^?]+)/);
  return m && m[1].startsWith("candidates/" + id + "/") ? m[1] : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "");
    if (token.length < 12) return json({ error: "This link isn't valid" }, 403);
    const { data: cand } = await admin.from("candidates").select("id,photo_url").eq("portal_token", token).maybeSingle();
    if (!cand) return json({ error: "This link isn't valid" }, 403);
    const old = ownPath(cand.photo_url, cand.id);

    if (body.action === "remove") {
      await admin.from("candidates").update({ photo_url: null }).eq("id", cand.id);
      if (old) await admin.storage.from("avatars").remove([old]);
      return json({ ok: true, photoUrl: null });
    }

    const m = String(body.image || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return json({ error: "Choose a JPG, PNG or WEBP picture" }, 400);
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    if (bytes.length < 200) return json({ error: "That picture looks empty. Try another one." }, 400);
    if (bytes.length > MAX_BYTES) return json({ error: "That picture is too large. Try a smaller one." }, 400);

    const path = `candidates/${cand.id}/${Date.now()}.${EXT[m[1]]}`;
    const { error: upErr } = await admin.storage.from("avatars").upload(path, bytes, { contentType: "image/" + m[1], upsert: false });
    if (upErr) return json({ error: "Couldn't save the picture: " + upErr.message }, 500);
    const url = admin.storage.from("avatars").getPublicUrl(path).data.publicUrl;
    const { error } = await admin.from("candidates").update({ photo_url: url }).eq("id", cand.id);
    if (error) return json({ error: error.message }, 500);
    if (old) await admin.storage.from("avatars").remove([old]);
    return json({ ok: true, photoUrl: url });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
