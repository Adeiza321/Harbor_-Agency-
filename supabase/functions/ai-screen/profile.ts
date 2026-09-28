// Profile facts read from a resume: current title and employer, experience, location, phone,
// notice, pay and skills. Strict rules plus a clean-up pass, so the profile holds short,
// accurate values instead of paragraphs, guesses or the wrong kind of answer.

export const PROFILE_SHAPE =
  `"current_title": string, "current_company": string, "experience": string, "location": string, "phone": string, "notice": string, "pay": string, "skills": string[]`;

export const PROFILE_RULES =
  "PROFILE FACTS: take them ONLY from what the CV or the candidate's own answers actually state. Never guess or infer; use '' when something isn't stated. " +
  "'current_title': their current or most recent job title exactly as the CV gives it (NOT the job they are being considered for). 'current_company': that employer. " +
  "'experience': at most 60 characters, total years plus field, e.g. '12 yrs technical accounting' or '20+ yrs finance leadership'. No lists of roles or sentences. " +
  "'location': 'City, ST' (US) or 'City, Country', as stated on the CV or in their answers. No street or postcode. '' if not stated. NEVER infer a location from a phone area code. " +
  "'phone': the phone number exactly as written. " +
  "'notice': ONLY their notice period or earliest start date as they stated it (e.g. '2 weeks', 'Available immediately', '1 month, early Nov start'). Interview availability or time slots are NOT notice. '' if not stated. " +
  "'pay': ONLY their own salary or rate expectation, shortened to amount, currency and period (e.g. '$150k–$200k/yr', '$85–$115/hr', '₦12m/yr'). '' if not stated. " +
  "'skills': the 8 to 15 most important hard skills, tools, standards or certifications the CV shows actual work with (e.g. 'ASC 606', 'NetSuite', 'SQL', 'CPA'), most relevant first; 1 to 4 words each. No soft skills, no duplicates, no sentences. ";

const str = (v: unknown, n: number) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s === "-" || /^(n\/a|none|not stated|unknown)$/i.test(s) ? "" : s.slice(0, n);
};

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
    notice: str(r?.notice, 80),
    pay: str(r?.pay, 60),
    skills,
  };
}
