// Where people are, checked in code against where the job is: every source runs it (X-ray, the
// re-check, Apollo, the talent pool, and email lookups that reveal a location), so nobody far from
// the office is kept just because the AI review left their location as "unknown".
//
//   Fully remote jobs: only the country (and, with preferred time zones in the US, the state).
//   On-site and hybrid jobs: is the place within about an hour's normal commute of the OFFICE (the
//   job's own location, not the generated "places nearby" list, which can be wrong)?
//     - the office city named in the location, or a place clearly inside it  -> yes
//     - another country                                                      -> no
//     - anything else: one AI question per distinct place, cached on the job (jobs.sourcing.geo)
//   Answers: yes (keep), no (drop / skip, with how far), unsure (too vague, e.g. "England" or
//   "Greater Chicago Area": kept with a note to check). An unknown location is the caller's matter.

import { askAI } from "./ai.ts";
import { cleanLocation, countryIn, broadPlace } from "./xray_rules.ts";
export { cleanLocation };
import { jobCountryNames } from "./regions.ts";

// "error": the check itself failed (AI unreachable) - never cached, never treated as a pass; the
// caller holds the person back until a later check answers.
export type AreaAnswer = { inArea: "yes" | "no" | "unsure" | "error"; note: string };
// Problems from the last checks (shown by the sweep), so a failing AI call never passes silently.
export const areaErrors: string[] = [];
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const fullyRemote = (job: any) => /remote/i.test(String(job.work_setup || "")) && !/hybrid/i.test(String(job.work_setup || ""));
const keyOf = (l: string) => l.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const US_STATES = ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "district of columbia", "florida", "georgia", "hawaii", "idaho", "illinois",
  "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
  "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas",
  "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming"];
const CODES: Record<string, string> = { AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", DC: "district of columbia",
  FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts",
  MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york",
  NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas",
  UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming" };
// The US state in a location ("Dover, NJ", "Atlanta, Georgia"), longest names first ("West Virginia").
function usState(loc: string): string {
  const l = " " + loc.toLowerCase() + " ";
  const named = [...US_STATES].sort((a, b) => b.length - a.length).find((st) => new RegExp("[^a-z]" + st + "[^a-z]").test(l));
  if (named) return named;
  const m = /(?:^|[,/]\s*)([A-Z]{2})(?:\s*$|[\s,/(])/.exec(loc.trim());
  return m && CODES[m[1]] ? CODES[m[1]] : "";
}

// The office: the job's own location (first part is the city), plus its country.
function office(job: any) {
  const loc = String(job.location || "").trim();
  return { text: [loc, job.country].filter(Boolean).join(", "), city: loc.split(",")[0].trim().toLowerCase() };
}

// Checks each distinct place once (cached on the job). Returns a map keyed by the cleaned place.
export async function checkPlaces(admin: any, job: any, area: any, places: string[]): Promise<Map<string, AreaAnswer>> {
  const out = new Map<string, AreaAnswer>();
  const allowed = new Set(jobCountryNames(job).map((x) => String(x || "").toLowerCase().trim()).filter(Boolean));
  const remote = fullyRemote(job);
  const states = area?.mode === "timezone" && Array.isArray(area.locations) ? new Set(area.locations.map((x: string) => x.toLowerCase())) : null;
  const { data: cur } = await admin.from("jobs").select("sourcing").eq("id", job.id).maybeSingle();
  const cache: Record<string, AreaAnswer> = { ...((cur?.sourcing || job.sourcing || {}).geo || {}) };
  const ask: string[] = [];
  const o = office(job);
  for (const raw of [...new Set(places.map(cleanLocation).filter(Boolean))]) {
    const k = keyOf(raw);
    const c = countryIn(raw);
    if (allowed.size && c && !allowed.has(c)) { out.set(raw, { inArea: "no", note: `${raw} is outside ${[...allowed][0].replace(/\b\w/g, (x) => x.toUpperCase())}` }); continue; }
    if (remote) {
      if (states && c === "united states") {
        const st = usState(raw);
        out.set(raw, st ? (states.has(st) ? { inArea: "yes", note: "" } : { inArea: "no", note: `${raw}: outside the time zones the job wants` }) : { inArea: "unsure", note: "" });
      } else out.set(raw, { inArea: c && allowed.has(c) ? "yes" : "unsure", note: "" });
      continue;
    }
    if (o.city.length > 2 && (" " + k + " ").includes(" " + keyOf(o.city) + " ")) { out.set(raw, { inArea: "yes", note: "" }); continue; }
    // Only a country or a state/region ("United Kingdom", "England", "Texas, United States"): can't
    // tell, unless the job itself covers that whole state (an office given only as "Virginia").
    if (broadPlace(raw) && !(o.city.length > 2 && keyOf(raw).includes(keyOf(o.city)))) { out.set(raw, { inArea: "unsure", note: "Only the country or region is shown" }); continue; }
    if (cache[k]) { out.set(raw, cache[k]); continue; }
    ask.push(raw);
  }
  if (ask.length) {
    const sys = "You check whether people's locations are within commuting distance of a job's office. Reply with STRICT JSON only: " +
      "{\"results\": [{\"i\": number, \"in_area\": \"yes\" | \"no\" | \"unsure\", \"note\": string}]}, one per place. " +
      "yes: the place is within about 60 to 75 minutes' normal commute (car or public transport) of the office, or (for a state-wide search area) inside that state or within an hour of it. " +
      "no: clearly farther than that (another city or region, e.g. Manchester or Sheffield for an office in Croydon, Missoula for an office in Kalispell, Jeddah for an office in Riyadh). " +
      "For a HYBRID job (only some days in the office), the city or metro area the office is part of counts as yes (e.g. 'London', 'Greater London' or 'London Area' for an office in Croydon; 'Greater Chicago Area' for Buffalo Grove); for a fully on-site job it is unsure. " +
      "unsure: the place is too vague to tell (a whole country, a big region like 'England' or 'Northern Illinois', or a metro area whose far side is out of reach). " +
      "note: for 'no', where it is and roughly how far, e.g. 'Sheffield, about 3.5 h from Croydon'; otherwise ''. Be accurate: use real geography, not the spelling.";
    for (let i = 0; i < ask.length; i += 40) {
      const batch = ask.slice(i, i + 40);
      const head = `Office: ${o.text || "(not given)"}\nWork setup: ${job.work_setup || "on-site"}\nSearch area: ${area?.summary || o.text}\n\nPlaces (i | place):\n`;
      let res: any = null;
      // Two tries (a busy AI often answers the second time); a failure is never read as "in the area".
      for (let t = 0; t < 2 && !Array.isArray(res?.results); t++) {
        if (t) await new Promise((r) => setTimeout(r, 4000));
        try { res = await askAI(sys, head + batch.map((p, n) => `${n} | ${p}`).join("\n"), 3000); } catch (e) { areaErrors.push(String((e as Error)?.message || e).slice(0, 200)); console.error("area check", areaErrors[areaErrors.length - 1]); }
        if (res && !Array.isArray(res?.results)) { areaErrors.push("unexpected answer: " + JSON.stringify(res).slice(0, 200)); res = null; }
      }
      for (const r of Array.isArray(res?.results) ? res.results : []) {
        const p = batch[Number(r?.i)];
        if (!p) continue;
        const a: AreaAnswer = { inArea: ["yes", "no", "unsure"].includes(r.in_area) ? r.in_area : "unsure", note: clip(r.note, 120) };
        out.set(p, a);
        cache[keyOf(p)] = a;
      }
      for (const p of batch) if (!out.has(p)) out.set(p, { inArea: res ? "unsure" : "error", note: res ? "" : "Location check failed: will retry" });
    }
    // Remember the answers on the job (the latest sourcing, so nothing else is overwritten).
    if (!Object.keys(cache).length) return out;
    const { data: now } = await admin.from("jobs").select("sourcing").eq("id", job.id).maybeSingle();
    const keep = Object.fromEntries(Object.entries(cache).slice(-400));
    await admin.from("jobs").update({ sourcing: { ...(now?.sourcing || {}), geo: keep } }).eq("id", job.id);
  }
  return out;
}

// One place: the answer, or null when the location is unknown.
export function answerFor(map: Map<string, AreaAnswer>, place: unknown): AreaAnswer | null {
  const c = cleanLocation(place);
  return c ? (map.get(c) || null) : null;
}

// Splits people by where they are: kept (in the area, or the place is vague / unknown: with a note)
// and dropped (clearly too far, with why). `loc` reads a person's location.
export async function splitByArea<T>(admin: any, job: any, area: any, people: T[], loc: (p: T) => unknown) {
  const map = await checkPlaces(admin, job, area, people.map((p) => String(loc(p) || "")));
  const kept: { p: T; note: string; hold?: string }[] = [], dropped: { p: T; why: string }[] = [];
  const onsite = !fullyRemote(job);
  for (const p of people) {
    const a = answerFor(map, loc(p));
    if (a && a.inArea === "no") { dropped.push({ p, why: "Outside the commute area" + (a.note ? ": " + a.note : "") }); continue; }
    // hold: not emailed automatically until someone checks (or a later check answers).
    const hold = !a ? (onsite ? "Location not shown" : "") : a.inArea === "error" ? "Location not checked yet" : a.inArea === "unsure" && onsite ? (a.note || "Location vague") : "";
    kept.push({ p, note: hold ? hold + ": check they can commute" : "", ...(hold ? { hold } : {}) });
  }
  return { kept, dropped };
}

// ---- A possible location from someone's recent jobs ---------------------------------------------
// A profile's location can be missing, vague, out of date or their employer's head office. Their two
// most recent jobs that aren't remote say where they've actually been working: the place shown for
// that job, or the employer's own location when it's a local business with one site. Used to keep
// people the profile location alone would drop (shown to the recruiter as a possible location to
// double check), and to leave out people whose recent work is clearly far away.
export type RecentJob = { company: string; title: string; place: string; basis: "shown" | "employer" | "" };
export const cleanRecentJobs = (v: unknown): RecentJob[] => (Array.isArray(v) ? v : []).slice(0, 2).map((x: any) => ({
  company: clip(x?.company, 100), title: clip(x?.title, 100), place: cleanLocation(x?.place),
  basis: (["shown", "employer"].includes(String(x?.basis)) ? String(x.basis) : "") as RecentJob["basis"],
})).filter((x) => x.company || x.place);

// For people with only a work history (Apollo's "Title at Company (dates)" lines, or a snippet):
// their two most recent non-remote jobs and where each was. One AI question per batch of 20.
export async function inferRecentJobs(items: { key: string; text: string }[]): Promise<Map<string, RecentJob[]>> {
  const out = new Map<string, RecentJob[]>();
  const todo = items.filter((x) => String(x.text || "").trim());
  const sys = "You read people's work histories and give, for each person, their two most recent jobs that are NOT remote, and where each job was. Reply with STRICT JSON only: " +
    "{\"people\": [{\"i\": number, \"jobs\": [{\"company\": string, \"title\": string, \"place\": string, \"basis\": \"shown\" | \"employer\" | \"\"}]}]}. " +
    "place: 'City, State/Region, Country'. basis 'shown' when the history states where that job was; 'employer' when not stated but the employer is a local business with one site you know (or the history names its town); " +
    "'' with place '' when you can't tell (e.g. a large company with many offices and no location given). Skip jobs marked remote or work from home. Most recent first. Use real knowledge, don't guess.";
  for (let i = 0; i < todo.length; i += 20) {
    const batch = todo.slice(i, i + 20);
    let res: any = null;
    try { res = await askAI(sys, batch.map((x, n) => `${n} | ${clip(x.text, 1200)}`).join("\n"), 3000); } catch (e) { areaErrors.push("recent jobs: " + String((e as Error)?.message || e).slice(0, 160)); }
    for (const r of Array.isArray(res?.people) ? res.people : []) { const it = batch[Number(r?.i)]; if (it) out.set(it.key, cleanRecentJobs(r.jobs)); }
    if (res) for (const it of batch) if (!out.has(it.key)) out.set(it.key, []);
  }
  return out;
}

// Where their recent jobs put them, against the job's office / area: 'near' (a recent job is in the
// area: the possible location), 'far' (every recent job with a place is clearly too far), or 'unknown'.
export async function placeFromJobs(admin: any, job: any, area: any, jobs: RecentJob[]): Promise<{ status: "near" | "far" | "unknown"; place: string; company: string; basis: string; note: string }> {
  const withPlace = jobs.filter((x) => x.place);
  if (!withPlace.length) return { status: "unknown", place: "", company: "", basis: "", note: "" };
  const map = await checkPlaces(admin, job, area, withPlace.map((x) => x.place));
  const near = withPlace.find((x) => answerFor(map, x.place)?.inArea === "yes");
  if (near) return { status: "near", place: near.place, company: near.company, basis: near.basis, note: "" };
  const far = withPlace.filter((x) => answerFor(map, x.place)?.inArea === "no");
  if (far.length === withPlace.length) return { status: "far", place: far[0].place, company: far[0].company, basis: far[0].basis, note: answerFor(map, far[0].place)?.note || "" };
  return { status: "unknown", place: "", company: "", basis: "", note: "" };
}
// The words shown to the recruiter for a possible location.
export const possibleText = (pl: { place: string; company: string; basis: string }) =>
  `Possible location ${pl.place} (from their job${pl.company ? " at " + pl.company : ""}${pl.basis === "employer" ? ", where that employer is based" : ""}): double check where they live`;
