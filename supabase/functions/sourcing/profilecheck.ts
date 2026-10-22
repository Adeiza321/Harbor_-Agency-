// Full-profile check (paid), the must-have check's fallback: an Apollo person who passed the check
// but whose core must-haves (the first three) aren't shown anywhere free is held back from emailing
// (data.profile_hold) and an Admin is asked to approve reading their full profile from People Data
// Labs (1 credit per profile found; no match is free). One request per role, topped up as more
// people need it. On approval each is checked again with the full profile: skipped if a core
// must-have is now clearly not met, otherwise released to be emailed. Declined, or People Data Labs
// not connected: they're released as they are (the gaps stay on their card to confirm).
import { pdlKey, pdlProfile } from "./pdl.ts";
import { assessPeople, checkedData, skippedData } from "./musthaves.ts";
import { requestSpend, estimate, costText } from "./approvals.ts";
import type { Settings } from "./common.ts";

export async function holdForProfileCheck(admin: any, s: Settings, jobId: string, ids: string[]) {
  if (!ids.length || !pdlKey()) return { held: 0 };
  const { data: job } = await admin.from("jobs").select("role_title,client").eq("id", jobId).maybeSingle();
  const { data: rows } = await admin.from("prospects").select("id,data").in("id", ids).eq("status", "found");
  for (const r of rows || []) await admin.from("prospects").update({ data: { ...(r.data || {}), profile_hold: true } }).eq("id", r.id);
  const heldIds = (rows || []).map((r: any) => r.id);
  if (!heldIds.length) return { held: 0 };
  const title = (n: number) => `Check the full profiles of ${n} ${n === 1 ? "person" : "people"} found in Apollo for ${job?.role_title || "a role"}${job?.client ? ", " + job.client : ""} (their core must-haves aren't shown anywhere free)`;
  const { request, created } = await requestSpend(admin, "pdl_profiles", s, { jobId, title: title(heldIds.length), payload: { ids: heldIds }, count: heldIds.length });
  if (!created) {
    // Topped up: one request per role.
    const all = [...new Set([...(Array.isArray(request.payload?.ids) ? request.payload.ids : []), ...heldIds])];
    await admin.from("spend_requests").update({ payload: { ...(request.payload || {}), ids: all }, title: title(all.length), cost_text: costText(estimate("pdl_profiles", s, all.length)) }).eq("id", request.id);
  }
  return { held: heldIds.length };
}

export async function releaseProfileHold(admin: any, ids: string[], note?: string) {
  if (!ids.length) return;
  const { data: rows } = await admin.from("prospects").select("id,data").in("id", ids);
  for (const r of rows || []) {
    if (!r.data?.profile_hold) continue;
    const { profile_hold: _h, ...rest } = r.data;
    await admin.from("prospects").update({ data: { ...rest, profile_checked: { at: new Date().toISOString(), note: note || "" } } }).eq("id", r.id);
  }
}

export async function runProfileChecks(admin: any, jobId: string, ids: string[]) {
  if (!pdlKey()) { await releaseProfileHold(admin, ids, "People Data Labs isn't connected"); return { ok: false, message: "People Data Labs isn't connected, so the people waiting were released without the check." }; }
  const { data: job } = await admin.from("jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, message: "This job no longer exists." };
  const { data: rows } = await admin.from("prospects").select("id,status,title,company,location,linkedin_url,data").in("id", ids);
  const todo = (rows || []).filter((r: any) => r.status === "found" && r.data?.profile_hold && r.linkedin_url);
  const profiles = new Map<string, any>();
  let matched = 0, stopped = "";
  for (const r of todo) {
    try { const p = await pdlProfile(r.linkedin_url); if (p) { profiles.set(r.id, p); matched++; } }
    catch (e) {
      const m = String((e as Error)?.message || e);
      console.error("pdl profile", m.slice(0, 200));
      if (/\b(401|402|403|429)\b/.test(m)) { stopped = /\b402\b/.test(m) ? "People Data Labs is out of credit" : "People Data Labs refused the request (" + m.slice(0, 80) + ")"; break; }
    }
  }
  const found = todo.filter((r: any) => profiles.has(r.id));
  const res = await assessPeople(admin, job, found.map((r: any) => {
    const p = profiles.get(r.id);
    return { id: r.id, title: r.title, company: r.company, location: r.location, history: r.data?.history, headline: r.data?.headline, linkedin: r.data?.linkedin,
      profile: { headline: p.headline, summary: p.summary, skills: p.skills, history: p.history, education: p.education } };
  }));
  let skipped = 0, released = 0;
  for (const r of found) {
    const a = res.get(r.id);
    if (!a) continue;
    const { profile_hold: _h, ...rest } = r.data || {};
    const data = { ...rest, ...checkedData(a, r.data?.linkedin, "full profile"), profile_checked: { at: new Date().toISOString(), found: true } };
    if (!a.keep) { await admin.from("prospects").update({ status: "rejected", fit: a.fit, verdict: a.verdict, fit_reason: a.reason || null, data: { ...data, ...skippedData(a.why, "full-profile check") } }).eq("id", r.id); skipped++; }
    else { await admin.from("prospects").update({ fit: a.fit, verdict: a.verdict, fit_reason: a.reason || null, data }).eq("id", r.id); released++; }
  }
  // Not in People Data Labs, not checked this time, or the check stopped: released as they are.
  const rest = todo.filter((r: any) => !res.has(r.id)).map((r: any) => r.id);
  await releaseProfileHold(admin, rest, stopped || "No full profile found");
  return { ok: true, checked: found.length, matched, skipped, released: released + rest.length,
    message: `Checked ${found.length} full ${found.length === 1 ? "profile" : "profiles"} (${matched} People Data Labs ${matched === 1 ? "credit" : "credits"}): ${skipped} skipped for missing a core must-have, ${released + rest.length} ready to email.` + (stopped ? ` Stopped early: ${stopped}.` : "") };
}
