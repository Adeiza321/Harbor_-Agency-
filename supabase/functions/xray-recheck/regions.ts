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
// Every other country, so a job anywhere can be sourced in its own country (same list as the app).
const WORLD: Record<string, string> = { AD: "Andorra", AE: "United Arab Emirates", AF: "Afghanistan", AG: "Antigua and Barbuda", AL: "Albania", AM: "Armenia", AO: "Angola", AR: "Argentina", AT: "Austria", AU: "Australia", AW: "Aruba", AZ: "Azerbaijan", BA: "Bosnia and Herzegovina", BB: "Barbados", BD: "Bangladesh", BE: "Belgium", BF: "Burkina Faso", BG: "Bulgaria", BH: "Bahrain", BI: "Burundi", BJ: "Benin", BM: "Bermuda", BN: "Brunei", BO: "Bolivia", BR: "Brazil", BS: "Bahamas", BT: "Bhutan", BW: "Botswana", BY: "Belarus", BZ: "Belize", CA: "Canada", CD: "Congo (DRC)", CF: "Central African Republic", CG: "Congo (Republic)", CH: "Switzerland", CI: "Côte d'Ivoire", CL: "Chile", CM: "Cameroon", CN: "China", CO: "Colombia", CR: "Costa Rica", CU: "Cuba", CV: "Cape Verde", CW: "Curaçao", CY: "Cyprus", CZ: "Czechia", DE: "Germany", DJ: "Djibouti", DK: "Denmark", DM: "Dominica", DO: "Dominican Republic", DZ: "Algeria", EC: "Ecuador", EE: "Estonia", EG: "Egypt", ER: "Eritrea", ES: "Spain", ET: "Ethiopia", FI: "Finland", FJ: "Fiji", FM: "Micronesia", FO: "Faroe Islands", FR: "France", GA: "Gabon", GB: "United Kingdom", GD: "Grenada", GE: "Georgia", GF: "French Guiana", GG: "Guernsey", GH: "Ghana", GI: "Gibraltar", GL: "Greenland", GM: "Gambia", GN: "Guinea", GP: "Guadeloupe", GQ: "Equatorial Guinea", GR: "Greece", GT: "Guatemala", GU: "Guam", GW: "Guinea-Bissau", GY: "Guyana", HK: "Hong Kong", HN: "Honduras", HR: "Croatia", HT: "Haiti", HU: "Hungary", ID: "Indonesia", IE: "Ireland", IL: "Israel", IM: "Isle of Man", IN: "India", IQ: "Iraq", IR: "Iran", IS: "Iceland", IT: "Italy", JE: "Jersey", JM: "Jamaica", JO: "Jordan", JP: "Japan", KE: "Kenya", KG: "Kyrgyzstan", KH: "Cambodia", KI: "Kiribati", KM: "Comoros", KN: "Saint Kitts and Nevis", KP: "North Korea", KR: "South Korea", KW: "Kuwait", KY: "Cayman Islands", KZ: "Kazakhstan", LA: "Laos", LB: "Lebanon", LC: "Saint Lucia", LI: "Liechtenstein", LK: "Sri Lanka", LR: "Liberia", LS: "Lesotho", LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", LY: "Libya", MA: "Morocco", MC: "Monaco", MD: "Moldova", ME: "Montenegro", MG: "Madagascar", MH: "Marshall Islands", MK: "North Macedonia", ML: "Mali", MM: "Myanmar", MN: "Mongolia", MO: "Macao", MQ: "Martinique", MR: "Mauritania", MT: "Malta", MU: "Mauritius", MV: "Maldives", MW: "Malawi", MX: "Mexico", MY: "Malaysia", MZ: "Mozambique", NA: "Namibia", NC: "New Caledonia", NE: "Niger", NG: "Nigeria", NI: "Nicaragua", NL: "Netherlands", NO: "Norway", NP: "Nepal", NR: "Nauru", NZ: "New Zealand", OM: "Oman", PA: "Panama", PE: "Peru", PF: "French Polynesia", PG: "Papua New Guinea", PH: "Philippines", PK: "Pakistan", PL: "Poland", PR: "Puerto Rico", PS: "Palestine", PT: "Portugal", PW: "Palau", PY: "Paraguay", QA: "Qatar", RE: "Réunion", RO: "Romania", RS: "Serbia", RU: "Russia", RW: "Rwanda", SA: "Saudi Arabia", SB: "Solomon Islands", SC: "Seychelles", SD: "Sudan", SE: "Sweden", SG: "Singapore", SI: "Slovenia", SK: "Slovakia", SL: "Sierra Leone", SM: "San Marino", SN: "Senegal", SO: "Somalia", SR: "Suriname", SS: "South Sudan", ST: "São Tomé and Príncipe", SV: "El Salvador", SY: "Syria", SZ: "Eswatini", TD: "Chad", TG: "Togo", TH: "Thailand", TJ: "Tajikistan", TL: "Timor-Leste", TM: "Turkmenistan", TN: "Tunisia", TO: "Tonga", TR: "Türkiye", TT: "Trinidad and Tobago", TV: "Tuvalu", TW: "Taiwan", TZ: "Tanzania", UA: "Ukraine", UG: "Uganda", US: "United States", UY: "Uruguay", UZ: "Uzbekistan", VA: "Vatican City", VC: "Saint Vincent and the Grenadines", VE: "Venezuela", VG: "British Virgin Islands", VI: "US Virgin Islands", VN: "Vietnam", VU: "Vanuatu", WS: "Samoa", XK: "Kosovo", YE: "Yemen", YT: "Mayotte", ZA: "South Africa", ZM: "Zambia", ZW: "Zimbabwe" };
export const COUNTRY_NAMES: Record<string, string> = { ...WORLD, ...EU, ...OTHERS };

export const REGION_CODES: Record<Region, string[]> = { US: ["US"], EU: Object.keys(EU), MY: ["MY"], OTHER: [] };

const NAME_TO_CODE: Record<string, string> = Object.fromEntries(Object.entries(COUNTRY_NAMES).map(([c, n]) => [n.toLowerCase(), c]));
NAME_TO_CODE["usa"] = "US"; NAME_TO_CODE["united states of america"] = "US"; NAME_TO_CODE["uk"] = "GB";
NAME_TO_CODE["england"] = "GB"; NAME_TO_CODE["scotland"] = "GB"; NAME_TO_CODE["wales"] = "GB"; NAME_TO_CODE["the netherlands"] = "NL";
for (const [c, n] of Object.entries(WORLD)) NAME_TO_CODE[n.toLowerCase()] = NAME_TO_CODE[n.toLowerCase()] || c;
Object.assign(NAME_TO_CODE, { "czechia": "CZ", "turkey": "TR", "türkiye": "TR", "ivory coast": "CI", "côte d'ivoire": "CI", "south korea": "KR", "korea": "KR",
  "uae": "AE", "russia": "RU", "vietnam": "VN", "burma": "MM", "hong kong": "HK", "macau": "MO", "great britain": "GB", "britain": "GB" });

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

// Where to look for new clients (Outreach > Setup): "EU" for all of Europe, or any country code
// ("US", "MY", "NG"…). Only client leads use this; outside candidates are searched where the job is.
export function targetCodes(regions: unknown): string[] {
  const list = Array.isArray(regions) && regions.length ? regions : ["US", "EU", "MY"];
  return [...new Set(list.flatMap((r) => { const k = String(r).trim().toUpperCase(); return k === "EU" ? REGION_CODES.EU : COUNTRY_NAMES[k] ? [k] : []; }))];
}

// The country to search in for a job's outside candidates: its own country, nothing else.
export function jobCountryNames(job: any): string[] {
  const c = jobCountryCode(job);
  return c && COUNTRY_NAMES[c] ? [COUNTRY_NAMES[c]] : [];
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
        ? `Why you're getting this: we found your professional profile and contact details in a contact database, and they match this role. We use only your name, job title and email address, only to tell you about roles like this, and delete them if you're not interested. To have your details deleted now: ${f.deleteUrl}`
        : `Why you're getting this: your company advertised this role publicly and we have a matching candidate. We use only your name, role and work email, only for this purpose. To have your details deleted: ${f.deleteUrl}`);
  }
  lines.push(`Not interested? Unsubscribe: ${f.unsubUrl}`);
  return lines.join("\n");
}
