// The first email to an outside candidate, in the same branded design as Pronext's other
// candidate emails: a short personal note (written by Claude when the prospect was found), a
// role overview (title, location, work setup, pay), the must-have requirements only, and two
// buttons: "I'm interested" (the job's apply form) and "Refer someone" (the referral form).
// The client is never named. Must-haves are picked by Claude once per job and kept on the job
// (jobs.outreach_brief) until the description changes.

import { askAI } from "./ai.ts";
import { anonymizeJd } from "./common.ts";
import { button, emailShell, esc, type Brand } from "./brand.ts";
import type { Region } from "./regions.ts";

export type MustHaves = { key: string; summary: string; items: string[] };

async function hashOf(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mustHavesFor(admin: any, job: any): Promise<MustHaves | null> {
  if (!job?.id || String(job.description || "").trim().length < 80) return null;
  const key = await hashOf(JSON.stringify(["v2", job.role_title, job.description, job.client]));
  const c = job.outreach_brief;
  if (c?.key === key && Array.isArray(c.items) && c.items.length) return c;
  try {
    const sys = "You turn job descriptions into a short candidate-facing overview. Reply with STRICT JSON only: {\"summary\": string, \"items\": string[]}. " +
      "summary: ONE plain sentence (under 30 words) on what the person will do in the role. " +
      "items: ONLY the essential requirements a candidate must already have (experience, skills, qualifications, licences, location or work-rights rules), " +
      "4 to 6 items, each under 15 words, most important first. Leave out nice-to-haves, 'preferred' or 'bonus' items, benefits, perks and company blurb. " +
      "Never name the hiring company: call it 'our client' if you must refer to it. Don't invent anything that isn't in the description.";
    const text = `Job title: ${job.role_title}\nLocation: ${job.location || "?"}${job.work_setup ? " (" + job.work_setup + ")" : ""}\n\nDescription:\n${anonymizeJd(job.description, job.client).slice(0, 7000)}`;
    const r = await askAI(sys, text, 2000);
    const items = (Array.isArray(r?.items) ? r.items : []).map((x: unknown) => anonymizeJd(String(x || "").trim(), job.client)).filter(Boolean).slice(0, 8);
    if (!items.length) return null;
    const out: MustHaves = { key, summary: anonymizeJd(String(r?.summary || "").trim(), job.client).slice(0, 300), items };
    await admin.from("jobs").update({ outreach_brief: { ...out, at: new Date().toISOString() } }).eq("id", job.id);
    return out;
  } catch (e) {
    console.error("must-haves", job.id, String((e as Error)?.message || e));
    return null;
  }
}

const PER: Record<string, string> = { Yearly: "a year", Monthly: "a month", Weekly: "a week", Daily: "a day", Hourly: "an hour" };
export function payText(job: any, includePay: boolean) {
  if (!includePay || job.commission_only || !(job.min_pay || job.max_pay)) return "";
  const money = (n: unknown) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: job.currency || "USD", maximumFractionDigits: 0 }).format(Number(n)); } catch { return String(n); } };
  const nums = [job.min_pay, job.max_pay].filter((n) => n != null && n !== "" && Number(n));
  const range = nums.length === 2 && Number(nums[0]) === Number(nums[1]) ? money(nums[0]) : nums.map(money).join(" – ");
  return range + (PER[job.salary_period || "Yearly"] ? " " + PER[job.salary_period || "Yearly"] : "");
}

// The personal part of a drafted email: its paragraphs before any pasted job description and
// "click here" line (older drafts had both), and the sign-off name.
export function introOf(body: string): { paragraphs: string[]; signoff: string } {
  const lines = String(body || "").replace(/\r/g, "").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let signoff = "";
  const last = (lines[lines.length - 1] || "").trim();
  if (last && last.length <= 40 && !/https?:|\{\{/.test(last)) { signoff = last; lines.pop(); }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const prev = (lines[lines.length - 1] || "").trim();
  if (signoff && prev && prev.length <= 30 && /,$/.test(prev)) lines.pop();
  let text = lines.join("\n");
  const cut = text.search(/^\s*(here'?s the full job description|here is the full job description)/im);
  if (cut >= 0) text = text.slice(0, cut);
  text = text.split("\n").filter((l) => !/\{\{(INTERESTED_LINK|JOB_DESCRIPTION|JOB_LINK)\}\}/.test(l) && !/^\s*if it feels like a good fit/i.test(l)).join("\n");
  // Line breaks inside a paragraph become spaces, except before a list item ("- ..."), which keeps its own line.
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*(?![-•*]\s)/g, " ").replace(/\s*\n\s*(?=[-•*]\s)/g, "\n").trim()).filter(Boolean);
  return { paragraphs, signoff };
}

export type CandidateMail = {
  brand: Brand; region: Region; paragraphs: string[]; signoff: string;
  senderName: string; senderTitle: string; agency: string; address: string;
  role: { title: string; location: string; workSetup: string; employmentType: string; pay: string };
  summary: string; mustHaves: string[];
  applyUrl: string; referUrl: string; unsubUrl: string; deleteUrl: string;
  source?: string;                     // where their details came from, for the privacy notice
};

// Where a prospect's details came from, in words for the privacy notice (GDPR Art. 14).
export function sourceText(p: any): string {
  const src = String(p?.data?.email_source || "");
  const site = p?.source === "github" ? "GitHub" : "LinkedIn";
  if (/contactout/i.test(src)) return `your public ${site} profile, with your contact details from ContactOut, a contact database`;
  if (/apollo/i.test(src) && p?.data?.xray) return `your public ${site} profile, with your contact details from Apollo.io, a business contact database`;
  if (/github/i.test(src)) return "your public GitHub profile";
  return "your work profile in Apollo.io, a business contact database";
}

// The same, in a few words, for the one-line footer of template emails.
export function sourceShort(p: any): string {
  const src = String(p?.data?.email_source || "");
  const site = p?.source === "github" ? "GitHub" : p?.source === "apollo" ? "" : "LinkedIn";
  const via = /contactout/i.test(src) ? "ContactOut" : /apollo/i.test(src) || p?.source === "apollo" ? "Apollo.io" : /pdl|people data/i.test(src) || p?.source === "pdl" ? "People Data Labs" : "";
  if (site && via) return `your public ${site} profile, with contact details from ${via}`;
  if (site) return `your public ${site} profile`;
  return via ? `${via}, a business contact database` : "a business contact database";
}

// The one "why you're getting this" line every candidate outreach email carries (template emails
// and the older note-style ones alike), so the footer reads the same for everyone.
export function candidateWhy(region: Region, source: string) {
  const where = source || "your work profile in Apollo.io, a business contact database";
  return region !== "US"
    ? `Why you're getting this: we found ${where}, and it matches this role. We use only your name, job title and email address, only to tell you about roles like this, and delete them if you're not interested.`
    : `We found ${where}, and it matches this role.`;
}

export function candidateEmail(m: CandidateMail): { text: string; html: string } {
  const b = m.brand;
  const meta = [m.role.location, m.role.workSetup, m.role.employmentType].filter(Boolean)
    .filter((v, i, a) => i === 0 || !String(a[0]).toLowerCase().includes(String(v).toLowerCase()));
  const signName = m.signoff || m.senderName.split(" ")[0] || "";
  const why = candidateWhy(m.region, m.source || "");

  // ---- plain text ----
  const t: string[] = [m.paragraphs.join("\n\n"), ""];
  t.push("THE ROLE", m.role.title);
  if (meta.length) t.push(meta.join(" · "));
  if (m.role.pay) t.push("Pay: " + m.role.pay);
  if (m.summary) t.push("", m.summary);
  if (m.mustHaves.length) t.push("", "Must-have requirements:", ...m.mustHaves.map((x) => "• " + x));
  t.push("", "I'm interested (apply in about two minutes): " + m.applyUrl, "Know someone who'd fit? Refer them: " + m.referUrl, "", signName);
  t.push("", "--", [m.senderName, m.senderTitle].filter(Boolean).join(", ") + (m.agency ? ", " + m.agency : ""));
  if (m.address) t.push(m.address);
  t.push("", why + " Delete my details: " + m.deleteUrl, "Not interested? Unsubscribe: " + m.unsubUrl);
  const text = t.join("\n").replace(/\n{3,}/g, "\n\n");

  // ---- HTML: the same design as every other ProNext candidate email (brand.ts emailShell) ----
  const html = emailShell(b, m.role.title + (meta.length ? " · " + meta.join(" · ") : ""),
    noteHtml(b, m.paragraphs) +
    `<div style="margin-top:16px;padding:14px 16px;background:#F3EFE7;border-radius:10px;">
<div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:.06em;color:#56605A;margin-bottom:6px;">THE ROLE</div>
<div style="font-size:17px;line-height:1.35;">${esc(m.role.title)}</div>
${meta.length ? `<div style="font-family:Arial,sans-serif;font-size:13px;color:#56605A;line-height:1.5;margin-top:4px;">${meta.map((x) => esc(x)).join(" &middot; ")}</div>` : ""}
${m.role.pay ? `<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;margin-top:2px;"><b>Pay:</b> ${esc(m.role.pay)}</div>` : ""}
${m.summary ? `<div style="font-size:14px;line-height:1.55;margin-top:8px;">${esc(m.summary)}</div>` : ""}
</div>
${m.mustHaves.length ? `<div style="font-size:15px;margin-top:16px;margin-bottom:6px;">Must-have requirements</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">${m.mustHaves.map((x) =>
      `<tr><td valign="top" style="padding:0 8px 5px 0;font-size:14px;line-height:1.55;color:${b.color};">&#10003;</td><td valign="top" style="padding:0 0 5px;font-size:14px;line-height:1.55;">${esc(x)}</td></tr>`).join("")}</table>` : ""}
${button(b, m.applyUrl, "I'm interested")}
<div style="font-size:14px;line-height:1.6;margin-top:16px;color:#56605A;">Not quite right for you? If you know someone who'd be great, <a href="${esc(m.referUrl)}" style="color:${b.color};">refer them here</a>.</div>
${signHtml(signName, m.senderTitle, m.agency)}`,
    undefined, undefined,
    footerHtml(b, { sender: [m.senderName, m.senderTitle].filter(Boolean).join(", "), agency: m.agency, address: m.address,
      why, unsubUrl: m.unsubUrl, deleteUrl: m.deleteUrl }));
  return { text, html };
}

// A first email written from the job's outreach template (template.ts): the agency's own words,
// with "- " lines as a list, **bold** kept, and {{APPLY_LINK}} as the tracked apply link (a button
// too). No role box or must-haves underneath: the template already carries them. Same footer.
export function templateEmail(m: { brand: Brand; region: Region; text: string; signoff: string; senderName: string; senderTitle: string; agency: string; address: string; applyUrl: string; referUrl?: string; unsubUrl: string; deleteUrl: string; source?: string; subject: string }): { text: string; html: string } {
  const b = m.brand;
  const signName = m.signoff || m.senderName.split(" ")[0] || "";
  const plain = m.text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\{\{APPLY_LINK\}\}/g, m.applyUrl);
  // Footer: the business address; where we found their details, with unsubscribe and delete links; the copyright line.
  const t = [plain, ...(m.referUrl ? ["", "Not quite right for you? If you know someone who'd be great, refer them here: " + m.referUrl] : []), "", signName, "", "--"];
  const why = candidateWhy(m.region, m.source || "");
  t.push([m.senderName, m.senderTitle].filter(Boolean).join(", ") + (m.agency ? ", " + m.agency : ""));
  if (m.address) t.push(m.address);
  t.push("", why + " Delete my details: " + m.deleteUrl, "Not interested? Unsubscribe: " + m.unsubUrl);
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\{\{APPLY_LINK\}\}/g, `<a href="${esc(m.applyUrl)}" style="color:${b.color};">apply here</a>`)
    .replace(/apply here:?\s*<a /i, "<a ");
  const blocks = m.text.split(/\n\s*\n/).map((blk) => blk.split("\n"));
  let first = true;
  const body = blocks.map((ls) => {
    const out: string[] = [];
    let list: string[] = [];
    const flush = () => { if (list.length) { out.push(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${list.map((x) => `<tr><td valign="top" style="padding:0 8px 4px 0;font-size:14px;line-height:1.55;color:${b.color};">&bull;</td><td valign="top" style="padding:0 0 4px;font-size:14px;line-height:1.55;">${inline(x)}</td></tr>`).join("")}</table>`); list = []; } };
    for (const l of ls) {
      const li = l.match(/^\s*[-•*]\s+(.*)$/);
      if (li) { list.push(li[1]); continue; }
      flush();
      if (!l.trim()) continue;
      if (first && /^(hi|hello|dear)\b[^.!?]{0,40},?$/i.test(l.trim())) { out.push(`<div style="font-size:20px;margin-bottom:8px;">${esc(l.trim())}</div>`); first = false; continue; }
      out.push(`<div style="font-size:15px;line-height:1.6;margin-top:${first ? 0 : 12}px;">${inline(l.trim())}</div>`);
      first = false;
    }
    flush();
    return out.join("\n");
  }).join("\n");
  const html = emailShell(b, m.subject, body + button(b, m.applyUrl, "Apply now") +
    (m.referUrl ? `<div style="font-size:14px;line-height:1.6;margin-top:16px;color:#56605A;">Not quite right for you? If you know someone who'd be great, <a href="${esc(m.referUrl)}" style="color:${b.color};">refer them here</a>.</div>` : "") + signHtml(signName, m.senderTitle, m.agency), undefined, undefined,
    footerHtml(b, { sender: [m.senderName, m.senderTitle].filter(Boolean).join(", "), agency: m.agency, address: m.address, why, unsubUrl: m.unsubUrl, deleteUrl: m.deleteUrl }));
  return { text: t.join("\n").replace(/\n{3,}/g, "\n\n"), html };
}

// ---- Pieces shared by candidate outreach and client pitches, in the house email style ----
// The note's first paragraph ("Hi Sarah,") becomes the heading, like every other ProNext email.
function noteHtml(b: Brand, paragraphs: string[]) {
  const ps = [...paragraphs];
  const hi = ps.length && /^(hi|hello|dear)\b[^.!?]{0,40},?$/i.test(ps[0]) ? ps.shift()! : "";
  return (hi ? `<div style="font-size:20px;margin-bottom:8px;">${esc(hi)}</div>` : "") +
    ps.map((p, i) => {
      const parts = p.split("\n"), items = parts.filter((x) => /^[-•*]\s/.test(x)), lead = parts.filter((x) => !/^[-•*]\s/.test(x)).join(" ");
      const list = items.length ? `<ul style="margin:8px 0 0;padding-left:20px;">${items.map((x) => `<li style="margin-top:4px;">${esc(x.replace(/^[-•*]\s+/, ""))}</li>`).join("")}</ul>` : "";
      return `<div style="font-size:15px;line-height:1.6;${i || hi ? "margin-top:12px;" : ""}">${esc(lead)}${list}</div>`;
    }).join("\n");
}
function signHtml(name: string, title: string, agency: string) {
  if (!name) return "";
  const sub = [title, agency].filter(Boolean).join(", ");
  return `<div style="font-size:15px;line-height:1.5;margin-top:20px;">${esc(name)}${sub ? `<br><span style="font-family:Arial,sans-serif;font-size:13px;color:#56605A;">${esc(sub)}</span>` : ""}</div>`;
}
export function footerHtml(b: Brand, f: { sender: string; agency: string; address: string; why: string; unsubUrl: string; deleteUrl?: string }) {
  const a = (href: string, label: string) => `<a href="${esc(href)}" style="color:#56605A;text-decoration:underline;">${label}</a>`;
  return [
    esc([f.sender, f.agency].filter(Boolean).join(" · ")) + (f.address ? "<br>" + esc(f.address) : ""),
    `<div style="margin-top:6px;">${esc(f.why)} If you wish to unsubscribe, ${a(f.unsubUrl, "click here")}.${f.deleteUrl ? " To have your details deleted, " + a(f.deleteUrl, "click here") + "." : ""}</div>`,
  ].join("");
}

// The pitch to a hiring manager, in the same design. Its "Interested? Click here: <link>" line
// becomes the button; the footer carries the sender details, notice and unsubscribe links.
// With viewUrl (client leads): "View the N candidates" opens their blind resumes; "We're interested" sits under it.
// Our Terms of Business, linked from every pitch (they open on the candidates page, where the
// client can also ask to discuss them before unlocking any full resume).
export const termsUrl = (viewUrl?: string) => viewUrl ? viewUrl + (viewUrl.includes("?") ? "&" : "?") + "terms=1" : "";
const termsLine = (b: Brand, viewUrl?: string) => viewUrl ? `<div style="font-size:13px;line-height:1.6;margin-top:8px;color:#56605A;">Our candidates are introduced under our <a href="${esc(termsUrl(viewUrl))}" style="color:${b.color};">Terms of Business</a>, which apply once you unlock a full resume. You can read them, or ask us about them, at any time.</div>` : "";
type PitchCand = { n: number; verdict: string; fit?: number | null; musts: string[]; url: string; reqTotal?: number; reqMet?: number; toConfirm?: string[]; wants?: { item: string; ok: boolean }[] };
export function clientEmail(b: Brand, o: { cands?: PitchCand[]; body: string; interestedUrl: string; region: Region; senderName: string; senderTitle: string; agency: string; address: string; unsubUrl: string; deleteUrl: string; subject: string; viewUrl?: string; viewCount?: number }) {
  const { paragraphs, signoff } = introOf(String(o.body || ""));
  const lines = paragraphs.filter((p) => !/click here|\{\{INTERESTED_LINK\}\}/i.test(p));
  const n = o.viewCount || 0;
  // Candidate first: each candidate with the must-haves they meet and their own blind resume.
  const small = (t: string) => `<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;color:#56605A;margin-top:6px;">${t}</div>`;
  const candHtml = (c: PitchCand) => `<div style="border:1px solid #E6E1D6;border-radius:12px;padding:14px 16px;margin:12px 0;">
<div style="font-size:16px;font-weight:600;">Candidate ${c.n}${c.verdict ? ` <span style="font-size:12px;font-weight:600;color:${b.color};background:#E8F1EC;border-radius:999px;padding:2px 8px;font-family:Arial,sans-serif;">${esc(c.verdict)}</span>` : ""}</div>
${c.reqTotal ? small(`<b style="color:#14201B;">Meets ${c.reqMet} of ${c.reqTotal} requirements in your job description</b>${c.fit != null ? ` · fit ${c.fit}%` : ""}`) : ""}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">${c.musts.map((m) => `<tr><td style="vertical-align:top;padding:2px 8px 2px 0;color:${b.color};font-weight:700;">&#10003;</td><td style="padding:2px 0;font-size:14px;line-height:1.5;">${esc(m)}</td></tr>`).join("")}${(c.toConfirm || []).map((m) => `<tr><td style="vertical-align:top;padding:2px 8px 2px 0;color:#9A6B00;font-weight:700;">?</td><td style="padding:2px 0;font-size:14px;line-height:1.5;">${esc(m)}<span style="color:#56605A;"> · still to confirm</span></td></tr>`).join("")}</table>
${c.wants && c.wants.length ? small(`What they're looking for: ${c.wants.map((w) => `${esc(w.item)} <span style="color:${w.ok ? b.color : "#9A6B00"};font-weight:600;">${w.ok ? "&#10003;" : "to discuss"}</span>`).join(" &nbsp;·&nbsp; ")}`) : ""}
${c.url ? `<a href="${esc(c.url)}" style="display:inline-block;margin-top:10px;padding:9px 16px;background:${b.color};color:#ffffff;text-decoration:none;border-radius:9px;font-family:Arial,sans-serif;font-size:13px;font-weight:600;">View the anonymised resume</a>` : ""}
</div>`;
  if (o.cands && o.cands.length) {
    return emailShell(b, o.subject,
      noteHtml(b, lines) + o.cands.map(candHtml).join("") +
      `<div style="font-size:14px;line-height:1.6;margin-top:6px;color:#56605A;">We don't charge to arrange interviews. We only bill a fee when you hire our candidate.</div>` + termsLine(b, o.viewUrl) +
      signHtml(signoff || o.senderName.split(" ")[0] || "", o.senderTitle, o.agency),
      undefined, undefined,
      footerHtml(b, { sender: [o.senderName, o.senderTitle].filter(Boolean).join(", "), agency: o.agency, address: o.address,
        why: o.region !== "US" ? "Why you're getting this: your company advertised this role publicly and we have a matching candidate. We use only your name, role and work email, only for this purpose." : "You are receiving this email because your company advertised this role publicly.",
        unsubUrl: o.unsubUrl, deleteUrl: o.region !== "US" ? o.deleteUrl : "" }));
  }
  const html = emailShell(b, o.subject,
    noteHtml(b, lines) +
    (o.viewUrl
      ? button(b, o.viewUrl, n > 1 ? `View the ${n} candidates` : "View the candidate") +
        `<div style="font-size:14px;line-height:1.6;margin-top:14px;color:#56605A;">Want to talk to ${n > 1 ? "any of them" : "them"}? <a href="${esc(o.interestedUrl)}" style="color:${b.color};font-weight:600;">We're interested</a>, or just reply to this email.</div>` + termsLine(b, o.viewUrl)
      : button(b, o.interestedUrl, "I'm interested") +
        `<div style="font-size:14px;line-height:1.6;margin-top:16px;color:#56605A;">Or just reply to this email.</div>`) +
    signHtml(signoff || o.senderName.split(" ")[0] || "", o.senderTitle, o.agency),
    undefined, undefined,
    footerHtml(b, { sender: [o.senderName, o.senderTitle].filter(Boolean).join(", "), agency: o.agency, address: o.address,
      why: o.region !== "US" ? "Why you're getting this: your company advertised this role publicly and we have a matching candidate. We use only your name, role and work email, only for this purpose." : "You are receiving this email because your company advertised this role publicly.",
      unsubUrl: o.unsubUrl, deleteUrl: o.region !== "US" ? o.deleteUrl : "" }));
  return html;
}
