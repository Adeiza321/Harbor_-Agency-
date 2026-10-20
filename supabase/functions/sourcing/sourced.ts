// Someone a recruiter found by X-ray is interested (their "I'm interested" click, applying through the
// outreach link, a reply marked interested, or the recruiter marking it after a LinkedIn chat): they
// become that recruiter's candidate on the role straight away, the same way the Inbox assigns people.
// Called by the database (trigger prospects_sourced_interest) and swept every tick as a safety net.
import { assignApplication } from "../inbox/assign.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sourcedInterest(admin: any, prospectId: string) {
  const { data: p } = await admin.from("prospects").select("id,job_id,status,sourced_by,candidate_id,full_name,first_name,last_name,email,linkedin_url,data,jobs(role_title,status)").eq("id", prospectId).maybeSingle();
  if (!p || p.status !== "interested" || !p.sourced_by || p.candidate_id) return { ok: true, skipped: "nothing to do" };
  const { data: rec } = await admin.from("profiles").select("id,full_name,role,status").eq("id", p.sourced_by).maybeSingle();
  // Only people a recruiter found go to them automatically; staff searches stay with the Inbox flow.
  if (!rec || rec.status !== "Active" || rec.role !== "recruiter") return { ok: true, skipped: "not found by an active recruiter" };
  const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Sourced candidate";
  const linkedin = p.linkedin_url || p.data?.profile_url || null;
  const roleTitle = (p as any).jobs?.role_title || "Role";

  // Their "I'm interested" click or application files an Inbox row at the same moment: use that one.
  let app: any = null;
  for (let i = 0; i < 3 && !app; i++) {
    if (p.email) {
      const { data } = await admin.from("applications").select("*").eq("job_id", p.job_id).ilike("email", p.email).order("created_at", { ascending: false }).limit(1);
      app = (data || [])[0] || null;
    }
    if (!app && linkedin) {
      const { data } = await admin.from("applications").select("*").eq("job_id", p.job_id).eq("linkedin", linkedin).order("created_at", { ascending: false }).limit(1);
      app = (data || [])[0] || null;
    }
    if (!app && i < 2 && p.email) await sleep(1500);
  }
  if (app && app.status === "assigned") {
    await admin.from("prospects").update({ candidate_id: app.candidate_id }).eq("id", p.id).is("candidate_id", null);
    return { ok: true, skipped: "already assigned", candidateId: app.candidate_id };
  }
  if (!app) {
    const { data, error } = await admin.from("applications").insert({ name, email: p.email || null, linkedin, role_title: roleTitle, job_id: p.job_id, source: "outreach", via_recruiter: rec.id, interest_at: new Date().toISOString(), status: "new" }).select("*").single();
    if (error) throw new Error("Couldn't file the interest: " + error.message);
    app = data;
  } else if (app.status === "dismissed") {
    await admin.from("applications").update({ status: "new" }).eq("id", app.id);
    app.status = "new";
  }
  const r = await assignApplication(admin, app, rec, { id: rec.id, name: "ProNext, because " + (rec.full_name || "they") + " sourced them" });
  await admin.from("prospects").update({ candidate_id: r.candidateId }).eq("id", p.id);
  try {
    await admin.rpc("push_update", { p_user: rec.id, p_kind: "event", p_title: name + " is interested in " + roleTitle,
      p_body: "You found them, so they're your candidate now, on the role.", p_link: { page: "candidates", candidateId: r.candidateId },
      p_dedupe: "sourced:" + p.id, p_covered: false, p_actor: null });
  } catch (_) { /* best effort */ }
  return { ok: true, candidateId: r.candidateId, recruiter: rec.full_name };
}

// Safety net (every tick): interested people found by recruiters who aren't anyone's candidate yet.
export async function sweepSourcedInterest(admin: any) {
  const { data: recs } = await admin.from("profiles").select("id").eq("role", "recruiter").eq("status", "Active");
  const ids = (recs || []).map((r: any) => r.id);
  if (!ids.length) return { checked: 0, assigned: 0 };
  const { data } = await admin.from("prospects").select("id").eq("status", "interested").in("sourced_by", ids).is("candidate_id", null).order("created_at", { ascending: false }).limit(10);
  let done = 0; const errors: string[] = [];
  for (const p of data || []) {
    try { const r: any = await sourcedInterest(admin, p.id); if (r.candidateId) done++; } catch (e) { errors.push(String((e as Error)?.message || e).slice(0, 160)); }
  }
  return { checked: (data || []).length, assigned: done, ...(errors.length ? { errors } : {}) };
}
