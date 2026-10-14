import { createClient } from "npm:@supabase/supabase-js@2";
import { askAI } from "./ai.ts";
import { COUNTRY_NAMES, jobCountryNames } from "./regions.ts";

// Re-checks X-ray people already found (status 'found' only — never anyone emailed, queued or
// skipped) against the stricter X-ray rules, from the search result saved with each of them:
// current location in the role's country, core must-haves not contradicted and at least one shown,
// not working at the hiring company now, a person and not a business or business owner, and a
// closer look for remote workers on on-site roles.
//   POST { action: "review", limit? } + x-harbor-ops or an Admin  -> reviews the next batch not yet
//        re-checked; writes data.recheck = { keep, reasons[], fit, verdict, at } (nothing removed)
//   POST { action: "summary" }                                     -> counts and who would go
//   POST { action: "apply" }                                       -> deletes those marked keep=false
// The same rules as sourcing/xray.ts (kept in step by hand).

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-harbor-ops" } });
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const norm = (s: unknown) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(ltd|limited|inc|llc|plc|corp|corporation|company|co|group|the)\b/g, " ").replace(/\s+/g, " ").trim();
const sameCompany = (a: unknown, b: unknown) => { const x = norm(a), y = norm(b); return x.length > 1 && y.length > 1 && (x === y || x.startsWith(y + " ") || y.startsWith(x + " ")); };
const ALIAS: Record<string, string> = { "usa": "united states", "u.s.": "united states", "uk": "united kingdom", "england": "united kingdom", "scotland": "united kingdom", "wales": "united kingdom", "uae": "united arab emirates" };
const COUNTRIES = [...new Set(Object.values(COUNTRY_NAMES).map((x) => String(x).toLowerCase()))].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)
  .map((c) => ({ c, re: new RegExp("(^|[^a-z])" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^a-z])") }));
const countryIn = (loc: string) => {
  const l = " " + loc.toLowerCase().replace(/[()]/g, " ") + " ";
  for (const [a, c] of Object.entries(ALIAS)) if (new RegExp("[\\s,]" + a.replace(/\./g, "\\.") + "[\\s,]").test(l)) return c;
  return (COUNTRIES.find((x) => x.re.test(l)) || { c: "" }).c;
};
const OWNER = /\b(founder|co-?founder|owner|proprietor|self[- ]employed|ceo\s*(&|and|\/)?\s*founder)\b/i;
const REMOTE = /\bremote(ly)?\b|work(ing)? from home|\bwfh\b/i;

const SYS = "You are a recruitment researcher re-checking people found from search-engine results (LinkedIn and technical sites) against one job. " +
  "You only see each result's title line and short snippet. Reply with STRICT JSON only: " +
  "{\"people\": [{\"i\": number, \"headline\": string, \"company\": string, \"location\": string, \"remote\": boolean, \"client_history\": \"current\" | \"past\" | \"none\", \"business\": boolean, \"checklist\": [{\"item\": string, \"status\": \"met\" | \"unconfirmed\" | \"not met\"}], \"fit\": number, \"verdict\": \"Good fit\" | \"Possible fit\" | \"Not a fit\", \"why\": string}]}, one entry per person. " +
  "headline (current title) and company (current employer) come ONLY from the result ('' when not shown). " +
  "location: where they live or work NOW: the 'Location:' part of a LinkedIn snippet, or the place next to their current role. Never a past job's city, a school, or an employer's head office; '' when not shown. " +
  "remote: true when the result shows they work remotely or for an employer in another country than where they live. " +
  "client_history: 'current' when they work at the hiring company now, 'past' when they did before, otherwise 'none'. " +
  "business: true when the result is a business, company, agency, brand or group page rather than one person, or the person runs their own business (founder, owner, CEO / MD of their own company, self-employed agency owner). " +
  "checklist: exactly the job's checklist items, same order and wording: 'met' only when the result clearly shows it, 'not met' only when it clearly contradicts it, otherwise 'unconfirmed'. " +
  "fit 0-100. verdict: 'Good fit' only when title, seniority and field match, at least half the checklist is 'met' and nothing is 'not met'. 'Not a fit' when any of the first three checklist items is 'not met', when the field, level or title clearly doesn't match, when their current location is outside the search area, when they work for the hiring company now, or when business is true. Otherwise 'Possible fit'. " +
  "why: under 15 words.";

async function review(admin: any, limit: number) {
  const { data: rows } = await admin.from("prospects").select("id,job_id,full_name,title,company,location,fit,verdict,data")
    .eq("status", "found").eq("data->>xray", "true").is("data->recheck", null).order("job_id").limit(limit);
  const list = rows || [];
  if (!list.length) return { reviewed: 0, done: true };
  const jobIds = [...new Set(list.map((r: any) => r.job_id))];
  const { data: jobs } = await admin.from("jobs").select("id,role_title,client,location,country,work_setup,employment_type,description,xray").in("id", jobIds);
  const jobById = new Map((jobs || []).map((j: any) => [j.id, j]));
  let reviewed = 0, removed = 0;
  for (const jobId of jobIds) {
    const job: any = jobById.get(jobId);
    const people = list.filter((r: any) => r.job_id === jobId);
    if (!job) { for (const p of people) await mark(admin, p, { keep: false, reasons: ["Role no longer exists"] }); reviewed += people.length; removed += people.length; continue; }
    const checklist: string[] = Array.isArray(job.xray?.checklist) ? job.xray.checklist : [];
    const allowed = new Set(jobCountryNames(job).map((x) => x.toLowerCase()));
    const jobRemote = /remote|hybrid/i.test(String(job.work_setup || "")) || /remote|hybrid/i.test(String(job.location || ""));
    const head = `Job: ${job.role_title}\nLocation: ${job.location || "?"}${job.work_setup ? " (" + job.work_setup + ")" : ""}${job.employment_type ? "\nEmployment: " + job.employment_type : ""}\nDescription:\n${String(job.description || "").slice(0, 3000)}` +
      `\nHiring company (people who work there now are 'Not a fit'): ${job.client || "(not given)"}\nSearch area (where candidates must be based now): ${job.location || job.country || "(not set)"}` +
      `\n\nJob checklist:\n${checklist.map((c) => "- " + c).join("\n") || "(none)"}\n\nPeople (i | result title | snippet):\n`;
    for (let i = 0; i < people.length; i += 10) {
      const b = people.slice(i, i + 10);
      const out = await askAI(SYS, head + b.map((p: any, k: number) => `${k} | ${clip(p.data?.result_title || p.full_name + " - " + (p.title || ""), 200)} | ${clip(p.data?.snippet || "", 500)}`).join("\n"), 6000);
      const byI = new Map((Array.isArray(out?.people) ? out.people : []).map((r: any) => [Number(r.i), r]));
      for (let k = 0; k < b.length; k++) {
        const p: any = b[k], r: any = byI.get(k);
        if (!r) continue; // tried again next run
        const snip = String(p.data?.snippet || "");
        const fromSnippet = (snip.match(/(?:Location|Lives in|Based in)\s*[:：]\s*([^·|\n]{2,80})/i) || [])[1];
        const loc = clip(fromSnippet || r.location, 120);
        const c = loc ? countryIn(loc) : "";
        const remoteSigns = r.remote === true || REMOTE.test(String(r.headline || "") + " " + snip + " " + String(p.data?.result_title || ""));
        const remote = remoteSigns && !(jobRemote && (!allowed.size || (c && allowed.has(c))));
        let fit = Math.max(0, Math.min(100, Math.round(Number(r.fit) || 0)));
        let verdict = ["Good fit", "Possible fit", "Not a fit"].includes(r.verdict) ? r.verdict : "Possible fit";
        if (remote) { fit = Math.max(0, fit - 10); if (verdict === "Good fit") verdict = "Possible fit"; }
        const cl = Array.isArray(r.checklist) ? r.checklist : [];
        const reasons: string[] = [];
        if (allowed.size && c && !allowed.has(c)) reasons.push("Based in " + c.replace(/\b\w/g, (x) => x.toUpperCase()) + ", outside the role's country");
        if (r.business === true || OWNER.test(String(r.headline || p.title || ""))) reasons.push("A business or business owner");
        if (r.client_history === "current" || sameCompany(r.company || p.company, job.client)) reasons.push("Works at " + (job.client || "the client") + " now");
        if (cl.slice(0, 3).some((x: any) => x?.status === "not met")) reasons.push("Misses a core must-have: " + cl.slice(0, 3).filter((x: any) => x?.status === "not met").map((x: any) => clip(x.item, 50)).join(", "));
        else if (cl.length && !cl.some((x: any) => x?.status === "met")) reasons.push("None of the must-haves shown");
        if (verdict === "Not a fit" && !reasons.length) reasons.push(clip(r.why, 100) || "Not a fit for the role");
        if (fit < 40 && !reasons.length) reasons.push("Low fit (" + fit + "%)");
        const keep = reasons.length === 0;
        await mark(admin, p, { keep, reasons, fit, verdict, why: clip(r.why, 140), location: loc, remote, client_history: r.client_history === "past" ? "past" : "none", locationSource: remote ? "remote" : fromSnippet ? "profile" : loc ? "result" : "" });
        reviewed++; if (!keep) removed++;
      }
    }
  }
  return { reviewed, toRemove: removed, done: false };
}

async function mark(admin: any, p: any, r: any) {
  const data = { ...(p.data || {}), recheck: { keep: r.keep, reasons: r.reasons || [], fit: r.fit ?? null, verdict: r.verdict || null, why: r.why || "", at: new Date().toISOString() } };
  const upd: Record<string, unknown> = { data };
  if (r.keep) {
    // Kept: refreshed with the stricter reading (location, tags, fit).
    data.client_history = r.client_history; data.location_source = r.locationSource; data.remote_worker = !!r.remote;
    upd.fit = r.fit; upd.verdict = r.verdict === "Not a fit" ? "Possible fit" : r.verdict; if (r.location) upd.location = r.location;
  }
  await admin.from("prospects").update(upd).eq("id", p.id).eq("status", "found");
}

Deno.serve(async (req: Request) => {
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
    if (body.action === "review") return json({ ok: true, ...(await review(admin, Math.min(60, Math.max(1, Number(body.limit) || 40)))) });
    if (body.action === "summary" || body.action === "apply") {
      const { data } = await admin.from("prospects").select("id,full_name,title,data").eq("status", "found").eq("data->>xray", "true");
      const all = data || [];
      const checked = all.filter((p: any) => p.data?.recheck);
      const go = checked.filter((p: any) => p.data.recheck.keep === false);
      if (body.action === "summary") {
        const why: Record<string, number> = {};
        for (const p of go) for (const r of p.data.recheck.reasons || []) { const k = String(r).split(":")[0].replace(/^Based in .*/, "Based outside the role's country").replace(/^Works at .*/, "Works at the client now").replace(/^Low fit.*/, "Low fit"); why[k] = (why[k] || 0) + 1; }
        return json({ ok: true, total: all.length, checked: checked.length, keep: checked.length - go.length, remove: go.length, why, sample: go.slice(0, 40).map((p: any) => ({ name: p.full_name, title: p.title, reasons: p.data.recheck.reasons })) });
      }
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
});
