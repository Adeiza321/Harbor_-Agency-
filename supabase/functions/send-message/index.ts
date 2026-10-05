import { createClient } from "npm:@supabase/supabase-js@2";
import { Brand, button, emailShell, esc, loadBrand, sendBrevo } from "./brand.ts";

// Recruiter -> candidate emails, branded with the agency name from Agency settings.
//   invite   once a candidate is connected to a recruiter on a role
//   reply    a recruiter's message on a role's thread (also emailed)
//   draft_reject / preview_reject / reject
//            recording why a candidate was rejected (by the client, or by us before they were
//            put forward) and telling the candidate why, by email and on their candidate page.
// The candidate's side of messaging lives in SQL functions (candidate_portal etc.).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// The candidate's page (?c=<token>) is served by the same app as the dashboard.
const PORTAL_BASE = Deno.env.get("PORTAL_BASE_URL") || "https://harbor.link";

export const REJECT_REASONS: Record<string, string> = {
  experience: "Not enough experience",
  skill: "Missing a must-have skill",
  salary: "Salary expectation",
  location: "Location / work authorisation",
  notice: "Notice period",
  other_candidate: "Client chose another candidate",
  role_closed: "Role filled or paused",
  interview: "Interview performance",
  other: "Other",
};

// What the candidate reads if nobody writes anything more specific.
function defaultReasonText(reason: string, kind: string) {
  const who = kind === "client" ? "the client" : "we";
  switch (reason) {
    case "experience": return `For this role ${who} needed someone with more experience at this level.`;
    case "skill": return `This role needs a specific skill or background that ${who === "we" ? "we" : "they"} couldn't see strongly enough in your profile.`;
    case "salary": return "Your salary expectations and the budget for this role were too far apart.";
    case "location": return "The role's location or work authorisation requirements didn't match your situation.";
    case "notice": return "The client needs someone who can start sooner than your notice period allows.";
    case "other_candidate": return "The client chose to move forward with another candidate whose background was a closer match.";
    case "role_closed": return "The role has been filled or put on hold, so it isn't moving forward right now.";
    case "interview": return "After the interview, the client felt another candidate was a closer fit for what they need.";
    default: return `${kind === "client" ? "The client" : "We"} decided this role isn't the right match at this time.`;
  }
}

function rejectEmail(b: Brand, o: { name: string; role: string; company: string; kind: string; message: string; recruiter: string; portalUrl: string }) {
  const first = esc(String(o.name || "there").split(" ")[0]);
  const roleLine = o.company ? `the <b>${esc(o.role)}</b> role at <b>${esc(o.company)}</b>` : `the <b>${esc(o.role)}</b> role`;
  const decision = o.kind === "client"
    ? "After reviewing your profile, the client has decided not to move forward."
    : "After reviewing your profile against this role, we've decided not to put you forward for it.";
  const subject = `An update on ${o.role}${o.company ? " at " + o.company : ""}`;
  const html = emailShell(b, subject,
    `<div style="font-size:20px;margin-bottom:8px;">Hi ${first},</div>
     <div style="font-size:15px;line-height:1.6;">Thank you for your time and interest in ${roleLine}. ${decision}</div>
     <div style="margin-top:14px;padding:14px 16px;background:#F3EFE7;border-radius:10px;font-size:14px;line-height:1.55;"><div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:.06em;color:#56605A;margin-bottom:6px;">WHY</div>${esc(o.message).replace(/\n/g, "<br>")}</div>
     <div style="font-size:15px;line-height:1.6;margin-top:14px;">This decision is about this one role, not about you. Your profile stays active with us, and ${esc(o.recruiter || "your recruiter")} will reach out when a role that fits comes up.</div>
     ${button(b, o.portalUrl, "See roles that fit you")}`);
  return { subject, html };
}

async function askClaude(system: string, text: string): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("AI isn't configured (ANTHROPIC_API_KEY)");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001", max_tokens: 600, temperature: 0.3, system, messages: [{ role: "user", content: text }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("AI request failed (" + res.status + ")");
  return (data.content || []).map((x: any) => x.text || "").join("").trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json();
    const { action, linkId } = body;

    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("id,role,status,full_name").eq("id", caller.user.id).single();
    if (!me || me.status !== "Active") return json({ error: "Your account is not active" }, 403);
    const isStaff = me.role === "admin" || me.role === "recops";
    const brand = await loadBrand(admin);

    // The link (candidate + role) when there is one; rejecting can also be done without a role.
    let link: any = null;
    if (linkId) {
      const { data } = await admin.from("candidate_jobs").select("id,candidate_id,job_id,stage,candidate_response").eq("id", linkId).maybeSingle();
      if (!data) return json({ error: "This role link could not be found" }, 404);
      link = data;
    } else if (action === "invite" || action === "reply") return json({ error: "linkId is required" }, 400);
    const candidateId = link ? link.candidate_id : String(body.candidateId || "");
    if (!candidateId) return json({ error: "candidateId is required" }, 400);
    const { data: cand } = await admin.from("candidates").select("id,name,email,recruiter_id,portal_token,status,pitch_consent,pitch_consent_at").eq("id", candidateId).single();
    if (!cand) return json({ error: "Candidate not found" }, 404);
    const { data: job } = link ? await admin.from("jobs").select("role_title,client").eq("id", link.job_id).maybeSingle() : { data: null };
    if (!isStaff && cand.recruiter_id !== me.id) {
      const { data: jr } = link ? await admin.from("job_recruiters").select("recruiter_id").eq("job_id", link.job_id).eq("recruiter_id", me.id).maybeSingle() : { data: null };
      if (!jr) return json({ error: "You don't have access to this candidate" }, 403);
    }
    const roleLabel = job ? `${job.role_title} at ${job.client}` : "your role";
    const portalUrl = `${PORTAL_BASE}/?c=${cand.portal_token}`;
    const recruiterName = me.full_name || "your recruiter";
    const firstName = esc(String(cand.name || "there").split(" ")[0]);

    // First email: also ask whether we may present them anonymously to other employers. Asked
    // until they answer on their candidate page (the link opens the question there; nothing is
    // recorded from the email itself, so a mail scanner opening links can't opt anyone in).
    const pitchAsk = (b: typeof brand, href: string) =>
      `<div style="margin-top:26px;padding:16px 18px;border:1px solid #E4DED2;border-radius:12px;background:#FAF8F3;">
         <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Can we pitch you for other roles?</div>
         <div style="font-size:14px;line-height:1.6;color:#56605A;">When a company is hiring for a role you fit, we can describe your experience to them without your name or current employer. Nothing about you is shared until you say yes to a specific role, and you can change your mind any time.</div>
         <a href="${esc(href)}" style="display:inline-block;margin-top:12px;padding:10px 18px;border:1.5px solid ${b.color};color:${b.color};text-decoration:none;border-radius:10px;font-family:Arial,sans-serif;font-size:14px;font-weight:600;">Choose on your candidate page</a>
       </div>`;

    if (action === "invite") {
      if (!cand.email) return json({ ok: true, skipped: "No email on file for this candidate" });
      const html = emailShell(brand, `Message ${recruiterName} about ${roleLabel}`,
        `<div style="font-size:20px;margin-bottom:8px;">Hi ${firstName},</div>
         <div style="font-size:15px;line-height:1.6;">You're now connected with <b>${esc(recruiterName)}</b> for <b>${esc(roleLabel)}</b>. Got a question along the way? Reach out any time.</div>
         ${button(brand, portalUrl, "Message your recruiter")}
         ${cand.pitch_consent || cand.pitch_consent_at ? "" : pitchAsk(brand, portalUrl + "&pitch=1")}`);
      const sent = await sendBrevo(brand, { email: cand.email, name: cand.name }, `Message ${recruiterName} about ${roleLabel}`, html);
      return json({ ok: true, sent });
    }

    if (action === "reply") {
      const text = String(body.body || "").trim().slice(0, 4000);
      if (!text) return json({ error: "Write a message first" }, 400);
      const { data: row, error } = await admin.from("candidate_job_messages")
        .insert({ link_id: linkId, sender: "recruiter", author_id: me.id, body: text, recruiter_read_at: new Date().toISOString() })
        .select().single();
      if (error) return json({ error: error.message }, 400);
      let sent = false;
      if (cand.email) {
        const preview = text.length > 160 ? text.slice(0, 160) + "…" : text;
        const html = emailShell(brand, "You have a message from your recruiter",
          `<div style="font-size:20px;margin-bottom:8px;">Hi ${firstName},</div>
           <div style="font-size:15px;line-height:1.6;">${esc(recruiterName)} sent you a message about <b>${esc(roleLabel)}</b>:</div>
           <div style="margin-top:14px;padding:14px 16px;background:#F3EFE7;border-radius:10px;font-size:14px;font-style:italic;line-height:1.5;">&ldquo;${esc(preview)}&rdquo;</div>
           ${button(brand, portalUrl, "Reply")}`);
        sent = await sendBrevo(brand, { email: cand.email, name: cand.name }, "You have a message from your recruiter", html);
      }
      return json({ ok: true, message: row, sent });
    }

    // ---- Rejection ----
    const kind = body.kind === "client" ? "client" : "internal";
    const reason = REJECT_REASONS[body.reason] ? String(body.reason) : "";
    const feedback = String(body.feedback || "").trim().slice(0, 3000);

    // A short, kind, specific explanation for the candidate, from the reason and the feedback.
    if (action === "draft_reject") {
      if (!reason) return json({ error: "Pick the main reason first" }, 400);
      if (!feedback) return json({ ok: true, message: defaultReasonText(reason, kind) });
      const system = "You write the 'why' paragraph of a rejection email from a recruitment agency to a candidate. 2 to 3 sentences, plain text, warm, honest and specific, " +
        "written to the candidate as 'you'. Explain the real reason using the feedback, and where the feedback names a genuine strength, mention it. Never include anything insulting, " +
        "anything about age, gender, race, religion, health, family, nationality or other personal characteristics, salary figures, or internal names. Don't apologise at length, " +
        "don't promise future roles, no greeting or sign-off. Reply with the paragraph only.";
      const who = kind === "client" ? "The client" : "The agency (before putting them forward)";
      const text = await askClaude(system, `Role: ${roleLabel}\nDecision by: ${who}\nMain reason: ${REJECT_REASONS[reason]}\nFeedback (internal notes, rewrite kindly; don't quote harsh wording):\n${feedback}`);
      return json({ ok: true, message: text.replace(/^["']|["']$/g, "").slice(0, 1200) });
    }

    if (action === "preview_reject") {
      const m = rejectEmail(brand, { name: cand.name, role: job?.role_title || "the role", company: job?.client || "", kind, message: String(body.message || defaultReasonText(reason || "other", kind)), recruiter: String(me.full_name || "").split(" ")[0], portalUrl });
      return json({ ok: true, subject: m.subject, html: m.html, to: cand.email || "" });
    }

    if (action === "reject") {
      if (!reason) return json({ error: "Pick the main reason" }, 400);
      const message = String(body.message || "").trim().slice(0, 1500) || defaultReasonText(reason, kind);
      const notify = body.notify !== false;
      const now = new Date().toISOString();
      if (link) {
        await admin.from("candidate_jobs").update({ stage: "Rejected", outcome_at: now, reject_kind: kind, reject_reason: reason, reject_feedback: feedback || null, reject_message: notify ? message : null, rejected_at: now, rejected_by: me.id }).eq("id", link.id);
      }
      // Back to Active file (kept searchable) unless they're still live on another role.
      const { data: others } = await admin.from("candidate_jobs").select("id").eq("candidate_id", cand.id).neq("id", link?.id || "00000000-0000-0000-0000-000000000000")
        .in("stage", ["Submitted", "Interview", "Offer"]).neq("candidate_response", "declined").limit(1);
      if (!others?.length) await admin.from("candidates").update({ status: "Active file" }).eq("id", cand.id).not("status", "in", "(Placed,Hired)");
      const label = REJECT_REASONS[reason];
      await admin.from("candidate_timeline").insert({ candidate_id: cand.id, title: (kind === "client" ? "Rejected by the client" : "Rejected") + (job ? " for " + job.role_title + ", " + job.client : "") + ": " + label + (others?.length ? "" : " — moved to Active file"), done: true });
      let emailed = false;
      if (notify) {
        if (link) await admin.from("candidate_job_messages").insert({ link_id: link.id, sender: "recruiter", author_id: me.id, body: (kind === "client" ? "The client has decided not to move forward with your profile for this role. " : "We've decided not to put you forward for this role. ") + message, recruiter_read_at: now });
        if (cand.email) {
          const m = rejectEmail(brand, { name: cand.name, role: job?.role_title || "the role", company: job?.client || "", kind, message, recruiter: String(me.full_name || "").split(" ")[0], portalUrl });
          emailed = await sendBrevo(brand, { email: cand.email, name: cand.name }, m.subject, m.html);
        }
      }
      return json({ ok: true, emailed, movedToActiveFile: !others?.length });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
