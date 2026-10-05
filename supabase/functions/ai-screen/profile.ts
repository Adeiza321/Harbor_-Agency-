import { normalizeLinkedIn } from "./resume.ts";

// Profile facts read from a resume: current title and employer, experience, location, phone,
// notice, pay and skills. Strict rules plus a clean-up pass, so the profile holds short,
// accurate values instead of paragraphs, guesses or the wrong kind of answer.

export const PROFILE_SHAPE =
  `"current_title": string, "current_company": string, "experience": string, "location": string, "phone": string, "linkedin": string, "notice": string, "pay": string, "skills": string[]`;

export const PROFILE_RULES =
  "PROFILE FACTS: take them ONLY from what the CV or the candidate's own answers actually state. Never guess or infer; use '' when something isn't stated. " +
  "'current_title': their current or most recent job title exactly as the CV gives it (NOT the job they are being considered for). 'current_company': that employer. " +
  "'experience': at most 60 characters, total years plus field, e.g. '12 yrs technical accounting' or '20+ yrs finance leadership'. No lists of roles or sentences. " +
  "'location': where the CANDIDATE lives, taken ONLY from the CV's header/contact block (at the top, with their name, email and phone) or from their own answers. 'City, ST' (US) or 'City, Country'. No street or postcode. " +
  "NEVER use the location of an employer, job, client, school or project, NEVER infer it from a phone area code, and never guess: if the header doesn't give their location, use ''. " +
  "'linkedin': their LinkedIn profile URL if the CV shows one (e.g. 'linkedin.com/in/jane-doe'), else ''. " +
  "'phone': the phone number exactly as written. " +
  "'notice': ONLY their notice period or earliest start date as they stated it (e.g. '2 weeks', 'Available immediately', '1 month, early Nov start'). Interview availability or time slots are NOT notice. '' if not stated. " +
  "'pay': ONLY their own salary or rate expectation, shortened to amount, currency and period (e.g. '$150k–$200k/yr', '$85–$115/hr', '₦12m/yr'). '' if not stated. " +
  "'skills': the 8 to 15 most important hard skills, tools, standards or certifications the CV shows actual work with (e.g. 'ASC 606', 'NetSuite', 'SQL', 'CPA'), most relevant first; 1 to 4 words each. No soft skills, no duplicates, no sentences. ";

const str = (v: unknown, n: number) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s === "-" || /^(n\/a|none|not stated|unknown)$/i.test(s) ? "" : s.slice(0, n);
};

// Salary expectation in one short form: amount, currency and period only ("$150k–$200k/yr",
// "$85–$115/hr"). Explanations, conversions and asides are dropped.
const AMOUNT = "(?:[$₦£€]\\s?\\d[\\d,.]*\\s?[kKmM]?|\\d[\\d,.]*\\s?[kKmM]\\b|\\d[\\d,.]{2,})";
const RANGE_RE = new RegExp(AMOUNT + "(?:\\s*(?:–|—|-|to)\\s*" + AMOUNT + ")?", "i");
const periodOf = (s: string) =>
  /\b(hour|hourly|hr)\b|\/\s?h(ou)?r\b/i.test(s) ? "/hr" : /\b(month|monthly|mo)\b|\/\s?mo\b/i.test(s) ? "/mo" : /\b(year|yearly|annum|annual|annually|yr|salary)\b|\/\s?yr\b/i.test(s) ? "/yr" : "";
function tidyRange(part: string) {
  const m = part.match(RANGE_RE);
  if (!m) return "";
  let range = m[0].replace(/\s*(–|—|-|to)\s*(?=[$₦£€\d])/i, "–").replace(/\s+/g, "").replace(/[.,]+$/, "");
  // A currency written as a code ("USD 150,000", "100000 NGN") becomes its symbol.
  const code = part.match(/\b(USD|NGN|GBP|EUR|CAD)\b/i);
  if (code && !/[$₦£€]/.test(range)) {
    const sym = ({ usd: "$", ngn: "₦", gbp: "£", eur: "€", cad: "CA$" } as Record<string, string>)[code[1].toLowerCase()];
    range = range.split("–").map((x) => sym + x).join("–");
  }
  return range + periodOf(part);
}
export function cleanPay(v: unknown) {
  const s = str(v, 400).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  // Two alternatives ("$36/hr or $80,000/yr") keep both, each in short form.
  const alts = s.split(/\s+or\s+/i).map(tidyRange).filter(Boolean);
  if (alts.length > 1) return alts.slice(0, 2).join(" or ").slice(0, 60);
  const one = tidyRange(s);
  // No amount at all: keep a short note like "Negotiable", drop a long sentence.
  return one || (s.length <= 40 ? s : "");
}

export function cleanProfile(r: any) {
  const rawLoc = str(r?.location, 120);
  // A hedged location ("to confirm", "area code") is a guess, so it's dropped, not trimmed.
  const location = /to confirm|unconfirmed|area code|probably|likely/i.test(rawLoc) ? "" : rawLoc
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")                                  // US zip codes
    .replace(/[\s,]+$/, "").trim().slice(0, 80);
  const seen = new Set<string>();
  const skills = (Array.isArray(r?.skills) ? r.skills : [])
    .map((x: unknown) => str(x, 200))
    .filter((x: string) => {
      const k = x.toLowerCase();
      // A skill is a short term; sentences and long phrases are dropped, not cut.
      if (!x || x.length > 40 || x.split(" ").length > 5 || seen.has(k)) return false;
      seen.add(k); return true;
    })
    .slice(0, 15);
  return {
    current_title: str(r?.current_title, 90),
    current_company: str(r?.current_company, 90),
    experience: str(r?.experience, 70),
    location,
    phone: str(r?.phone, 40),
    linkedin: normalizeLinkedIn(r?.linkedin),
    notice: str(r?.notice, 80),
    pay: cleanPay(r?.pay),
    skills,
  };
}
