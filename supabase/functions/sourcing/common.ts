// Shared pieces: settings with defaults, title matching (same rules as ai-screen's bench
// check), busy candidates, and anonymous candidate summaries for client pitches.

export type Settings = {
  approval: "manual" | "auto";        // manual: a person approves each email before it is sent
  regions: string[];                   // where to look for new clients: "EU" or country codes ("US", "MY", "NG"…)
  minInternalFits: number;             // search outside Pronext only when fewer good fits than this
  prospectsPerJob: number;             // most emails revealed (Apollo credits) per job
  xrayPerJob: number;                  // most people kept per job from free X-ray searches (no credits)
  xrayEmailsPerDay: number;            // most X-ray people looked up in Apollo per day, automatically (0 = off)
  xrayEmailMinFit: number;             // only X-ray people at least this good a fit are looked up automatically
  emailLookup: "apollo_only" | "apollo" | "contactout";   // which email source is asked first (ContactOut credits ran out Oct 2026)
  pdlEmailsPerDay: number;             // most X-ray people looked up in People Data Labs per day when Apollo had no email (0 = off)
  pdlPerSearch: number;                // most people one People Data Labs search returns (1 credit each)
  dailyCap: number;                    // most outreach emails sent per day
  clientSender: "auto" | "brevo";      // client pitches: the outreach sender (Apollo...) or Brevo (for now)
  clientBrevoPerDay: number;           // most client pitch emails through Brevo per day
  senderName: string; senderTitle: string; businessAddress: string;
  footerName: string;                  // company name in footers: Agency settings' full name, else the agency name
  includePay: boolean;                 // mention the pay range in candidate outreach
  // minEmployees / maxEmployees: the company sizes searched (small and medium companies are likelier to
  // take an agency's CVs and pay); 0 = no limit on that side.
  leads: { enabled: boolean; postingsPerDay: number; maxAgeDays: number; minEmployees: number; maxEmployees: number };
  // The contract sent by itself when a company says it's interested in our candidates (client leads).
  contract: { enabled: boolean; subject: string; body: string; url: string };
  retentionDays: number;               // delete prospects nobody engaged with after this long
  // Reply-to for client pitches and follow-ups once client replies are on (replies.ts), so Pronext
  // sees the reply and stops the follow-ups; "" = replies go to OUTREACH_REPLY_TO as before.
  replyTo: string;
};

// The address in every outreach and candidate email footer: always the UK office, whatever is set
// in Agency settings.
export const UK_ADDRESS = "167-169 Great Portland Street, 5th Floor, London W1W 5PF, United Kingdom";

export async function loadSettings(admin: any): Promise<{ s: Settings; agencyName: string }> {
  const { data } = await admin.from("agency_settings").select("*").limit(1).maybeSingle();
  const rep = (data?.replies && typeof data.replies === "object") ? data.replies : {};
  const o = (data?.outreach && typeof data.outreach === "object") ? data.outreach : {};
  const company = (data?.company && typeof data.company === "object") ? data.company : {};
  const num = (v: unknown, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : d; };
  const addr = UK_ADDRESS;
  const agencyName = String(data?.agency_name || company.name || "").trim();
  return {
    agencyName,
    s: {
      approval: o.approval === "auto" ? "auto" : "manual",
      regions: Array.isArray(o.regions) && o.regions.length ? o.regions : ["US", "EU", "MY"],
      minInternalFits: num(o.minInternalFits, 3, 0, 50),
      prospectsPerJob: num(o.prospectsPerJob, 20, 1, 100),
      xrayPerJob: num(o.xrayPerJob, 40, 5, 80),
      xrayEmailsPerDay: num(o.xrayEmailsPerDay, 40, 0, 500),
      xrayEmailMinFit: num(o.xrayEmailMinFit, 60, 0, 100),
      pdlEmailsPerDay: num(o.pdlEmailsPerDay, 10, 0, 200),
      emailLookup: ["apollo", "contactout"].includes(o.emailLookup) ? o.emailLookup : "apollo_only",
      pdlPerSearch: num(o.pdlPerSearch, 20, 5, 100),
      dailyCap: num(o.dailyCap, 40, 1, 1000),
      clientSender: o.clientSender === "brevo" ? "brevo" : "auto",
      clientBrevoPerDay: num(o.clientBrevoPerDay, 15, 1, 100),
      senderName: String(o.senderName || "").trim(),
      senderTitle: String(o.senderTitle || "").trim(),
      businessAddress: addr,
      footerName: String(company.legalName || "").trim() || agencyName,
      includePay: o.includePay !== false,
      leads: {
        enabled: !!o.leads?.enabled,
        postingsPerDay: num(o.leads?.postingsPerDay, 25, 1, 100),
        maxAgeDays: num(o.leads?.maxAgeDays, 1, 1, 14),
        minEmployees: num(o.leads?.minEmployees, 10, 0, 100000),
        maxEmployees: num(o.leads?.maxEmployees, 500, 0, 1000000),
      },
      retentionDays: num(o.retentionDays, 90, 14, 365),
      replyTo: rep.status === "on" && rep.domain ? "replies@" + rep.domain : "",
      contract: { enabled: !!o.contract?.enabled, subject: String(o.contract?.subject || "").trim().slice(0, 200), body: String(o.contract?.body || "").slice(0, 6000), url: /^https:\/\//.test(String(o.contract?.url || "")) ? String(o.contract.url).trim() : "" },
    },
  };
}

// What still has to be filled in before any outreach email can go out.
export function sendBlockers(s: Settings): string[] {
  const out: string[] = [];
  if (!s.senderName) out.push("sender name");
  if (!s.businessAddress) out.push("business postal address");
  return out;
}

// --- title matching (kept in step with ai-screen/screening.ts) ---
const TITLE_ABBR: Record<string, string> = { sr: "senior", jr: "junior", mgr: "manager", vp: "vice president", acct: "accounting", eng: "engineer", dev: "developer", ops: "operations", hr: "human resources", fp: "fp&a", svp: "senior vice president", avp: "assistant vice president" };
const LEVEL = new Set(["senior", "junior", "lead", "principal", "head", "associate", "assistant", "staff", "chief", "deputy", "i", "ii", "iii", "iv", "entry", "level", "graduate", "trainee", "intern", "vice", "president", "executive"]);
const ROLE_NOUN = new Set(["manager", "director", "analyst", "specialist", "officer", "consultant", "coordinator", "supervisor", "administrator", "representative", "associate", "partner", "advisor", "adviser", "controller", "accountant", "engineer", "developer"]);
const titleWords = (t: string) => String(t || "").toLowerCase().replace(/[^a-z0-9&+ ]+/g, " ").split(/\s+/).filter(Boolean)
  .flatMap((w) => (TITLE_ABBR[w] || w).split(" ")).filter((w) => !["of", "and", "the", "for", "to", "in", "&"].includes(w));
export function titleScore(jobTitle: string, titles: string[]): number {
  const job = titleWords(jobTitle).filter((w) => !LEVEL.has(w));
  if (!job.length) return 0;
  const domain = job.filter((w) => !ROLE_NOUN.has(w));
  let best = 0;
  for (const t of titles) {
    const tw = new Set(titleWords(t));
    const shared = job.filter((w) => tw.has(w)).length;
    if (domain.length && !domain.some((w) => tw.has(w))) continue;
    best = Math.max(best, shared / job.length);
  }
  return best;
}
// Best match between any of one side's titles and any of the other's, both directions.
export function titlesMatch(a: string[], b: string[]): number {
  let best = 0;
  for (const t of a) best = Math.max(best, titleScore(t, b));
  for (const t of b) best = Math.max(best, titleScore(t, a));
  return best;
}

const BUSY_STAGES = ["Interview", "Offer", "Placed"];
const BUSY_STATUSES = ["Interview", "Placed", "Hired"];
export const isBusy = (c: any) =>
  BUSY_STATUSES.includes(c.status) || (c.candidate_jobs || []).some((l: any) => l.candidate_response !== "declined" && BUSY_STAGES.includes(l.stage));

export const candTitles = (c: any) => [c.current_title, ...(Array.isArray(c.parallel_titles) ? c.parallel_titles : [])].filter(Boolean).map(String);

// A candidate described without anything that identifies them: no name, no current employer.
export function anonSummary(c: any): string {
  const inds = [...new Set((Array.isArray(c.industries) ? c.industries : []).filter((x: any) => x?.confidence === "confirmed" && x.industry).map((x: any) => x.industry))].slice(0, 4);
  return [
    `Title: ${c.current_title || "?"}`,
    `Experience: ${c.experience && c.experience !== "-" ? c.experience : "?"}`,
    `Location: ${c.location || "?"}`,
    `Notice: ${c.notice && c.notice !== "-" ? c.notice : "?"}`,
    `Skills: ${(c.skills || []).slice(0, 12).join(", ") || "?"}`,
    `Strengths: ${(c.strengths || []).slice(0, 5).join("; ") || "?"}`,
    `Industries: ${inds.join(", ") || "?"}`,
    `Other titles they fit: ${(Array.isArray(c.parallel_titles) ? c.parallel_titles : []).slice(0, 6).join(", ") || "?"}`,
  ].join(" | ");
}

// Last line of defence for anonymity: strip the candidate's name and current employer if the
// AI slipped them into a pitch.
export function scrub(text: string, cands: any[]): string {
  let t = String(text || "");
  for (const c of cands) {
    const last = String(c.name || "").trim().split(/\s+/).slice(1).pop() || "";
    const pairs: [string, string][] = [[c.name, "the candidate"], [last.length > 3 ? last : "", "the candidate"], [c.current_company, "their current employer"]];
    for (const [w, sub] of pairs) {
      if (!w || String(w).trim().length < 2) continue;
      t = t.replace(new RegExp("\\b" + String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi"), sub);
    }
  }
  return t;
}

// ---- Employers that don't take agency candidates ----
// What a job description says when the employer won't take CVs from agencies or pay for unsolicited
// ones ("No agencies", "We do not accept unsolicited resumes", "Principals only", "We are not
// responsible for fees related to unsolicited resumes"). The first match is returned, '' when none.
const NO_AGENCY_RE: RegExp[] = [
  /\bunsolicited\s+(resumes?|résumés?|cvs?|candidates?|submissions?|profiles?|applications?|referrals?)\b/i,
  /\bprincipals\s+only\b/i,
  /\bno\s+(third[\s-]?part(y|ies)|3rd[\s-]?part(y|ies)|outside|external)\s+(recruit\w*|agenc\w*|staffing|candidates?|submissions?|resumes?)/i,
  /\bno\s+(recruitment\s+|staffing\s+|search\s+)?(agencies|agency\s+(submissions|calls|candidates)|recruiters|headhunters)\b/i,
  /\b(agencies|recruiters|headhunters|third[\s-]?part(y|ies)|staffing\s+firms)\b.{0,60}\b(need\s+not|should\s+not|shouldn't|do\s+not|don't|will\s+not|won't|must\s+not|are\s+not\s+to)\b.{0,25}\b(apply|contact|call|submit|send|reach)/i,
  /\b(do(es)?\s+not|don't|will\s+not|won't|cannot|can't|are\s+not|is\s+not)\s+(accept(ing)?|work(ing)?\s+with|engag(e|ing)|us(e|ing)|consider(ing)?)\s+(any\s+)?(unsolicited\s+)?((third[\s-]?party|external|outside|recruitment|staffing)\s+)*(agenc(y|ies)|recruiters|headhunters)/i,
  /\bnot\s+(be\s+)?(responsible|liable|obligated)\b.{0,50}\b(fees?|unsolicited|agenc(y|ies)|recruiters?)\b/i,
];
export function noAgencyText(desc: unknown): string {
  const t = String(desc || "").replace(/\s+/g, " ");
  for (const re of NO_AGENCY_RE) { const m = t.match(re); if (m) return m[0].slice(0, 120); }
  return "";
}

// ---- Never pitch someone to their own (current or former) employer ----
const CO_SUFFIX = /\b(the|inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|companies|and|plc|gmbh|ag|sa|bv|nv|group|holdings?|international|intl)\b/g;
export function normCompany(v: unknown): string {
  return String(v || "").toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(CO_SUFFIX, " ").replace(/\s+/g, " ").trim();
}
// Same company: equal once normalised, or one is the other plus extra words ("Bill" / "Bill.com").
export function sameCompany(a: unknown, b: unknown): boolean {
  const x = normCompany(a), y = normCompany(b);
  if (x.length < 2 || y.length < 2) return false;
  return x === y || x.startsWith(y + " ") || y.startsWith(x + " ");
}
export function workedAt(employers: unknown[], company: unknown): boolean {
  return employers.some((e) => String(e || "").split(/[,/;]| and /i).some((part) => sameCompany(part, company)) || sameCompany(e, company));
}
// Every employer we know a Pronext candidate has had: current employer plus the employers looked
// up from their resume.
export const candEmployers = (c: any): string[] =>
  [c.current_company, ...(Array.isArray(c.industries) ? c.industries.map((x: any) => x?.company) : [])].filter(Boolean).map(String);
// Employers in an Apollo profile's history line ("Title at Company (2019-01 to now); ...").
export const historyEmployers = (h: string): string[] => [...String(h || "").matchAll(/ at (.+?) \(/g)].map((m) => m[1]);

// The job description as an outside candidate may see it: the client's name taken out.
export function anonymizeJd(desc: unknown, client: unknown): string {
  let t = String(desc || "").trim();
  const name = String(client || "").trim();
  if (name.length >= 2) t = t.replace(new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "('s)?\\b", "gi"), (_m: string, poss?: string) => (poss ? "our client's" : "our client"));
  return t;
}

// Fit is always a percentage. If the AI answered a whole batch on a 0-10 scale (every score 10 or
// less), scale it up so 8 becomes 80%, not 8%.
export function fitsToPercent(results: any[]): any[] {
  const vals = results.map((r) => Number(r?.fit)).filter((n) => Number.isFinite(n) && n > 0);
  const tenScale = vals.length > 0 && vals.every((n) => n <= 10);
  return results.map((r) => ({ ...r, fit: Math.max(0, Math.min(100, Math.round((Number(r?.fit) || 0) * (tenScale ? 10 : 1)))) }));
}
