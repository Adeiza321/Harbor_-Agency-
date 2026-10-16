import { createClient } from "npm:@supabase/supabase-js@2";
import { aiCharge, askAI } from "../sourcing/ai.ts";
import { fitsToPercent } from "../sourcing/common.ts";
import { judge, reviewHead, REVIEW_SYSTEM } from "../sourcing/xray_rules.ts";
import { splitByArea } from "../sourcing/area_check.ts";

// Re-checks X-ray people already found (status 'found' only — never anyone emailed, queued or
// skipped) against the current X-ray rules, from the search result saved with each of them. The
// rules are the X-ray search's own (../sourcing/xray_rules.ts), so a re-check and a new search judge
// people the same way.
//   POST { action: "review", limit? } + x-harbor-ops or an Admin  -> reviews the next batch not yet
//        re-checked; writes data.recheck = { keep, reasons[], notes[], fit, verdict, why, at } and, for
//        people kept, refreshes their fit, location and notes (nothing is removed)
//   POST { action: "reset" }                                       -> clears data.recheck so everyone
//        is reviewed again (after the rules change)
//   POST { action: "summary" }                                     -> counts and who would go
//   POST { action: "apply", ids? }                                 -> deletes those marked keep=false
//        (only the given ids when ids is sent)

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-harbor-ops" } });
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function review(admin: any, limit: number) {
  const { data: rows } = await admin.from("prospects").select("id,job_id,full_name,title,company,location,fit,verdict,data")
    .eq("status", "found").eq("data->>xray", "true").is("data->recheck", null).order("job_id").limit(limit);
  const list = rows || [];
  if (!list.length) return { reviewed: 0, done: true };
  const jobIds = [...new Set(list.map((r: any) => r.job_id))];
  const { data: jobs } = await admin.from("jobs").select("*").in("id", jobIds);
  const jobById = new Map((jobs || []).map((j: any) => [j.id, j]));
  let reviewed = 0, removed = 0;
  for (const jobId of jobIds) {
    const job: any = jobById.get(jobId);
    const people = list.filter((r: any) => r.job_id === jobId);
    if (!job) { for (const p of people) await mark(admin, p, null, ["Role no longer exists"]); reviewed += people.length; removed += people.length; continue; }
    const checklist: string[] = Array.isArray(job.xray?.checklist) ? job.xray.checklist : [];
    const head = reviewHead(job, job.sourcing?.area, checklist);
    for (let i = 0; i < people.length; i += 10) {
      const b = people.slice(i, i + 10);
      const out = await askAI(REVIEW_SYSTEM, head + b.map((p: any, k: number) =>
        `${k} | ${clip(p.data?.site || "linkedin", 20)} | ${clip(p.data?.result_title || p.full_name + " - " + (p.title || ""), 200)} | ${clip(p.data?.snippet || "", 500) || "(no snippet)"}${p.location ? " | Location on file: " + clip(p.location, 80) : ""}`).join("\n"), 12000);
      const byI = new Map(fitsToPercent(Array.isArray(out?.people) ? out.people : []).map((r: any) => [Number(r.i), r]));
      const done: { p: any; r: any; j: any }[] = [];
      for (let k = 0; k < b.length; k++) {
        const p: any = b[k], r: any = byI.get(k);
        if (!r) continue; // tried again next run
        done.push({ p, r, j: judge(job, { title: p.data?.result_title || "", snippet: p.data?.snippet || "" }, { ...r, location: r.location || p.location || "" }) });
      }
      // The place itself, checked against the office in code (same as a new X-ray search).
      const keepers = done.filter((d) => d.j.keep);
      try {
        const { kept: ok, dropped } = await splitByArea(admin, job, job.sourcing?.area, keepers, (d) => d.j.location || d.p.location);
        for (const { p: d, why } of dropped) { d.j = { ...d.j, keep: false, reasons: [why], verdict: "Not a fit" }; }
        for (const { p: d, note, hold } of ok) if (note) d.j = { ...d.j, hold: hold || null, gaps: [note, ...d.j.gaps].slice(0, 5), notes: [...d.j.notes, note] };
      } catch (e) { console.error("area check", String((e as Error)?.message || e)); }
      for (const { p, r, j } of done) {
        await mark(admin, p, { ...j, why: clip(r.why, 140) }, j.reasons);
        reviewed++; if (!j.keep) removed++;
      }
    }
  }
  return { reviewed, toRemove: removed, done: false };
}

async function mark(admin: any, p: any, j: any, reasons: string[]) {
  const keep = !!j && reasons.length === 0;
  const data = { ...(p.data || {}), recheck: { keep, reasons, notes: j?.notes || [], fit: j?.fit ?? null, verdict: j?.verdict || null, why: j?.why || "", at: new Date().toISOString() } };
  const upd: Record<string, unknown> = { data };
  if (keep) {
    // Kept: refreshed with the current reading (location, tags, fit, checklist, notes).
    Object.assign(data, { ...(p.data?.location_ok ? {} : { location_hold: j.hold || null }), client_history: j.clientHistory, location_source: j.locationSource, remote_worker: j.remote, own_practice: j.ownPractice, checklist: j.checklist, gaps: j.gaps });
    upd.fit = j.fit; upd.verdict = j.verdict; if (j.location) upd.location = j.location;
  }
  await admin.from("prospects").update(upd).eq("id", p.id).eq("status", "found");
}

Deno.serve((req: Request) => aiCharge.run({ feature: "xray_recheck", userId: null }, () => handle(req)));
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return json({ ok: true });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const opsKey = req.headers.get("x-harbor-ops") || "";
    if (opsKey) {
      const { data: tok } = await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!tok || opsKey.length < 32) return json({ error: "Invalid ops token" }, 403);
    } else {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: caller } = await admin.auth.getUser(jwt);
      const { data: me } = caller?.user ? await admin.from("profiles").select("role,status").eq("id", caller.user.id).single() : { data: null };
      if (!me || me.role !== "admin" || me.status !== "Active") return json({ error: "Only admins can re-check X-ray people" }, 403);
    }
    const body = await req.json().catch(() => ({}));
    if (body.action === "review") return json({ ok: true, ...(await review(admin, Math.min(60, Math.max(1, Number(body.limit) || 30)))) });
    const { data } = await admin.from("prospects").select("id,full_name,title,data").eq("status", "found").eq("data->>xray", "true");
    const all = data || [];
    if (body.action === "reset") {
      let n = 0;
      for (const p of all) if (p.data?.recheck) { const d = { ...p.data }; delete d.recheck; await admin.from("prospects").update({ data: d }).eq("id", p.id).eq("status", "found"); n++; }
      return json({ ok: true, reset: n });
    }
    if (body.action === "summary" || body.action === "apply") {
      const checked = all.filter((p: any) => p.data?.recheck);
      let go = checked.filter((p: any) => p.data.recheck.keep === false);
      if (body.action === "summary") {
        const why: Record<string, number> = {};
        for (const p of go) for (const r of p.data.recheck.reasons || []) { const k = String(r).split(":")[0].replace(/^Based in .*/, "Based outside the role's country").replace(/^Works at .*/, "Works at the client now").replace(/^Low fit.*/, "Low fit"); why[k] = (why[k] || 0) + 1; }
        return json({ ok: true, total: all.length, checked: checked.length, keep: checked.length - go.length, remove: go.length, why, sample: go.slice(0, 40).map((p: any) => ({ id: p.id, name: p.full_name, title: p.title, reasons: p.data.recheck.reasons })) });
      }
      if (Array.isArray(body.ids)) { const want = new Set(body.ids.map(String)); go = go.filter((p: any) => want.has(p.id)); }
      let deleted = 0;
      for (let i = 0; i < go.length; i += 100) {
        const ids = go.slice(i, i + 100).map((p: any) => p.id);
        const { data: del } = await admin.from("prospects").delete().in("id", ids).eq("status", "found").select("id");
        deleted += (del || []).length;
      }
      return json({ ok: true, deleted });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("xray-recheck", String((e as Error)?.message || e));
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
}
