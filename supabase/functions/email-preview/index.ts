// Copies Pronext's email designs into the Brevo account as (inactive) templates, so they can be
// previewed and test-sent from Brevo. Pronext itself still builds and sends its emails in code;
// editing these copies in Brevo does not change what Pronext sends.
// Called only with the ops token (from the database), never from the browser.
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const opsKey = req.headers.get("x-harbor-ops") || "";
    const { data: tok } = opsKey.length >= 32
      ? await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle()
      : { data: null };
    if (!tok) return json({ error: "Not allowed" }, 403);
    const body = await req.json();

    // The ProNext logo for email headers: stored in the public avatars bucket so mail clients can load it.
    if (body.action === "upload_logo") {
      const bytes = Uint8Array.from(atob(String(body.png || "")), (c) => c.charCodeAt(0));
      if (bytes.length < 100 || bytes.length > 500000) return json({ error: "Logo missing or too large" }, 400);
      const path = "brand/" + String(body.name || "logo.png").replace(/[^a-z0-9._-]/gi, "");
      const { error } = await admin.storage.from("avatars").upload(path, bytes, { contentType: "image/png", upsert: true });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, url: admin.storage.from("avatars").getPublicUrl(path).data.publicUrl });
    }

    const key = Deno.env.get("BREVO_API_KEY"), sender = Deno.env.get("BREVO_SENDER_EMAIL");
    if (!key) return json({ error: "BREVO_API_KEY is not set" }, 400);
    const { data: s } = await admin.from("agency_settings").select("agency_name").limit(1).maybeSingle();
    const senderName = String(s?.agency_name || "Pronext").trim() || "Pronext";

    const templates: { name: string; subject: string; html: string }[] = Array.isArray(body.templates) ? body.templates : [];
    const h = { "api-key": key, "Content-Type": "application/json", accept: "application/json" };
    let listRes: Response;
    try { listRes = await fetch("https://api.brevo.com/v3/smtp/templates?limit=50&offset=0", { headers: h, signal: AbortSignal.timeout(20000) }); }
    catch (e) { console.error("brevo list", String(e)); return json({ error: "Couldn't reach Brevo: " + String((e as Error)?.message || e) }, 502); }
    const list = await listRes.json().catch(() => ({}));
    if (!listRes.ok) return json({ error: "Brevo refused the key: " + (list.message || listRes.status) }, 400);
    // The key works; templates also need the sender address set in Supabase.
    if (!sender) return json({ error: "BREVO_SENDER_EMAIL is not set", keyOk: true }, 400);
    // Matched on the part after "… preview – ", so renaming the app updates the same templates.
    const tplKey = (n: string) => String(n || "").replace(/^.*? preview – /, "");
    const existing = new Map<string, number>(((list.templates || []) as any[]).map((t) => [tplKey(t.name), t.id]));

    const results = [];
    for (const t of templates) {
      const payload = { templateName: t.name, subject: t.subject, htmlContent: t.html, sender: { name: senderName, email: sender }, isActive: false };
      const id = existing.get(tplKey(t.name));
      let r: Response;
      try { r = await fetch("https://api.brevo.com/v3/smtp/templates" + (id ? "/" + id : ""), { method: id ? "PUT" : "POST", headers: h, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) }); }
      catch (e) { results.push({ name: t.name, ok: false, id: id || null, error: String((e as Error)?.message || e) }); continue; }
      const j = await r.json().catch(() => ({}));
      results.push({ name: t.name, ok: r.ok, id: id || j.id || null, error: r.ok ? undefined : (j.message || String(r.status)) });
    }
    return json({ ok: results.every((x) => x.ok), results });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
