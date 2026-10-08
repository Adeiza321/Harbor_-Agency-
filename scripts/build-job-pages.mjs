// Builds the public site for GitHub Pages, with a real page for every open job so Google can
// crawl them and show them in Google for Jobs.
//
//   node scripts/build-job-pages.mjs [outDir=_site]
//
// Writes:
//   index.html, 404.html, CNAME      the app (404.html lets any /jobs/... address open the app)
//   assets/                           its CSS, scripts and icon
//   jobs/index.html                   the jobs board, with every job linked in the page itself
//   jobs/<code>/index.html            one per open job: title, description, canonical link,
//                                     social preview tags and JobPosting structured data
//   sitemap.xml, robots.txt           so search engines find every job page
//
// Run by .github/workflows/pages.yml on every push and every hour, so new, edited and closed
// jobs reach Google within the hour. Needs no secrets: it reads the same public list as the
// jobs board (public_jobs(), client names already removed) with the app's public key.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] || "_site";
const app = readFileSync("app.jsx", "utf8");
const SB_URL = app.match(/const SB_URL = "([^"]+)"/)[1];
const SB_KEY = app.match(/const SB_KEY = "([^"]+)"/)[1];
const domain = existsSync("CNAME") ? readFileSync("CNAME", "utf8").trim() : "";
const SITE = (process.env.SITE_URL || (domain ? "https://" + domain : "")).replace(/\/+$/, "");
if (!SITE) throw new Error("No site address: add a CNAME file or set SITE_URL");
const shell = readFileSync("index.html", "utf8");

// JOBS_FILE=some.json uses a saved copy of the list instead (for trying the build offline).
let data;
if (process.env.JOBS_FILE) data = JSON.parse(readFileSync(process.env.JOBS_FILE, "utf8"));
else {
  const res = await fetch(SB_URL + "/rest/v1/rpc/public_jobs", {
    method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, body: "{}",
  });
  if (!res.ok) throw new Error("Couldn't load jobs: " + res.status + " " + (await res.text()).slice(0, 200));
  data = await res.json();
}
const jobs = Array.isArray(data.jobs) ? data.jobs : [];
const org = { name: data.legalName || data.agency || "Pronext", short: data.agency || "Pronext", logo: data.logoUrl || "", website: data.website || SITE };

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const jsonLd = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
const jobUrl = (slug) => `${SITE}/jobs/${encodeURIComponent(slug)}/`;
const day = (iso) => new Date(iso || Date.now()).toISOString().slice(0, 10);
const PER = { Yearly: "a year", Monthly: "a month", Weekly: "a week", Daily: "a day", Hourly: "an hour" };
const UNIT = { Yearly: "YEAR", Monthly: "MONTH", Weekly: "WEEK", Daily: "DAY", Hourly: "HOUR" };
const money = (n, cur) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n); } catch { return String(n); } };
function payText(p) {
  if (!p) return "";
  const nums = [p.min, p.max].filter((n) => n != null);
  const range = nums.length === 2 && Number(nums[0]) === Number(nums[1]) ? money(nums[0], p.currency) : nums.map((n) => money(n, p.currency)).join(" – ");
  return range + (PER[p.period] ? " " + PER[p.period] : "");
}
const EMP = { "full-time": "FULL_TIME", "full time": "FULL_TIME", "part-time": "PART_TIME", "part time": "PART_TIME", contract: "CONTRACTOR", contractor: "CONTRACTOR", temporary: "TEMPORARY", temp: "TEMPORARY", internship: "INTERN", intern: "INTERN", "per diem": "PER_DIEM", volunteer: "VOLUNTEER" };
const COUNTRY = { "united states": "US", usa: "US", "united kingdom": "GB", uk: "GB", nigeria: "NG", canada: "CA", malaysia: "MY", ireland: "IE", germany: "DE", france: "FR", netherlands: "NL", spain: "ES", "united arab emirates": "AE", "south africa": "ZA", kenya: "KE", ghana: "GH", india: "IN", australia: "AU", singapore: "SG" };
const countryCode = (c) => { const s = String(c || "").trim(); return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : COUNTRY[s.toLowerCase()] || s; };
const US_STATES = "Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada Ohio Oklahoma Oregon Pennsylvania Tennessee Texas Utah Vermont Virginia Washington Wisconsin Wyoming".split(" ")
  .concat(["New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Rhode Island", "South Carolina", "South Dakota", "West Virginia", "District of Columbia"]);
const isState = (s) => /^[A-Z]{2}$/.test(s) || US_STATES.some((x) => x.toLowerCase() === s.toLowerCase());
// "Battleground, WA 98604" -> { locality, region, postalCode }
function parseLocation(loc) {
  const parts = String(loc || "").split(",").map((x) => x.trim()).filter(Boolean);
  const out = {};
  if (!parts.length) return out;
  let last = parts[parts.length - 1];
  const zip = last.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zip) { out.postalCode = zip[1]; last = last.replace(zip[0], "").trim(); parts[parts.length - 1] = last; }
  if (parts.length === 1) { if (isState(parts[0])) out.addressRegion = parts[0]; else if (parts[0]) out.addressLocality = parts[0]; return out; }
  out.addressLocality = parts[0];
  if (parts[1]) out.addressRegion = parts[1];
  return out;
}
// Google asks for the plain job title: no location or "(Remote)" in brackets.
const cleanTitle = (t) => {
  const s = String(t || "").trim();
  const m = s.match(/^(.*\S)\s*\(([^)]*)\)\s*$/);
  if (!m) return s;
  const inner = m[2];
  return /remote|hybrid|on-?site|in-?office|,|opening/i.test(inner) || isState(inner.trim()) ? m[1] : s;
};

const BULLET = /^\s*(?:[•●▪◦*\-–]|\d+[.)])\s+/;
function descHtml(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let html = "", list = [], para = [];
  const flushP = () => { if (para.length) { html += `<p>${esc(para.join(" "))}</p>`; para = []; } };
  const flushL = () => { if (list.length) { html += `<ul>${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`; list = []; } };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { flushP(); flushL(); return; }
    if (BULLET.test(line)) { flushP(); list.push(line.replace(BULLET, "")); return; }
    const next = (lines.slice(i + 1).find((l) => l.trim()) || "").trim();
    const heading = line.length <= 60 && !/[.!?,;]$/.test(line) && (line.endsWith(":") || BULLET.test(next) || !next || (/^[A-Z]/.test(line) && line.split(" ").length <= 6));
    if (heading) { flushP(); flushL(); html += `<h3>${esc(line.replace(/:$/, ""))}</h3>`; return; }
    flushL(); para.push(line);
  });
  flushP(); flushL();
  return html;
}
const snippet = (j) => String(j.metaDescription || j.summary || "").replace(/\s+/g, " ").trim().slice(0, 158);

function posting(j) {
  const remote = /remote/i.test(j.workSetup || "") || /\bremote\b/i.test(j.title || "") && !j.location;
  const country = countryCode(j.country) || "US";
  const o = {
    "@context": "https://schema.org/", "@type": "JobPosting",
    title: cleanTitle(j.title),
    description: descHtml(j.description) || `<p>${esc(j.title)}</p>`,
    identifier: { "@type": "PropertyValue", name: org.name, value: j.slug },
    datePosted: day(j.postedAt),
    // Pages are rebuilt every hour and a closed job's page is removed, so this always stays ahead.
    validThrough: new Date(Date.now() + 45 * 864e5).toISOString(),
    hiringOrganization: { "@type": "Organization", name: org.name, sameAs: org.website, ...(org.logo ? { logo: org.logo } : {}) },
    directApply: true,
    url: jobUrl(j.slug),
  };
  const emp = EMP[String(j.employmentType || "").toLowerCase()];
  if (emp) o.employmentType = emp;
  if (j.headcount > 1) o.totalJobOpenings = j.headcount;
  if (remote) {
    o.jobLocationType = "TELECOMMUTE";
    o.applicantLocationRequirements = { "@type": "Country", name: country };
  }
  if (!remote || j.location) {
    const a = parseLocation(j.location);
    o.jobLocation = { "@type": "Place", address: { "@type": "PostalAddress", ...a, addressCountry: country } };
  }
  if (j.pay && (j.pay.min != null || j.pay.max != null)) {
    const v = { "@type": "QuantitativeValue", unitText: UNIT[j.pay.period] || "YEAR" };
    if (j.pay.min != null && j.pay.max != null && Number(j.pay.min) !== Number(j.pay.max)) { v.minValue = Number(j.pay.min); v.maxValue = Number(j.pay.max); }
    else v.value = Number(j.pay.min ?? j.pay.max);
    o.baseSalary = { "@type": "MonetaryAmount", currency: j.pay.currency || "USD", value: v };
  }
  return o;
}

// The app's own page with this page's title, description, link tags and content filled in.
// The content inside #root is what crawlers without JavaScript read; the app replaces it on load.
function page({ title, description, canonical, head = "", body }) {
  const tags = `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta name="robots" content="index,follow" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${esc(org.short)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
${org.logo ? `<meta property="og:image" content="${esc(org.logo)}" />\n` : ""}<meta name="twitter:card" content="summary" />
${head}`;
  if (!shell.includes("<title>ProNext</title>") || !shell.includes('<div id="root"></div>')) throw new Error("index.html doesn't have the expected <title> and #root");
  return shell.replace("<title>ProNext</title>", () => tags).replace('<div id="root"></div>', () => `<div id="root">${body}</div>`);
}

const jobBody = (j) => `<main style="max-width:720px;margin:0 auto;padding:24px;font-family:system-ui,sans-serif">
<p><a href="${SITE}/jobs/">All jobs</a></p>
<h1>${esc(j.title)}</h1>
<p>${esc([org.name, j.location || j.country, j.workSetup, j.employmentType, payText(j.pay)].filter(Boolean).join(" · "))}</p>
<p><a href="${jobUrl(j.slug)}?go=apply">Apply now</a> · <a href="${jobUrl(j.slug)}?refer=1">Refer someone</a></p>
<article>${descHtml(j.description)}</article>
</main>`;

// ---------- write ----------
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "jobs"), { recursive: true });
writeFileSync(join(OUT, "index.html"), shell);
writeFileSync(join(OUT, "404.html"), shell);
// The app's styles, scripts and icon (built by scripts/build-app.mjs).
if (existsSync("assets")) cpSync("assets", join(OUT, "assets"), { recursive: true });
if (domain) writeFileSync(join(OUT, "CNAME"), domain + "\n");

for (const j of jobs) {
  const dir = join(OUT, "jobs", j.slug);
  mkdirSync(dir, { recursive: true });
  const place = j.location || (j.workSetup && /remote/i.test(j.workSetup) ? "Remote" : j.country) || "";
  writeFileSync(join(dir, "index.html"), page({
    title: `${j.title}${place && !String(j.title).includes(place) ? " – " + place : ""} | ${org.short} Jobs`,
    description: snippet(j) || `${j.title} – apply with ${org.short}.`,
    canonical: jobUrl(j.slug),
    head: `<script type="application/ld+json">${jsonLd(posting(j))}</script>\n`,
    body: jobBody(j),
  }));
}

const boardList = {
  "@context": "https://schema.org", "@type": "ItemList",
  itemListElement: jobs.map((j, i) => ({ "@type": "ListItem", position: i + 1, url: jobUrl(j.slug), name: j.title })),
};
writeFileSync(join(OUT, "jobs", "index.html"), page({
  title: `Jobs at ${org.short} – ${jobs.length} open ${jobs.length === 1 ? "role" : "roles"}`,
  description: `Browse ${jobs.length} open ${jobs.length === 1 ? "role" : "roles"} recruited by ${org.name}. Apply in about two minutes, or refer someone you know.`,
  canonical: `${SITE}/jobs/`,
  head: `<script type="application/ld+json">${jsonLd(boardList)}</script>\n`,
  body: `<main style="max-width:720px;margin:0 auto;padding:24px;font-family:system-ui,sans-serif"><h1>Jobs at ${esc(org.short)}</h1><ul>${jobs.map((j) =>
    `<li><a href="${jobUrl(j.slug)}">${esc(j.title)}</a> – ${esc([j.location || j.country, j.workSetup, j.employmentType].filter(Boolean).join(" · "))}</li>`).join("")}</ul></main>`,
}));

const urls = [{ loc: `${SITE}/jobs/`, lastmod: day(jobs[0]?.postedAt) }, ...jobs.map((j) => ({ loc: jobUrl(j.slug), lastmod: day(j.postedAt) }))];
writeFileSync(join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join("\n")}
</urlset>
`);
writeFileSync(join(OUT, "robots.txt"), `User-agent: *
Allow: /jobs/
Disallow: /?
Allow: /$

Sitemap: ${SITE}/sitemap.xml
`);
console.log(`Built ${jobs.length} job pages for ${SITE} into ${OUT}/`);
