import { createClient } from "npm:@supabase/supabase-js@2";

// Signs a resume URL for the client-facing blind-profile page (/?t=<client_token>). The
// profile data itself comes from the public.client_view(p_token) RPC, called directly from the
// app. This function only handles the one thing the RPC can't: signing a Storage URL, and only
// once the recruiter has revealed full details for this link (client_revealed = true).
// Deployed with verify_jwt off: this is a public link, authenticated by its own token, the same
// as outreach-public and the interviews Google OAuth redirect.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const { token } = await req.json().catch(() => ({}));
    if (!token) return json({ error: "Missing token" }, 400);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: cj } = await admin.from("candidate_jobs").select("client_revealed,candidate_id").eq("client_token", token).maybeSingle();
    if (!cj) return json({ error: "Link not found" }, 404);
    if (!cj.client_revealed) return json({ error: "Not yet shared with this client" }, 403);

    const { data: cand } = await admin.from("candidates").select("resume_path,cv_path").eq("id", cj.candidate_id).single();
    const path = cand?.resume_path || cand?.cv_path;
    if (!path) return json({ error: "No resume on file" }, 404);
    const bucket = cand?.resume_path ? "resumes" : "cvs";
    const { data: signed, error } = await admin.storage.from(bucket).createSignedUrl(path, 600);
    if (error || !signed) return json({ error: error?.message || "Could not sign resume URL" }, 500);
    return json({ ok: true, url: signed.signedUrl });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
