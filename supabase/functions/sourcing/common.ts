// Shared pieces: settings with defaults, title matching (same rules as ai-screen's bench
// check), busy candidates, and anonymous candidate summaries for client pitches.

export type Settings = {
  approval: "manual" | "auto";        // manual: a person approves each email before it is sent
  regions: string[];                   // "US", "EU", "MY"
  minInternalFits: number;             // search outside Harbor only when fewer good fits than this
  prospectsPerJob: number;             // most emails revealed (Apollo credits) per job
  dailyCap: number;                    // most outreach emails sent per day
  senderName: string; senderTitle: string; businessAddress: string;
  includePay: boolean;                 // mention the pay range in candidate outreach
  leads: { enabled: boolean; postingsPerDay: number; maxAgeDays: number };
  retentionDays: number;               // delete prospects nobody engaged with after this long
};

export async function loadSettings(admin: any): Promise<{ s: Settings; agencyName: string }> {
  const { data } = await admin.from("agency_settings").select("agency_name,company,outreach").limit(1).maybeSingle();
  const o = (data?.outreach && typeof data.outreach === "object") ? data.outreach : {};
  const company = (data?.company && typeof data.company === "object") ? data.company : {};
  const num = (v: unknown, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : d; };
  const addr = String(o.businessAddress || company.address || "").trim();
  return {
    agencyName: String(data?.agency_name || company.name || "").trim(),
    s: {
      approval: o.approval === "auto" ? "auto" : "manual",
      regions: Array.isArray(o.regions) && o.regions.length ? o.regions : ["US", "EU", "MY"],
      minInternalFits: num(o.minInternalFits, 3, 0, 50),
      prospectsPerJob: num(o.prospectsPerJob, 20, 1, 100),
      dailyCap: num(o.dailyCap, 40, 1, 1000),
      senderName: String(o.senderName || "").trim(),
      senderTitle: String(o.senderTitle || "").trim(),
      businessAddress: addr,
      includePay: o.includePay !== false,
      leads: {
        enabled: !!o.leads?.enabled,
        postingsPerDay: num(o.leads?.postingsPerDay, 25, 1, 100),
        maxAgeDays: num(o.leads?.maxAgeDays, 1, 1, 14),
      },
      retentionDays: num(o.retentionDays, 90, 14, 365),
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
