// The client machine, Active file first.
//   fetchLeads (daily, after an Admin approves the credits): candidate by candidate. For each Active
//     file candidate, new postings in the country they live in for their own job titles (direct
//     employers, not remote, never a company they work or worked at) -> leads found FOR that
//     candidate. Location is strict: the search is narrowed to the candidate's city and state (and
//     the cities they'd move to, if they said they'd relocate), then each posting's place is checked
//     against where they live: only roles within about an hour's commute (or in a city they'd move
//     to) are kept. A candidate without a known city isn't searched. The day's postings are shared out between candidates; when there are more
//     candidates than the day allows, it works through them in turn over the following days.
//     Intentional: only small and medium companies (Outreach settings, default 10-500 staff), which
//     are likelier to take an agency's CVs and pay, and never an employer whose posting says no
//     agencies / no unsolicited CVs (left out by the feed itself, then checked again here).
//   processLead (a few per run): the candidate it was found for, screened strictly by the job
//     description (its requirements and qualifications, read against their CV). Other Active file
//     candidates in that country with the same title are screened too and join (up to 5 in all).
//   pitchLead: the contacts (Talent Acquisition, hiring manager, CEO, found on Apollo at the company) and an anonymous
//     email: up to 5 candidates, each as a blind resume behind a "View the candidates" button
//     (/?t=s-<client_token>), only candidates whose blind resume a Rec Ops/Admin has checked. A lead
//     whose matches have no checked blind resume yet waits ('awaiting') and is pitched once they do.
//   Candidates aren't asked about each role: they agreed to be put forward when they said Yes to
//   future roles or joined the Active file. They're never named or tied to an employer in a pitch.
//   The company's "We're interested" sends the contract automatically (stepContracts in index.ts).

import { askAI } from "./ai.ts";
import { assessForPitch, OUT, PENDING, strongEnough } from "./pitch.ts";
import { searchJobs, theirstackKey } from "./theirstack.ts";
import { contactFields, findCompanyContacts, liveContacts, type Contact } from "./contacts.ts";
import { COUNTRY_NAMES, countryCode, locationCountry, placeParts, regionOf } from "./regions.ts";
import { button, emailShell, esc, loadBrand, sendBrevo } from "./brand.ts";
import { portalBase } from "./queue.ts";
import { anonSummary, candEmployers, candTitles, fitsToPercent, isBusy, noAgencyText, scrub, titlesMatch, workedAt, type Settings } from "./common.ts";

export const MAX_PER_PITCH = 5;

// Who we pitch: the Active file (not drafts, with a CV), and the country each one lives in.
export async function pitchableCandidates(admin: any) {
  const { data } = await admin.from("candidates")
    .select("id,name,status,email,pay,work_setup,current_title,current_company,parallel_titles,experience,location,notice,skills,strengths,industries,preferences,is_draft,resume_path,resume_name,cv_path,blind_pages,blind_checked_at,open_to_roles,open_paused_until,candidate_jobs(stage,candidate_response)")
    .eq("is_draft", false).eq("status", "Active file");
  return (data || []).filter((c: any) => isOpen(c) && !isBusy(c) && (c.resume_path || c.cv_path) && candTitles(c).length && candCountry(c));
}
// "Open to new roles" on their candidate page: off means not for a year, unless they turn it back on.
export const isOpen = (c: any) => c?.open_to_roles !== false || (!!c?.open_paused_until && Date.parse(c.open_paused_until) < Date.now());
// The country a candidate lives in, as a code: from their job preferences, else the end of their location.
export function candCountry(c: any): string {
  const p = c?.preferences;
  if (p && p.currentCountry) { const k = countryCode(p.currentCountry); if (k) return k; }
  return locationCountry(c?.location);
}
export const blindReady = (c: any) => !!(c?.blind_pages && c?.blind_checked_at);

// Where a candidate lives and where they'd work: their city and region (from their job preferences,
// else their location), and the cities they'd move to when they said Yes or Maybe to relocating.
export function candArea(c: any) {
  const p = c?.preferences || {};
  const fromPref = p.currentCity ? placeParts(p.currentCity) : { city: "", region: "" };
  const fromLoc = placeParts(c?.location);
  const city = fromPref.city || fromLoc.city;
  const region = fromPref.region || (fromLoc.city.toLowerCase() === city.toLowerCase() ? fromLoc.region : "");
  const cc = candCountry(c);
  const moves = ["yes", "maybe"].includes(String(p.relocate || "")) ? (Array.isArray(p.preferredCities) ? p.preferredCities : []).map((x: unknown) => String(x || "").trim()).filter(Boolean).slice(0, 5) : [];
  const home = [city, region, COUNTRY_NAMES[cc] || ""].filter(Boolean).join(", ");
  // Search terms: the city, its state/region (wide enough to catch nearby towns; the commute check
  // narrows it), and the cities they'd move to.
  const places = [...new Set([city, region, ...moves.map((m: string) => placeParts(m).city || m)].filter((x) => x && x.length > 1))];
  return { city, region, cc, home, moves, places };
}

// The towns within commuting distance of where a candidate lives (their city first), to narrow the
// job search to them instead of the whole state. Falls back to the city and its state/region.
async function commuteTowns(area: ReturnType<typeof candArea>): Promise<string[]> {
  const sys = "You list the cities and towns within about 60 minutes' normal commute of a place. Reply with STRICT JSON only: {\"towns\": string[]}. " +
    "Up to 12 names, the place itself first, then the biggest employment centres nearby; town or city names only (no state or country, no neighbourhoods). Use real geography.";
  try {
    const r = await askAI(sys, "Place: " + area.home, 600);
    const towns = (Array.isArray(r?.towns) ? r.towns : []).map((x: unknown) => String(x || "").trim()).filter((x: string) => x.length > 1 && x.length < 60);
    if (towns.length) return [...new Set([area.city, ...towns])].slice(0, 13);
  } catch (e) { console.error("lead commute towns", String((e as Error)?.message || e).slice(0, 200)); }
  return [area.city, area.region].filter(Boolean);
}

// Strict commute check: is each place within about an hour of where the candidate lives (or in or
// next to a city they'd move to)? Only a clear yes counts. One AI question per candidate per run.
async function nearCandidate(area: ReturnType<typeof candArea>, places: string[]): Promise<Map<string, { ok: boolean; note: string }>> {
  const out = new Map<string, { ok: boolean; note: string }>();
  const ask = [...new Set(places.map((x) => String(x || "").trim()).filter(Boolean))];
  if (!ask.length) return out;
  const sys = "You check whether job locations are close enough for a candidate to take the job without moving, or are in a city they'd move to. Be strict and use real geography. " +
    "Reply with STRICT JSON only: {\"results\": [{\"i\": number, \"near\": \"yes\" | \"no\" | \"unsure\", \"note\": string}]}, one per place. " +
    "yes: the job is within about 60 minutes' normal commute (car or public transport) of where the candidate lives, or in (or within about 30 minutes of) one of the cities they'd move to. " +
    "no: farther than that (another city or metro area). unsure: the place is too vague to tell (only a state, region or country). " +
    "note: for 'no', where it is and roughly how far from the candidate, e.g. 'Houston, about 4 h from Austin'; otherwise ''.";
  const head = `Candidate lives in: ${area.home}\nCities they'd move to: ${area.moves.length ? area.moves.join("; ") : "none (won't relocate)"}\n\nJob locations (i | place):\n`;
  let res: any = null;
  for (let t = 0; t < 2 && !Array.isArray(res?.results); t++) {
    if (t) await new Promise((r) => setTimeout(r, 3000));
    try { res = await askAI(sys, head + ask.map((p, n) => `${n} | ${p}`).join("\n"), 2000); } catch (e) { console.error("lead commute check", String((e as Error)?.message || e).slice(0, 200)); }
  }
  for (const r of Array.isArray(res?.results) ? res.results : []) {
    const p = ask[Number(r?.i)];
    if (p) out.set(p, { ok: r.near === "yes", note: String(r.note || (r.near === "unsure" ? "Location too vague to check" : "")).slice(0, 120) });
  }
  for (const p of ask) if (!out.has(p)) out.set(p, { ok: false, note: res ? "Location too vague to check" : "Location check failed" });
  return out;
}

export async function fetchLeads(admin: any, s: Settings) {
  if (!theirstackKey()) return { ok: false, notConnected: "theirstack", message: "The job feed isn't connected yet. Add the THEIRSTACK_API_KEY secret." };
  const all = await pitchableCandidates(admin);
  if (!all.length) return { ok: true, fetched: 0, message: "No Active file candidates with a CV, a known job title and a known country, so there's nothing to look for yet." };
  // Share the day's postings out between candidates (at least 3 each). More candidates than that
  // allows: a different group each day, in turn (same order every day, starting further along).
  const total = Math.max(1, s.leads.postingsPerDay);
  const each = Math.max(3, Math.floor(total / all.length));
  const perDay = Math.max(1, Math.floor(total / each));
  const ordered = all.slice().sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
  const start = (Math.floor(Date.now() / 864e5) * perDay) % ordered.length;
  const today = perDay >= ordered.length ? ordered : Array.from({ length: perDay }, (_, k) => ordered[(start + k) % ordered.length]);
  let fetched = 0, added = 0, remote = 0, skipped = 0;
  const errors: string[] = [], found: string[] = [];
  let noCity = 0, far = 0, noAgency = 0, size = 0, remoteOnly = 0;
  const { minEmployees, maxEmployees } = s.leads;
  const sizeOk = (n: number | null) => n == null || ((!minEmployees || n >= minEmployees) && (!maxEmployees || n <= maxEmployees));
  for (const c of today) {
    const area = candArea(c);
    const cc = area.cc;
    // Strict location: without a city we can't tell what's near them, so they aren't searched.
    if (!area.city) { noCity++; found.push(firstName(c) + " (no city)"); continue; }
    // Remote only (their confirmed work setup): the feed brings on-site and hybrid roles, never
    // remote ones, so there's nothing to look for and no credits are spent on them.
    const ws = Array.isArray(c.work_setup) && c.work_setup.length ? c.work_setup : Array.isArray(c.preferences?.workSetup) ? c.preferences.workSetup : [];
    if (ws.length && ws.every((x: string) => x === "remote")) { remoteOnly++; found.push(firstName(c) + " (remote only)"); continue; }
    const titles = [...new Set(candTitles(c).map((t) => t.trim()).filter(Boolean))].slice(0, 10);
    let postings: any[] = [];
    const places = [...new Set([...(await commuteTowns(area)), ...area.moves.map((m: string) => placeParts(m).city || m)])].slice(0, 20);
    try { postings = await searchJobs({ titles, countries: [cc], places, maxAgeDays: s.leads.maxAgeDays, limit: each, minEmployees, maxEmployees }); }
    catch (e) {
      const m = String((e as Error)?.message || e);
      errors.push(firstName(c) + " (" + cc + "): " + m.slice(0, 300));
      if (/\b401\b/.test(m) || /\b402\b/.test(m) || (/\b403\b/.test(m) && !/free plan/i.test(m))) break;   // key or credits: stop for today
      continue;
    }
    fetched += postings.length;
    const employers = candEmployers(c);
    let mine = 0;
    const near = await nearCandidate(area, postings.filter((p: any) => !p.remote).map((p: any) => p.location));
    for (const p of postings) {
      // Roles in the candidate's own country only: remote roles are left out, and never a company
      // they work or worked at.
      if (p.remote) { remote++; continue; }
      const pc = countryCode(p.country) || cc;
      if (pc !== cc) continue;
      if (workedAt(employers, p.company)) { skipped++; continue; }
      // Says no agencies / no unsolicited CVs, or outside the company sizes we pitch.
      if (noAgencyText(p.description)) { noAgency++; continue; }
      if (!sizeOk(p.employees)) { size++; continue; }
      const nr = near.get(String(p.location || "").trim());
      if (!nr || !nr.ok) { far++; continue; }
      const { error } = await admin.from("leads").insert({
        source: "theirstack", external_id: p.id, company: p.company, company_domain: p.domain, job_title: p.title,
        location: p.location, country: pc, region: regionOf(pc), url: p.url, posted_at: p.posted_at,
        description: p.description, salary: p.salary, status: "pending",
        data: { hiring_team: p.hiring_team, remote: p.remote, industry: p.industry || null, employees: p.employees, for_candidate: c.id, for_titles: titles, for_area: area.home },
      });
      if (!error) { added++; mine++; }  // a posting already found (for anyone) hits the unique external_id and is skipped
    }
    found.push(firstName(c) + " " + mine);
  }
  if (!fetched && errors.length) throw new Error(errors[0]);
  const who = today.length === all.length ? `all ${all.length} Active file candidates` : `${today.length} of ${all.length} Active file candidates (the rest on the next days)`;
  return { ok: true, fetched, added, candidates: found,
    message: `Looked for roles for ${who}, up to ${each} each: ${fetched} new postings, ${added} new leads.${remote ? " " + remote + " remote roles left out." : ""}${skipped ? " " + skipped + " at a company the candidate worked for, left out." : ""}${far ? " " + far + " too far from the candidate, left out." : ""}${noAgency ? " " + noAgency + " said no agencies or no unsolicited CVs, left out." : ""}${size ? " " + size + " outside the company sizes we pitch, left out." : ""}${noCity ? " " + noCity + " candidate" + (noCity === 1 ? "" : "s") + " skipped: no city on their profile." : ""}${remoteOnly ? " " + remoteOnly + " skipped: remote work only." : ""}${errors.length ? " Some searches failed: " + errors.join("; ") : ""}` };
}
const firstName = (c: any) => String(c?.name || "").trim().split(/\s+/)[0] || "A candidate";

export async function processLead(admin: any, lead: any, s: Settings) {
  // The candidate it was found for, plus other Active file candidates in the posting's country with
  // a matching title; never anyone who works or worked at that company.
  const cc = countryCode(lead.country);
  const forId = lead.data?.for_candidate || null;
  const cands = (await pitchableCandidates(admin)).filter((c: any) => candCountry(c) === cc && !workedAt(candEmployers(c), lead.company));
  const target = forId ? cands.find((c: any) => c.id === forId) : null;
  const ignore = async (why: string) => { await admin.from("leads").update({ status: "ignored", notes: why }).eq("id", lead.id); return { ok: true, kept: false, why }; };
  // The employer says no agencies / no unsolicited CVs (leads found before this check, or wording
  // the feed's patterns missed).
  const said = noAgencyText(lead.description);
  if (said) return ignore(`The job description says the employer doesn't take agency candidates ("${said}")`);
  if (forId && !target) return ignore("The candidate this role was found for is no longer free to put forward");
  const others = cands.filter((c: any) => c.id !== forId).map((c: any) => ({ c, score: titlesMatch([lead.job_title], candTitles(c)) }))
    .filter((x: any) => x.score >= 0.6).sort((a: any, b: any) => b.score - a.score).slice(0, target ? 7 : 8).map((x: any) => x.c);
  // Others join only if the role is within commuting distance of where they live (strict, as for
  // the candidate it was found for).
  const near: any[] = [];
  for (const c of others) {
    const a = candArea(c);
    if (!a.city) continue;
    const m = await nearCandidate(a, [lead.location]);
    if (m.get(String(lead.location || "").trim())?.ok) near.push(c);
    if (near.length >= 4) break;
  }
  const pool = target ? [target, ...near] : near;
  if (!pool.length) return ignore("No Active file candidate near " + (lead.location || lead.country || "there") + " matches this title");

  // Screening strictly by the job description (pitch.ts): what it asks for (required / nice to
  // have, nothing assumed), checked against each candidate's CV. Anything required they don't have
  // takes them out; a required item their CV doesn't show becomes a yes/no question to them, and
  // they're pitched only once they've said yes. Plus how the role meets what each of them wants.
  const { role, items, contacts: named, results } = await assessForPitch(admin, lead, pool);
  // Anyone the job description gives a work email for is kept, to be emailed with the others.
  const data: any = { ...(lead.data || {}), role, jd: items, jd_contacts: named };
  // The AI's read of the job description found the employer won't take agency candidates.
  if (role.noAgencies) {
    const why = "The job description says the employer doesn't take agency candidates" + (role.noAgencies.length > 3 ? ` ("${role.noAgencies}")` : "");
    await admin.from("leads").update({ status: "ignored", notes: why, data }).eq("id", lead.id);
    return { ok: true, kept: false, why };
  }
  if (!items.some((x) => x.required)) {
    await admin.from("leads").update({ status: "ignored", notes: "The job description doesn't list any requirements or qualifications to screen against", data }).eq("id", lead.id);
    return { ok: true, kept: false, why: "No requirements in the job description" };
  }
  // Direct hire only for now: contract and temporary roles are left out.
  if (/contract|temporary|temp\b/i.test(role.employmentType) || /\b(contract|temporary|temp)\b(?!.{0,15}hire)/i.test(lead.job_title || "")) {
    await admin.from("leads").update({ status: "ignored", notes: "Contract or temporary role: direct hire only for now", data }).eq("id", lead.id);
    return { ok: true, kept: false, why: "Contract or temporary role" };
  }
  const ignoreWith = async (why: string) => { await admin.from("leads").update({ status: "ignored", notes: why, data }).eq("id", lead.id); return { ok: true, kept: false, why }; };
  const kept = results.map((a) => ({ a, c: pool[a.n] })).filter((x) => x.c && strongEnough(x.a))
    .sort((x, y) => (target && x.c.id === target.id ? -1 : target && y.c.id === target.id ? 1 : y.a.fit - x.a.fit)).slice(0, MAX_PER_PITCH);
  const whyOut = (c: any) => results.find((a) => pool[a.n]?.id === c.id)?.out || "doesn't meet the job description";
  // Never pitched to a company they've worked for: the CV's whole work history is read for it in the
  // screening (any of the company's names), on top of the employers already on their profile.
  const exStaff = results.filter((a) => a.exEmployer && pool[a.n]).map((a) => pool[a.n]);
  if (exStaff.length) data.ex_employees = exStaff.map((c: any) => c.id);
  // Found for a candidate: kept only when it fits them.
  if (target && !kept.some((x) => x.c.id === target.id)) return ignoreWith("Not a fit for " + firstName(target) + " by the job description: " + whyOut(target));
  if (!kept.length) return ignoreWith("None of our Active file candidates meet the job description");
  const matches = kept.map(({ a, c }) => ({
    candidate_id: c.id, verdict: a.verdict, fit: a.fit, reason: a.reason.slice(0, 300),
    bullets: a.bullets, requirements: a.requirements, why_role: a.whyRole, musts: a.musts, jd: a.jd,
    // Yes/no questions for the required items their CV doesn't show first, then any others.
    questions: [...a.confirm.map((q) => ({ q: q.q, confirm: q.item })), ...a.questions.map((q) => ({ q }))].slice(0, 5),
  }));
  const toConfirm = matches.filter((m) => m.questions.some((q: any) => q.confirm)).length;
  await admin.from("leads").update({ status: "awaiting", matches, data,
    notes: "Candidate emails to review: open each candidate's email, then send." + (toConfirm ? ` ${toConfirm === 1 ? "One candidate is" : toConfirm + " candidates are"} asked to confirm requirements their CV doesn't show.` : "") + " The pitch goes once they've acknowledged." }).eq("id", lead.id);
  // Each candidate's own place on this pitch, with their information email written as a draft:
  // nothing goes out until Rec Ops / an Admin reviews it and presses Send (candidate first).
  for (const m of matches) {
    const { error } = await admin.from("lead_offers").upsert({
      lead_id: lead.id, candidate_id: m.candidate_id, fit: m.fit, verdict: m.verdict, reason: m.reason, bullets: m.bullets,
      requirements: m.requirements, questions: m.questions, why_role: m.why_role || null, client_musts: m.musts || [], jd_check: m.jd, status: "draft",
    }, { onConflict: "lead_id,candidate_id" });
    if (error) console.error("lead offer", error.message);
  }
  return { ok: true, kept: true, candidates: matches.length, drafts: matches.length };
}

// Where a pitch's candidates are: whoever is ready (acknowledged, answered or put through) and
// whose blind resume is checked goes in. It waits while anyone is still to respond, unless Rec Ops
// / an Admin sends it now with the ready ones (force). Everyone off it: the lead is let go.
export async function pitchState(admin: any, lead: any) {
  const { data: offers } = await admin.from("lead_offers").select("id,candidate_id,status,fit,verdict,reason,bullets,client_musts,jd_check,requirements").eq("lead_id", lead.id);
  const fresh = (offers || []).filter((o: any) => [...PENDING, "ready", "pitched", ...OUT].includes(o.status));
  return { offers: fresh, pending: fresh.filter((o: any) => PENDING.includes(o.status)), ready: fresh.filter((o: any) => o.status === "ready"),
    pitched: fresh.filter((o: any) => o.status === "pitched"), out: fresh.filter((o: any) => OUT.includes(o.status)) };
}

// The hiring contact and the pitch, with every match whose blind resume is ready (checked). If none
// is ready yet, the lead waits ('awaiting', with a note) and stepLeads tries again later.
export async function pitchLead(admin: any, lead: any, s: Settings, force = false) {
  let all: any[] = Array.isArray(lead.matches) ? lead.matches : [];
  if (!all.length) return { ok: true, pitched: false };
  const st = await pitchState(admin, lead);
  const candidateFirst = st.offers.length > 0;
  if (candidateFirst) {
    // Everyone withdrew or was taken off: nothing to pitch.
    if (!st.pending.length && !st.ready.length && !st.pitched.length) {
      await admin.from("leads").update({ status: "ignored", notes: "Every candidate withdrew or was taken off" }).eq("id", lead.id);
      return { ok: true, pitched: false, allOut: true };
    }
    if (st.pending.length && !force) {
      await admin.from("leads").update({ status: "awaiting", notes: (() => { const d = st.pending.filter((o: any) => o.status === "draft").length, w = st.pending.length - d, live = st.offers.length - st.out.length;
        return [d ? `${d} candidate email${d === 1 ? "" : "s"} to review and send` : "", w ? `waiting for ${w} of ${live} candidate${live === 1 ? "" : "s"} to acknowledge (remind after 2 days)` : ""].filter(Boolean).join("; ").replace(/^./, (x) => x.toUpperCase()) + ". Put them through or send now with the ready ones."; })() }).eq("id", lead.id);
      return { ok: true, pitched: false, waitingForCandidates: st.pending.length };
    }
    const readyIds = new Set([...st.ready, ...st.pitched].map((o: any) => o.candidate_id));
    // What each meets as of now: requirements they've since confirmed count (lead_offers).
    all = all.map((m: any) => { const o = st.offers.find((x: any) => x.candidate_id === m.candidate_id); return o ? { ...m, fit: o.fit ?? m.fit, verdict: o.verdict || m.verdict, musts: Array.isArray(o.client_musts) && o.client_musts.length ? o.client_musts : m.musts,
      jd: Array.isArray(o.jd_check) && o.jd_check.length ? o.jd_check : m.jd, requirements: Array.isArray(o.requirements) ? o.requirements : m.requirements } : m; });
    all = all.filter((m: any) => readyIds.has(m.candidate_id));
    if (!all.length) return { ok: true, pitched: false, waitingForCandidates: st.pending.length };
  }
  const { data: cs0 } = await admin.from("candidates").select("id,name,current_company,industries,blind_pages,blind_checked_at,status").in("id", all.map((m: any) => m.candidate_id));
  // Last check before anyone is pitched: never to a company they've worked for (the employers on
  // their profile now, and anyone the CV screening found had worked there). They're taken off the pitch.
  const exIds = new Set<string>(Array.isArray(lead.data?.ex_employees) ? lead.data.ex_employees : []);
  const exStaff = (cs0 || []).filter((c: any) => exIds.has(c.id) || workedAt(candEmployers(c), lead.company));
  if (exStaff.length) {
    await admin.from("lead_offers").update({ status: "removed", removed_at: new Date().toISOString(), note: "Taken off: has worked at this company" })
      .eq("lead_id", lead.id).in("candidate_id", exStaff.map((c: any) => c.id)).not("status", "in", "(withdrawn,removed)");
    all = all.filter((m: any) => !exStaff.some((c: any) => c.id === m.candidate_id));
    if (!all.length) {
      await admin.from("leads").update({ status: "ignored", notes: "Every candidate on it has worked at this company" }).eq("id", lead.id);
      return { ok: true, pitched: false, allOut: true };
    }
  }
  const cs = (cs0 || []).filter((c: any) => !exStaff.includes(c));
  // Candidate first: they're on the lead's role now (In review), so their status isn't Active file.
  const ready = all.filter((m: any) => { const c = (cs || []).find((x: any) => x.id === m.candidate_id); return c && blindReady(c) && (candidateFirst || c.status === "Active file"); }).slice(0, MAX_PER_PITCH);
  if (!ready.length) {
    const waiting = all.map((m: any) => (cs || []).find((x: any) => x.id === m.candidate_id)?.name).filter(Boolean);
    await admin.from("leads").update({ status: "awaiting", notes: "Waiting for a checked blind resume for: " + waiting.join(", ") + " (Candidates > Blind resumes)." }).eq("id", lead.id);
    return { ok: true, pitched: false, waitingForBlind: waiting.length };
  }
  const kc = ready.map((m: any) => (cs || []).find((x: any) => x.id === m.candidate_id) || { id: m.candidate_id });
  const posting = `Job: ${lead.job_title} at ${lead.company}\nLocation: ${lead.location || "?"} (${lead.country || "?"})${lead.salary ? "\nPay: " + lead.salary : ""}\nDescription:\n${String(lead.description || "").slice(0, 3000)}`;

  // Who to contact (contacts.ts): anyone named in the job description, the job's poster, Talent
  // Acquisition, the hiring manager and the CEO, from ContactOut (Apollo as backup), work emails
  // only, looked up once per lead. Each gets their own email. None found: the lead waits for a
  // contact added by hand.
  let contacts: Contact[] = liveContacts(lead);
  let lookup: Record<string, unknown> | null = null;
  if (!lead.data?.contacts_checked_at) {
    const found = await findCompanyContacts(admin, lead, lead.data?.role?.hmTitles || [], s.emailLookup);
    contacts = found.contacts;
    lookup = { contacts, contacts_checked_at: new Date().toISOString(), contacts_tried: found.tried, ...(found.error ? { contacts_error: found.error } : {}) };
  }
  const main = contacts[0] || null;
  const fields = contactFields(contacts);
  const channel = fields.channel;

  // Pitch: a short intro (the email lists each candidate with the must-haves they meet and a
  // button to their blind resume, added by the email itself) and a LinkedIn note. Never names.
  const n = ready.length;
  const pitchSys = "You write short, specific business-development emails for a recruitment agency to a hiring manager who just posted a job. Reply with STRICT JSON only: " +
    "{\"subject\": string, \"body\": string, \"linkedin\": string}. Rules: never name the candidates or their employers. " +
    `subject under 70 characters, in this spirit: 'Review ${n === 1 ? "the perfect candidate" : "the " + n + " perfect candidates"} for your <role> role, free'. ` +
    `body 40-70 words, plain text, start 'Hi <first name>,' (or 'Hi there,' if unknown): mention their open role by title, say we have ${n === 1 ? "a candidate who meets" : n + " candidates who meet"} what they're looking for, ` +
    `that the must-haves ${n === 1 ? "they meet are" : "each meets are"} listed below with ${n === 1 ? "an anonymised resume" : "anonymised resumes"} they can review free, and that we don't charge to arrange interviews (we only bill when they hire our candidate). ` +
    "No candidate list (it's added below), no sign-off, no links, no footer (added separately). " +
    "linkedin: under 280 characters, friendly, same offer, no links.";
  const pts = ready.map((m: any, i: number) => `Candidate ${i + 1} (${m.verdict}): ${(m.musts || []).map((x: any) => x.item).join("; ") || (m.bullets || []).join("; ")}`).join("\n");
  const pitch = await askAI(pitchSys, `${posting.slice(0, 1500)}\n\nHiring contact first name: ${main?.first_name || "unknown"}${main?.title ? " (" + main.title + ")" : ""}\n\nOur candidates:\n${pts}`, 2000);
  await admin.from("leads").update({
    status: "new", matches: all, notes: null,
    data: { ...(lead.data || {}), ...(lookup || {}), pitched: ready.map((m: any) => m.candidate_id) },
    ...fields,
    pitch_subject: scrub(String(pitch?.subject || ""), kc).slice(0, 120), pitch_body: scrub(String(pitch?.body || ""), kc).slice(0, 3000),
    linkedin_message: scrub(String(pitch?.linkedin || ""), kc).slice(0, 300),
  }).eq("id", lead.id);
  // Candidate first: those in the pitch are marked as such (moved to Submitted once it's sent).
  await admin.from("lead_offers").update({ status: "pitched", pitched_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("status", "ready").in("candidate_id", ready.map((m: any) => m.candidate_id));
  return { ok: true, pitched: true, kept: true, channel, candidates: n };
}

// The page the pitch's button opens: the candidates' blind resumes (no names), and "We're interested".
export const shortlistUrl = (clientToken: string) => `${portalBase()}/?t=s-${encodeURIComponent(clientToken)}`;

// Ask candidates about a matched role: an email with the role WITHOUT the employer's name or
// website, and Yes / No buttons that open their candidate page. Recruiter-approved, a few at a time.
export async function sendOffers(admin: any, ids: string[], sentBy: string | null) {
  const b = await loadBrand(admin);
  const out = { sent: 0, skipped: 0, errors: [] as string[] };
  const { data: offers } = await admin.from("lead_offers").select("id,token,status,lead_id,candidate_id").in("id", ids.slice(0, 25)).eq("status", "suggested");
  for (const o of offers || []) {
    try {
      const { data: c } = await admin.from("candidates").select("id,name,email,email_opt_out,portal_token,recruiter_id").eq("id", o.candidate_id).single();
      if (!c?.email || c.email_opt_out || !c.portal_token) { out.skipped++; await admin.from("lead_offers").update({ status: "skipped" }).eq("id", o.id); continue; }
      const { data: role } = await admin.rpc("offer_role_anon", { p_lead: o.lead_id });
      const { data: rec } = c.recruiter_id ? await admin.from("profiles").select("full_name").eq("id", c.recruiter_id).maybeSingle() : { data: null };
      const first = String(c.name || "").split(" ")[0] || "there";
      const recruiter = String(rec?.full_name || "").split(" ")[0] || "Your recruiter";
      const link = (r: string) => `${portalBase()}/?c=${encodeURIComponent(c.portal_token)}&offer=${encodeURIComponent(o.token)}&r=${r}`;
      const where = [role?.remote ? "Remote" : "", role?.location || "", role?.country || ""].filter(Boolean).join(" · ");
      const summary = String(role?.summary || "").replace(/\s+/g, " ").trim();
      const short = summary.length > 420 ? summary.slice(0, 420).replace(/\s+\S*$/, "") + "…" : summary;
      const subject = `A role that could suit you: ${role?.title || "new opportunity"}`;
      const html = emailShell(b, subject, `
        <div style="font-size:20px;margin-bottom:8px;">Hi ${esc(first)},</div>
        <div style="font-size:15px;line-height:1.6;">${esc(recruiter)} came across a role that matches your background and wanted to ask you first.</div>
        <div style="margin:18px 0;padding:16px 18px;border:1px solid #E4DED2;border-radius:12px;background:#FAF8F3;">
          <div style="font-size:17px;font-weight:700;">${esc(role?.title || "")}</div>
          ${where ? `<div style="font-size:14px;color:#56605A;margin-top:4px;">${esc(where)}</div>` : ""}
          ${role?.salary ? `<div style="font-size:14px;color:#56605A;margin-top:2px;">${esc(role.salary)}</div>` : ""}
          ${short ? `<div style="font-size:14px;line-height:1.55;margin-top:10px;">${esc(short)}</div>` : ""}
        </div>
        <div style="font-size:15px;line-height:1.6;">Nothing about you is shared with the employer unless you say yes. If you're interested, you'll get to check the details we have on file for you first.</div>
        ${button(b, link("yes"), "Yes, I'm interested")}
        <div style="margin-top:10px;font-size:14px;"><a href="${esc(link("no"))}" style="color:#56605A;">Not for me</a></div>`);
      const ok = await sendBrevo(b, { email: c.email, name: c.name }, subject, html);
      if (!ok) throw new Error("The email couldn't be sent (check the email settings)");
      await admin.from("lead_offers").update({ status: "sent", sent_at: new Date().toISOString(), sent_by: sentBy }).eq("id", o.id);
      await admin.from("candidate_timeline").insert({ candidate_id: c.id, title: "Asked about a matched role: " + (role?.title || ""), done: true });
      out.sent++;
    } catch (e) { out.errors.push(String((e as Error)?.message || e).slice(0, 160)); }
  }
  return out;
}

// The employer said yes too (after the candidate did): tell the candidate, still without naming
// the employer. Who it is shows on their candidate page, where the role now appears; their
// recruiter is copied.
export async function sendOfferMoving(admin: any, offerId: string) {
  const { data: o } = await admin.from("lead_offers").select("id,status,lead_id,candidate_id").eq("id", offerId).maybeSingle();
  if (!o || o.status !== "processing") return { sent: false, error: "This candidate isn't being processed for the role" };
  const { data: c } = await admin.from("candidates").select("id,name,email,email_opt_out,portal_token,recruiter_id").eq("id", o.candidate_id).single();
  if (!c?.email || c.email_opt_out || !c.portal_token) return { sent: false, error: "No email for them, or they unsubscribed" };
  const b = await loadBrand(admin);
  const { data: role } = await admin.rpc("offer_role_anon", { p_lead: o.lead_id });
  const { data: rec } = c.recruiter_id ? await admin.from("profiles").select("full_name,email").eq("id", c.recruiter_id).maybeSingle() : { data: null };
  const first = String(c.name || "").split(" ")[0] || "there";
  const recruiter = String(rec?.full_name || "").split(" ")[0] || "Your recruiter";
  const subject = `Good news about the ${role?.title || "role"} you said yes to`;
  const html = emailShell(b, subject, `
    <div style="font-size:20px;margin-bottom:8px;">Hi ${esc(first)},</div>
    <div style="font-size:15px;line-height:1.6;">Good news: the employer for the <b>${esc(role?.title || "role")}</b> you said yes to wants to move forward with you.</div>
    <div style="font-size:15px;line-height:1.6;margin-top:12px;">${esc(recruiter)} will be in touch about the next steps. The full details are on your candidate page.</div>
    ${button(b, `${portalBase()}/?c=${encodeURIComponent(c.portal_token)}`, "See the details")}`);
  const ok = await sendBrevo(b, { email: c.email, name: c.name }, subject, html, undefined, { cc: rec?.email ? [{ email: rec.email, name: rec.full_name }] : [] });
  if (ok) await admin.from("candidate_timeline").insert({ candidate_id: c.id, title: "Told the employer wants to move forward: " + (role?.title || ""), done: true });
  return { sent: ok, error: ok ? "" : "The email couldn't be sent (check the email settings)" };
}
