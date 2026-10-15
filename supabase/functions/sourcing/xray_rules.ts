// How an X-ray search result is judged against a job. Shared by the X-ray search (xray.ts) and
// the re-check of people already found (../xray-recheck), so both apply exactly the same rules.
//
// The AI reads only a result's title line and snippet. What it can't see is "unconfirmed", never
// "not met", and doesn't lower the fit. People are removed only for something the result actually
// shows (or a clear location):
//   - a company page rather than a person
//   - working at the hiring company now
//   - based in another country (for any role), or outside the commute area (on-site / hybrid roles)
//   - a core must-have (the first three checklist items) clearly contradicted
//   - running a business in a different field from the role
//   - a clear "Not a fit" from the AI (field, level or title don't match), or fit under 40
// Someone who runs their own practice in the same profession (a CPA with their own firm, a
// self-employed electrician, a shareholder at an accounting firm) is kept, with a note to check
// they'd take an employed role. Notes for the recruiter go first in `gaps` (shown as "Gaps to check").

import { jobBrief } from "./prospects.ts";
import { COUNTRY_NAMES, jobCountryNames } from "./regions.ts";
import { sameCompany } from "./common.ts";

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ---- Where someone is: country from a free-text location ------------------------------------
// US states are checked first, so "New Jersey", "Atlanta, Georgia" and "New Mexico" are the
// United States, not Jersey, Georgia or Mexico.
const US_STATE_NAMES = ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "district of columbia", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming"];
const US_STATE_RE = new RegExp("(^|[^a-z])(" + US_STATE_NAMES.join("|") + ")($|[^a-z])");
// Two-letter codes only after a comma, slash or at the start, in capitals ("Dover, PA", "NJ / Remote").
const US_CODE_RE = /(^|[,/]\s*)(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(\s*($|[,/(]|\s))/;
const ALIAS: Record<string, string> = { "usa": "united states", "u.s.": "united states", "u.s.a.": "united states", "uk": "united kingdom", "england": "united kingdom", "scotland": "united kingdom", "wales": "united kingdom", "uae": "united arab emirates" };
const COUNTRIES = [...new Set(Object.values(COUNTRY_NAMES).map((x) => String(x).toLowerCase()))].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)
  .map((c) => ({ c, re: new RegExp("(^|[^a-z])" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^a-z])") }));

export function countryIn(loc: string): string {
  const raw = String(loc || "");
  const l = " " + raw.toLowerCase().replace(/[()]/g, " ") + " ";
  // A named country other than the US wins over a state-like word ("Tbilisi, Georgia" stays Georgia).
  if (/tbilisi|batumi|kutaisi/.test(l)) return "georgia";
  if (US_STATE_RE.test(l) || US_CODE_RE.test(raw.trim())) return "united states";
  for (const [a, c] of Object.entries(ALIAS)) if (new RegExp("[\\s,/]" + a.replace(/\./g, "\\.") + "[\\s,/]").test(l)) return c;
  return (COUNTRIES.find((x) => x.re.test(l)) || { c: "" }).c;
}

// ---- What the AI is asked ---------------------------------------------------------------------
export const REVIEW_SYSTEM = "You are a recruitment researcher reviewing search-engine results for people's public profiles (LinkedIn and technical sites) against one job. " +
  "You only see each result's title line and short snippet, not the full profile. Reply with STRICT JSON only: " +
  "{\"people\": [{\"i\": number, \"name\": string, \"headline\": string, \"company\": string, \"location\": string, \"in_area\": \"yes\" | \"no\" | \"unknown\", \"area_note\": string, " +
  "\"client_history\": \"current\" | \"past\" | \"none\", \"company_page\": boolean, \"own_practice\": boolean, \"own_practice_same_field\": boolean, \"remote\": boolean, \"overview\": string, " +
  "\"checklist\": [{\"item\": string, \"status\": \"met\" | \"unconfirmed\" | \"not met\", \"evidence\": string}], \"gaps\": string[], \"fit\": number, \"verdict\": \"Good fit\" | \"Possible fit\" | \"Not a fit\", \"why\": string}]}, one entry per person. " +
  "name, headline (their current title) and company (current employer) come ONLY from the result ('' when not shown). " +
  "location: where they live or work NOW: the 'Location:' part of a LinkedIn snippet, or the place shown next to their current role. Never a past job's city, a school, or an employer's head office; '' when not shown. " +
  "in_area: for an on-site or hybrid job, 'yes' when their current location is one of the places in the search area or clearly within about an hour's commute of the office, 'no' when it is clearly farther, 'unknown' when no location is shown. " +
  "For a remote job, 'yes' when they are in the job's country, 'no' when clearly in another country, otherwise 'unknown'. " +
  "area_note: when in_area is 'no', where they are and roughly how far, e.g. 'Missoula, about 2 h from Kalispell'; otherwise ''. " +
  "client_history: 'current' when the result shows them working at the hiring company now, 'past' when it shows they worked there before, otherwise 'none'. " +
  "company_page: true ONLY when the result is a company, brand, agency or group page rather than one person. " +
  "own_practice: true when the person runs, owns, founded, or is a partner or shareholder in their own business or practice, or is self-employed / freelance. " +
  "own_practice_same_field: true when that business is in the same profession or trade as the job (e.g. a CPA running an accounting practice for a CPA job, a self-employed electrician for an electrician job). " +
  "Running their own practice in the same field is relevant experience and is NOT a reason for 'Not a fit'. " +
  "remote: true when the result shows they work remotely (a remote role, 'Remote', 'remotely', work from home) or work for an employer in another country than where they live; otherwise false. " +
  "overview: 1 to 2 short sentences on what the result shows about them that matters for this job. " +
  "checklist: exactly the job's checklist items given, in the same order and wording. 'met' only when the result clearly shows it. 'not met' ONLY when the result states something that contradicts it " +
  "(based somewhere else, a different field, clearly more junior or senior, or explicitly lacking it). Information that is simply not in the snippet is ALWAYS 'unconfirmed', never 'not met': " +
  "a headline without 'CPA' does not mean they have no licence, and software, degrees or years are rarely shown. evidence: a few words from the result, '' if none. " +
  "gaps: up to 4 short items: what is 'not met' first, then the most important 'unconfirmed' must-haves to check with them. " +
  "fit: a percentage from 0 to 100 (never a 0-10 score) for how promising they are to approach, judged on what the result DOES show: matching title, seniority, field, employer type and location count most. " +
  "'unconfirmed' items do not lower it; each 'not met' item lowers it a lot. " +
  "verdict: 'Good fit' when title, seniority and field match, nothing is 'not met' and in_area is not 'no'. " +
  "'Not a fit' when any of the first three checklist items (the core must-haves) is 'not met', when the field, level or title clearly doesn't match, when in_area is 'no', when they work for the hiring company now, " +
  "when company_page is true, or when they run a business in a different field from the job. Otherwise 'Possible fit'. " +
  "A search result can never prove everything, so never say 'Perfect fit'. For a GitHub result, judge technical skills from their bio, languages, repositories and followers. " +
  "why: under 15 words, the deciding reason for the verdict.";

// The job, its search area (with the actual places for on-site and hybrid roles) and checklist.
export function reviewHead(job: any, area: any, checklist: string[]) {
  const places = Array.isArray(area?.locations) && area.locations.length && area.mode !== "country" ? `\nPlaces in the search area: ${area.locations.slice(0, 40).join("; ")}` : "";
  return jobBrief(job, false) + `\nWork setup: ${job.work_setup || "(not set)"}` +
    `\nHiring company (people who work there now are 'Not a fit'): ${job.client || "(not given)"}` +
    `\nSearch area (where candidates must be based now): ${area?.summary || job.location || job.country || "(not set)"}${places}` +
    `\n\nJob checklist:\n${checklist.map((c) => "- " + c).join("\n") || "(none)"}\n\nPeople (i | site | result title | snippet):\n`;
}

// ---- The decision -------------------------------------------------------------------------------
export type Judged = {
  keep: boolean; reasons: string[]; notes: string[]; fit: number; verdict: string; location: string; locationSource: string;
  remote: boolean; clientHistory: "past" | "none"; ownPractice: boolean; checklist: any[]; gaps: string[];
};
const OWNER = /\b(founder|co-?founder|owner|proprietor|self[- ]employed|shareholder|partner at|managing director)\b/i;
const REMOTE = /\bremote(ly)?\b|work(ing)? from home|\bwfh\b/i;
const CAP = (s: string) => s.replace(/\b\w/g, (x) => x.toUpperCase());

export function judge(job: any, hit: { title?: string; snippet?: string }, r: any): Judged {
  const snippet = String(hit.snippet || ""), title = String(hit.title || "");
  const allowed = new Set(jobCountryNames(job).map((x) => String(x || "").toLowerCase().trim()).filter(Boolean));
  const jobRemote = /remote|hybrid/i.test(String(job.work_setup || "")) || /remote|hybrid/i.test(String(job.location || ""));
  const fullyRemote = /remote/i.test(String(job.work_setup || ""));
  const fromSnippet = (snippet.match(/(?:Location|Lives in|Based in)\s*[:：]\s*([^·|\n]{2,80})/i) || [])[1];
  const location = clip(fromSnippet || r.location, 120);
  const c = location ? countryIn(location) : "";
  // Remote workers: the location they show may be their employer's, so it never counts as confirmed
  // and they can't be a 'Good fit' until someone checks where they live (relaxed on remote/hybrid
  // roles when they show a place inside the role's country).
  const remoteSigns = r.remote === true || REMOTE.test(String(r.headline || "") + " " + title + " " + snippet);
  const remote = remoteSigns && !(jobRemote && (!allowed.size || (c && allowed.has(c))));
  let fit = Math.max(0, Math.min(100, Math.round(Number(r.fit) || 0)));
  let verdict = ["Good fit", "Possible fit", "Not a fit"].includes(r.verdict) ? r.verdict : "Possible fit";
  if (remote) { fit = Math.max(0, fit - 10); if (verdict === "Good fit") verdict = "Possible fit"; }

  const checklist = (Array.isArray(r.checklist) ? r.checklist : []).slice(0, 10).map((x: any) => ({
    item: clip(x?.item, 100), status: ["met", "unconfirmed", "not met"].includes(String(x?.status)) ? String(x.status) : "unconfirmed", evidence: clip(x?.evidence, 140),
  }));
  const ownPractice = r.own_practice === true || OWNER.test(String(r.headline || "") + " " + title);
  const sameField = r.own_practice_same_field !== false; // only a clear 'different field' counts against them

  const reasons: string[] = [];
  if (r.company_page === true) reasons.push("A company page, not a person");
  // A hidden client ("Confidential") can't be matched by name.
  const client = /^\s*(confidential|undisclosed|n\/?a)\s*$/i.test(String(job.client || "")) ? "" : String(job.client || "");
  if (r.client_history === "current" || (client && sameCompany(r.company, client))) reasons.push("Works at " + (client || "the client") + " now");
  if (allowed.size && c && !allowed.has(c)) reasons.push("Based in " + CAP(c) + ", outside the role's country");
  else if (!fullyRemote && r.in_area === "no") reasons.push("Outside the commute area" + (clip(r.area_note, 80) ? ": " + clip(r.area_note, 80) : ""));
  const coreMissing = checklist.slice(0, 3).filter((x: any) => x.status === "not met");
  if (coreMissing.length) reasons.push("Misses a core must-have: " + coreMissing.map((x: any) => clip(x.item, 50)).join(", "));
  if (r.own_practice === true && r.own_practice_same_field === false && r.company_page !== true) reasons.push("Runs a business in a different field");
  if (verdict === "Not a fit" && !reasons.length) reasons.push(clip(r.why, 100) || "Not a fit for the role");
  if (fit < 40 && !reasons.length) reasons.push("Low fit (" + fit + "%)");

  // Notes for the recruiter, shown first under "Gaps to check".
  const notes: string[] = [];
  if (ownPractice && sameField && r.company_page !== true) notes.push("Runs own practice: check they'd take an employed role");
  if (checklist.length && !checklist.some((x: any) => x.status === "met")) notes.push("Thin profile: check the must-haves");
  if (!fullyRemote && r.in_area === "unknown" && !remote) notes.push("Location not shown: check they can commute");
  const gaps = [...notes, ...(Array.isArray(r.gaps) ? r.gaps : []).map((g: unknown) => clip(g, 120))].filter(Boolean).slice(0, 5);

  return {
    keep: reasons.length === 0, reasons, notes, fit, verdict: reasons.length ? "Not a fit" : verdict === "Not a fit" ? "Possible fit" : verdict,
    location, locationSource: remote ? "remote" : fromSnippet ? "profile" : location ? "result" : "", remote,
    clientHistory: r.client_history === "past" ? "past" : "none", ownPractice, checklist, gaps,
  };
}
