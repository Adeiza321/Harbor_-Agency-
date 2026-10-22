// Turns an application into a candidate for a team member. Used by the Inbox (Rec Ops assigning
// it) and by submit-application (someone applied through a recruiter's own link, so it goes
// straight to them). Reuses the candidate with the same email if there is one, copies the CV
// into their own folder, puts them on the job (which starts the automatic AI screening) or, with
// no job (they sent their CV for the Active file), files them on the Active file.

const normEmail = (e: string) => { const [u, d] = String(e || "").trim().toLowerCase().split("@"); return d ? u.replace(/\+.*$/, "") + "@" + d : ""; };

export async function assignApplication(admin: any, app: any, rec: { id: string; full_name?: string | null }, by: { id: string; name: string; viaLink?: boolean }) {
  const now = new Date().toISOString();
  let candId: string | null = null, reused = false;
  const em = normEmail(app.email || "");
  if (em) {
    const { data: same } = await admin.from("candidates").select("id,email,resume_path,is_draft").eq("is_draft", false).ilike("email", "%@" + em.split("@")[1]);
    const hit = (same || []).find((c: any) => normEmail(c.email) === em);
    if (hit) {
      candId = hit.id; reused = true;
      // Back from being unassigned: they get the new recruiter.
      await admin.from("candidates").update({ recruiter_id: rec.id }).eq("id", hit.id).is("recruiter_id", null);
    }
  }
  if (!candId) {
    const { data: c, error } = await admin.from("candidates").insert({
      name: app.name, role_title: app.role_title || "Unspecified", email: app.email || null, phone: app.phone || null,
      linkedin_url: app.linkedin || null, recruiter_id: rec.id, status: app.job_id ? "In review" : "Active file", source: app.source || "Inbox", is_draft: false,
    }).select("id").single();
    if (error) throw new Error("Couldn't create the candidate: " + error.message);
    candId = c.id;
  }

  // CV: copied into the candidate's own folder (kept on the application too).
  if (app.resume_path) {
    const { data: cand } = await admin.from("candidates").select("resume_path").eq("id", candId).single();
    if (!cand?.resume_path || !reused) {
      const file = String(app.resume_name || "CV").replace(/[^A-Za-z0-9._-]+/g, "-").slice(-80);
      const dest = `${candId}/${Date.now()}-${file}`;
      const { error: cpErr } = await admin.storage.from("resumes").copy(app.resume_path, dest);
      if (cpErr) console.error("cv copy", app.id, cpErr.message);
      else await admin.from("candidates").update({ resume_path: dest, resume_name: app.resume_name || "CV" }).eq("id", candId);
    }
  }

  // Answers from the Send-us-your-CV form ("Help us match you"): theirs now, unless they've since
  // given newer ones on their candidate page. Joining the Active file means they agreed to be put forward.
  if (app.preferences && typeof app.preferences === "object") {
    const { data: cur } = await admin.from("candidates").select("preferences,pitch_consent_at").eq("id", candId).single();
    if (!cur?.preferences) {
      const p = app.preferences, sal = p.salary || {};
      const n = (x: unknown) => Number(x).toLocaleString("en-US");
      const pay = sal.currency && Number(sal.min) > 0 ? sal.currency + " " + n(sal.min) + (Number(sal.max) > Number(sal.min) ? " – " + n(sal.max) : "") + " per " + (sal.period || "year") : null;
      await admin.from("candidates").update({
        preferences: p, preferences_at: now, pitch_consent: true, pitch_consent_at: cur?.pitch_consent_at || now,
        ...(pay ? { pay } : {}), ...(p.availability ? { notice: p.availability } : {}),
        ...(p.currentCity && p.currentCountry ? { location: p.currentCity + ", " + p.currentCountry } : {}),
      }).eq("id", candId);
    }
  }

  // On the job (starts the automatic AI screening).
  let linkId: string | null = null;
  if (app.job_id) {
    const { data: existing } = await admin.from("candidate_jobs").select("id").eq("candidate_id", candId).eq("job_id", app.job_id).maybeSingle();
    if (existing) linkId = existing.id;
    else {
      const { data: link, error } = await admin.from("candidate_jobs").insert({
        candidate_id: candId, job_id: app.job_id, stage: "In review", candidate_response: "accepted", added_by: by.id,
        screening_answers: Array.isArray(app.answers) ? app.answers : [],
      }).select("id").single();
      if (error) throw new Error(error.message);
      linkId = link.id;
    }
  }

  const refBy = app.referrer && typeof app.referrer === "object" && app.referrer.name ? app.referrer : null;
  const sourceLabel = app.source === "career_page" ? "the apply page" : app.source === "outreach" ? "an outreach email"
    : app.source === "referral" ? "a referral" + (refBy ? " from " + refBy.name + (refBy.email ? " (" + refBy.email + ")" : "") : "") : (app.source || "the Inbox");
  const what = app.job_id ? (app.role_title ? " for " + app.role_title : "") : " to join the Active file" + (app.role_title ? " (looking for " + app.role_title + ")" : "");
  const who = by.viaLink ? ", through " + (rec.full_name || "their recruiter") + "'s link" : ", assigned to " + (rec.full_name || "a recruiter") + " by " + by.name;
  await admin.from("candidate_timeline").insert({ candidate_id: candId, title: (app.source === "referral" ? "Came in via " : "Applied via ") + sourceLabel + what + who, done: true });
  await admin.from("applications").update({ status: "assigned", assigned_to: rec.id, candidate_id: candId, handled_at: now, handled_by: by.id }).eq("id", app.id);
  return { candidateId: candId, linkId, reused };
}
