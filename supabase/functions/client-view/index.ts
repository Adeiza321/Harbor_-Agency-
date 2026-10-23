import { createClient } from "npm:@supabase/supabase-js@2";
import { feeLine, feedbackGet, feedbackSubmit, fillTerms, fullResume, loadPoc, relationGet, relationRequest, saveTimeline, shortlistFor, signForLead, termsFor } from "../sourcing/clientflow.ts";

// Signs a resume URL for the client-facing blind-profile page (/?t=<client_token>), and
// (action "blind") the blind resume's page images. The
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
    const body = await req.json().catch(() => ({}));
    const { token, action } = body;
    if (!token || typeof token !== "string" || token.length < 12) return json({ error: "Missing token" }, 400);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // After a hire: the client's feedback page (/?t=f-<token>) and the monthly check-in page (/?t=r-<token>).
    if (action === "feedback") return json({ ok: true, ...(await feedbackGet(admin, token.replace(/^f-/, ""))) });
    if (action === "feedback_submit") return json(await feedbackSubmit(admin, token.replace(/^f-/, ""), body));
    if (action === "relation") return json({ ok: true, ...(await relationGet(admin, token.replace(/^r-/, ""))) });
    if (action === "relation_request") return json(await relationRequest(admin, token.replace(/^r-/, ""), body));

    // Client sourcing, the client side: the pitch page's candidates (full details once the company
    // has signed), the terms, signing, a full resume, and the hiring timeline.
    if (["pitch", "terms", "sign", "resume", "timeline"].includes(action)) {
      const ct = token.replace(/^s-/, "");
      if (!/^[0-9a-f-]{36}$/i.test(ct)) return json({ error: "Link not found" }, 404);
      const { data: l } = await admin.from("leads").select("*").eq("client_token", ct).maybeSingle();
      if (!l || ["unsubscribed", "ignored"].includes(l.status)) return json({ error: "Link not found" }, 404);
      if (action === "pitch") {
        if (!l.client_viewed_at) await admin.from("leads").update({ client_viewed_at: new Date().toISOString() }).eq("id", l.id);
        const { candidates, agreement } = await shortlistFor(admin, l);
        const t = await termsFor(admin, l.company);
        const poc = await loadPoc(admin, l.region || "");
        return json({ ok: true, company: l.company || "", role: l.job_title || "", location: l.location || "", candidates, fee: feeLine(t), firstTime: t.firstTime,
          signed: agreement ? { at: agreement.signed_at, name: agreement.signer_name, title: agreement.signer_title } : null,
          timeline: l.data?.timeline || null,
          poc: agreement ? { name: poc.name, title: poc.title, email: poc.email, phone: poc.phone, photo: poc.photo, bookingUrl: poc.bookingUrl } : null });
      }
      if (action === "terms") {
        const t = await termsFor(admin, l.company);
        const { agreement } = await shortlistFor(admin, l);
        if (agreement) return json({ ok: true, title: agreement.title, body: agreement.body, signed: agreement, fee: feeLine(t) });
        return json({ ok: true, title: t.title, body: fillTerms(t, { client: String(l.company || "the Client").toUpperCase(), clientAddress: "", date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) }),
          fee: feeLine(t), company: l.company || "", email: l.contact_email || "", name: l.contact_name || "" });
      }
      if (action === "sign") {
        const ip = String(req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "").split(",")[0].trim();
        const r = await signForLead(admin, l, body, ip, String(req.headers.get("user-agent") || ""));
        return json({ ok: true, already: r.already, signed: r.agreement });
      }
      if (action === "resume") return json({ ok: true, url: await fullResume(admin, l, Number(body.n) || 1) });
      if (action === "timeline") return json(await saveTimeline(admin, l, String(body.text || "")));
    }

    // Client leads: the page behind the pitch's "View the candidates" button (/?t=s-<client_token>).
    // Up to 5 candidates, each as a blind resume (only checked ones), with their selling points;
    // never a name. "shortlist_interest" is their "We're interested": the contract follows by itself.
    if (action === "shortlist" || action === "shortlist_interest") {
      const ct = token.replace(/^s-/, "");
      if (!/^[0-9a-f-]{36}$/i.test(ct)) return json({ error: "Link not found" }, 404);
      const { data: l } = await admin.from("leads").select("id,company,job_title,location,matches,data,status,client_viewed_at,interested_at,notes").eq("client_token", ct).maybeSingle();
      if (!l || ["unsubscribed", "ignored"].includes(l.status)) return json({ error: "Link not found" }, 404);
      if (action === "shortlist_interest") {
        if (!l.interested_at) await admin.from("leads").update({ interested_at: new Date().toISOString(), status: ["meeting", "won"].includes(l.status) ? l.status : "replied",
          notes: [l.notes, "Said they're interested on the candidates page " + new Date().toISOString().slice(0, 10)].filter(Boolean).join("\n") }).eq("id", l.id);
        return json({ ok: true });
      }
      if (!l.client_viewed_at) await admin.from("leads").update({ client_viewed_at: new Date().toISOString() }).eq("id", l.id);
      const ids: string[] = Array.isArray(l.data?.pitched) ? l.data.pitched.map(String) : [];
      const { data: cands } = ids.length ? await admin.from("candidates").select("id,blind_pages,blind_checked_at").in("id", ids) : { data: [] };
      const matches: any[] = Array.isArray(l.matches) ? l.matches : [];
      const out: any[] = [];
      for (const id of ids.slice(0, 5)) {
        const c = (cands || []).find((x: any) => x.id === id);
        const m = matches.find((x: any) => x.candidate_id === id) || {};
        const n = c && c.blind_checked_at ? Math.max(0, Math.min(12, Number(c.blind_pages) || 0)) : 0;
        let pages: string[] = [];
        if (n) {
          const { data: signed } = await admin.storage.from("blind-resumes").createSignedUrls(Array.from({ length: n }, (_, i) => `cand-${id}/${i + 1}.webp`), 600);
          pages = (signed || []).map((x: any) => x.signedUrl).filter(Boolean);
        }
        out.push({ n: out.length + 1, verdict: m.verdict || "", fit: m.fit || null, bullets: Array.isArray(m.bullets) ? m.bullets.slice(0, 3) : [], pages });
      }
      return json({ ok: true, company: l.company || "", role: l.job_title || "", location: l.location || "", interested: !!l.interested_at, candidates: out });
    }

    // The blind resume: the candidate's own CV with names, contact details and employers blacked
    // out, stored as page images (no text). Short-lived links, shown in a view-only page.
    if (action === "blind") {
      const { data: l } = await admin.from("candidate_jobs").select("id,candidate_id,blind_pages,blind_at,jobs(client)").eq("client_token", token).maybeSingle();
      if (!l) {
        // A blind resume sent with a pitch to an employer (a client lead): only for candidates who confirmed.
        const { data: o } = await admin.from("lead_offers").select("id,blind_pages,blind_at,status,client_viewed_at,leads(company,job_title)").eq("client_token", token).maybeSingle();
        if (!o || o.status !== "confirmed") return json({ error: "Link not found" }, 404);
        if (!o.client_viewed_at) await admin.from("lead_offers").update({ client_viewed_at: new Date().toISOString() }).eq("id", o.id);
        const n = Math.max(0, Math.min(12, Number(o.blind_pages) || 0));
        const lead: any = (o as any).leads || {};
        if (!n) return json({ ok: true, pages: [], client: lead.company || "", role: lead.job_title || "" });
        const { data: signed, error } = await admin.storage.from("blind-resumes").createSignedUrls(Array.from({ length: n }, (_, i) => `offer-${o.id}/${i + 1}.webp`), 300);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, client: lead.company || "", role: lead.job_title || "", pages: (signed || []).map((x: any) => x.signedUrl).filter(Boolean) });
      }
      // A blind resume made for this link, or else the candidate's own one (made once, reused everywhere).
      let n = Math.max(0, Math.min(12, Number(l.blind_pages) || 0)), folder = l.id, at = l.blind_at;
      if (!n) {
        const { data: c } = await admin.from("candidates").select("blind_pages,blind_at").eq("id", l.candidate_id).maybeSingle();
        n = Math.max(0, Math.min(12, Number(c?.blind_pages) || 0)); folder = "cand-" + l.candidate_id; at = c?.blind_at;
      }
      if (!n) return json({ ok: true, pages: [] });
      const v = at ? new Date(at).getTime() : 0;
      const { data: signed, error } = await admin.storage.from("blind-resumes").createSignedUrls(Array.from({ length: n }, (_, i) => `${folder}/${i + 1}.webp`), 300);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, client: (l as any).jobs?.client || "", pages: (signed || []).map((x: any) => x.signedUrl).filter(Boolean), v });
    }

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
