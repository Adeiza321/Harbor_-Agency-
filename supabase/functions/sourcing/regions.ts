// Target markets and what each one needs in an outreach email.
//   US  - CAN-SPAM: truthful sender, business postal address, working unsubscribe.
//   EU  - GDPR (incl. UK/EEA/CH): also tell people where we got their details, why, and how
//         to object or have them deleted (Art. 14 notice); keep data only as long as needed.
//   MY  - Malaysia PDPA: notice of the source and purpose, and a way to opt out / correct.
// This is general guidance built into the templates, not legal advice.

export type Region = "US" | "EU" | "MY" | "OTHER";

const EU: Record<string, string> = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", HR: "Croatia", CY: "Cyprus", CZ: "Czech Republic", DK: "Denmark",
  EE: "Estonia", FI: "Finland", FR: "France", DE: "Germany", GR: "Greece", HU: "Hungary", IE: "Ireland", IT: "Italy",
  LV: "Latvia", LT: "Lithuania", LU: "Luxembourg", MT: "Malta", NL: "Netherlands", PL: "Poland", PT: "Portugal",
  RO: "Romania", SK: "Slovakia", SI: "Slovenia", ES: "Spain", SE: "Sweden",
  GB: "United Kingdom", NO: "Norway", CH: "Switzerland", IS: "Iceland", LI: "Liechtenstein",
};
const OTHERS: Record<string, string> = { US: "United States", MY: "Malaysia" };
export const COUNTRY_NAMES: Record<string, string> = { ...EU, ...OTHERS };

export const REGION_CODES: Record<Region, string[]> = { US: ["US"], EU: Object.keys(EU), MY: ["MY"], OTHER: [] };

const NAME_TO_CODE: Record<string, string> = Object.fromEntries(Object.entries(COUNTRY_NAMES).map(([c, n]) => [n.toLowerCase(), c]));
NAME_TO_CODE["usa"] = "US"; NAME_TO_CODE["united states of america"] = "US"; NAME_TO_CODE["uk"] = "GB";
NAME_TO_CODE["england"] = "GB"; NAME_TO_CODE["scotland"] = "GB"; NAME_TO_CODE["wales"] = "GB"; NAME_TO_CODE["the netherlands"] = "NL";

export function countryCode(v: unknown): string {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return NAME_TO_CODE[s.toLowerCase()] || "";
}

export function regionOf(code: string): Region {
  const c = (code || "").toUpperCase();
  if (c === "US") return "US";
  if (c === "MY") return "MY";
  if (EU[c]) return "EU";
  return "OTHER";
}

// Settings list regions ("US", "EU", "MY"); expand to ISO codes.
export function targetCodes(regions: unknown): string[] {
  const list = Array.isArray(regions) && regions.length ? regions : ["US", "EU", "MY"];
  return [...new Set(list.flatMap((r) => REGION_CODES[String(r).toUpperCase() as Region] || []))];
}

// A job's location as a country code: from jobs.country, or the end of jobs.location.
const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
export function jobCountryCode(job: any): string {
  const c = countryCode(job?.country);
  if (c) return c;
  const loc = String(job?.location || "");
  const last = loc.split(",").map((x) => x.trim()).filter(Boolean).pop() || "";
  if (US_STATES.has(last.toUpperCase())) return "US";
  return countryCode(last);
}

export type Footer = { senderName: string; agencyName: string; businessAddress: string; unsubUrl: string; deleteUrl: string };

// Text added under every outreach email, by region.
export function footerText(region: Region, f: Footer, kind: "candidate" | "client"): string {
  const lines = ["", "--", `${f.senderName}${f.agencyName ? ", " + f.agencyName : ""}`];
  if (f.businessAddress) lines.push(f.businessAddress);
  if (region !== "US") {
    lines.push("",
      kind === "candidate"
        ? `Why you're getting this: we found your work profile in Apollo.io, a business contact database, and it matches this role. We use only your name, job title and work email, only to tell you about roles like this, and delete them if you're not interested. To have your details deleted now: ${f.deleteUrl}`
        : `Why you're getting this: your company advertised this role publicly and we have a matching candidate. We use only your name, role and work email, only for this purpose. To have your details deleted: ${f.deleteUrl}`);
  }
  lines.push(`Not interested? Unsubscribe: ${f.unsubUrl}`);
  return lines.join("\n");
}
