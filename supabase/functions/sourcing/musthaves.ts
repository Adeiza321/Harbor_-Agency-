// The must-have checklist for people found outside ProNext who don't come from X-ray (Apollo, PDL),
// so every sourced person shows the same thing on their card: a summary, then each must-have as
// met / not met / not shown. The list is the role's X-ray checklist when X-ray has planned one,
// otherwise 5 to 8 must-haves taken from the job's own requirements (saved on jobs.sourcing.musts so
// every person on the role is checked against the same list).
import { askAI } from "./ai.ts";
import { jobBrief } from "./prospects.ts";

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function roleMustHaves(admin: any, job: any): Promise<string[]> {
  const fromXray: string[] = Array.isArray(job?.xray?.checklist) ? job.xray.checklist.filter(Boolean) : [];
  if (fromXray.length) return fromXray.slice(0, 8);
  const saved: string[] = Array.isArray(job?.sourcing?.musts) ? job.sourcing.musts.filter(Boolean) : [];
  if (saved.length) return saved.slice(0, 8);
  const out = await askAI(
    "From this job, list its 5 to 8 most important hiring requirements (must-haves), each a few words a profile could show: experience, level, skills, certifications, location or work setup. Most important first. Reply with STRICT JSON only: {\"musts\": string[]}.",
    jobBrief(job, false), 800);
  const musts = [...new Set((Array.isArray(out?.musts) ? out.musts : []).map((m: unknown) => clip(m, 80)).filter(Boolean))].slice(0, 8) as string[];
  if (musts.length) {
    const { data: row } = await admin.from("jobs").select("sourcing").eq("id", job.id).maybeSingle();
    await admin.from("jobs").update({ sourcing: { ...(row?.sourcing || {}), musts, musts_at: new Date().toISOString() } }).eq("id", job.id);
  }
  return musts;
}

const SYS = "You are a recruitment analyst checking people found in a contacts database against a job's must-haves. " +
  "Use only what each person's title, employer, location and work history show. Reply with STRICT JSON only: " +
  "{\"results\": [{\"id\": string, \"overview\": string, \"checklist\": [{\"item\": string, \"status\": \"met\" | \"unconfirmed\" | \"not met\", \"evidence\": string}], \"gaps\": string[]}]}. " +
  "overview: one or two plain sentences on who they are (current role, employer, relevant background) and how they line up with the job. " +
  "checklist: exactly the must-haves given, same order and wording. 'met' only when the profile clearly shows it; 'not met' only when the profile clearly contradicts it " +
  "(wrong field, level or location); otherwise 'unconfirmed' (not shown is not the same as missing). evidence: a few words from the profile, or '' when unconfirmed. " +
  "gaps: up to 3 short things a recruiter should confirm with them.";

// Checks a batch of people and saves overview, checklist and gaps onto each prospect's data.
export async function checkMustHaves(admin: any, job: any, people: { id: string; title?: string; company?: string; location?: string; data?: any }[]) {
  const musts = await roleMustHaves(admin, job);
  if (!musts.length || !people.length) return 0;
  let saved = 0;
  // Small batches: each person's checklist is long, and a cut-off answer would lose the whole batch.
  for (let i = 0; i < people.length; i += 5) {
    const batch = people.slice(i, i + 5);
    const list = batch.map((p) => `id=${p.id} | ${p.title || "?"} at ${p.company || "?"} | ${p.location || "?"} | history: ${clip(p.data?.history, 400) || "?"}`).join("\n");
    let out: any = null;
    try { out = await askAI(SYS, jobBrief(job, false) + `\n\nMust-haves:\n${musts.map((m) => "- " + m).join("\n")}\n\nPeople:\n${list}`, 8000); }
    catch (e) { console.error("must-haves batch", String((e as Error)?.message || e)); continue; }
    const byId = new Map((Array.isArray(out?.results) ? out.results : []).map((r: any) => [String(r.id), r]));
    for (const p of batch) {
      const r: any = byId.get(p.id);
      if (!r) continue;
      const given = Array.isArray(r.checklist) ? r.checklist : [];
      const checklist = musts.map((m, k) => {
        const x = given.find((g: any) => clip(g?.item, 80).toLowerCase() === m.toLowerCase()) || given[k] || {};
        const st = ["met", "not met", "unconfirmed"].includes(x.status) ? x.status : "unconfirmed";
        return { item: m, status: st, evidence: st === "unconfirmed" ? "" : clip(x.evidence, 120) };
      });
      const data = { ...(p.data || {}), overview: clip(r.overview, 400), checklist, gaps: (Array.isArray(r.gaps) ? r.gaps : []).map((g: unknown) => clip(g, 140)).filter(Boolean).slice(0, 3), musts_checked_at: new Date().toISOString() };
      await admin.from("prospects").update({ data }).eq("id", p.id);
      saved++;
    }
  }
  return saved;
}

// One-off and catch-up: everyone on a role (or all roles) who has no checklist yet, a few roles per call.
export async function backfillMustHaves(admin: any, jobId?: string, maxPeople = 60) {
  let q = admin.from("prospects").select("id,job_id,title,company,location,data").is("data->checklist", null).neq("source", "linkedin").limit(maxPeople);
  if (jobId) q = q.eq("job_id", jobId);
  const { data: rows } = await q;
  const byJob = new Map<string, any[]>();
  for (const r of rows || []) { if (r.data?.xray) continue; byJob.set(r.job_id, [...(byJob.get(r.job_id) || []), r]); }
  let saved = 0;
  for (const [jid, people] of byJob) {
    const { data: job } = await admin.from("jobs").select("*").eq("id", jid).maybeSingle();
    if (job) { try { saved += await checkMustHaves(admin, job, people); } catch (e) { console.error("must-haves job", jid, String((e as Error)?.message || e)); } }
  }
  const { count } = await admin.from("prospects").select("id", { count: "exact", head: true }).is("data->checklist", null).neq("source", "linkedin");
  return { checked: saved, remaining: count ?? null };
}
