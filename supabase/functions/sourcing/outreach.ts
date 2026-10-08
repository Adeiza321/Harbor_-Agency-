// The first email to an outside candidate, in the same branded design as Pronext's other
// candidate emails: a short personal note (written by Claude when the prospect was found), a
// role overview (title, location, work setup, pay), the must-have requirements only, and two
// buttons: "I'm interested" (the job's apply form) and "Refer someone" (the referral form).
// The client is never named. Must-haves are picked by Claude once per job and kept on the job
// (jobs.outreach_brief) until the description changes.

import { askAI } from "./ai.ts";
import { anonymizeJd } from "./common.ts";
import { esc, type Brand } from "./brand.ts";
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
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  return { paragraphs, signoff };
}

export type CandidateMail = {
  brand: Brand; region: Region; paragraphs: string[]; signoff: string;
  senderName: string; senderTitle: string; agency: string; address: string;
  role: { title: string; location: string; workSetup: string; employmentType: string; pay: string };
  summary: string; mustHaves: string[];
  applyUrl: string; referUrl: string; unsubUrl: string; deleteUrl: string;
};

const P = "margin:0 0 14px;font-size:15px;line-height:1.6;color:#14201B;font-family:Arial,Helvetica,sans-serif;";

export function candidateEmail(m: CandidateMail): { text: string; html: string } {
  const b = m.brand;
  const meta = [m.role.location, m.role.workSetup, m.role.employmentType].filter(Boolean)
    .filter((v, i, a) => i === 0 || !String(a[0]).toLowerCase().includes(String(v).toLowerCase()));
  const signName = m.signoff || m.senderName.split(" ")[0] || "";
  const why = m.region !== "US"
    ? "Why you're getting this: we found your work profile in Apollo.io, a business contact database, and it matches this role. We use only your name, job title and work email, only to tell you about roles like this, and delete them if you're not interested."
    : "";

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
  if (why) t.push("", why + " Delete my details: " + m.deleteUrl);
  t.push("Not interested? Unsubscribe: " + m.unsubUrl);
  const text = t.join("\n").replace(/\n{3,}/g, "\n\n");

  // ---- HTML (tables and inline styles, so it lines up in Gmail, Outlook and on phones) ----
  const mark = b.logo
    ? `<img src="${esc(b.logo)}" alt="${esc(b.name)}" height="32" style="height:32px;max-width:180px;display:block;border:0;">`
    : `<span style="font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#14201B;">${esc(b.name)}</span>`;
  const metaHtml = meta.map((x) => esc(x)).join(" &nbsp;·&nbsp; ");
  const btn = (href: string, label: string, solid: boolean) =>
    `<td style="padding:0 10px 10px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${solid ? b.color : "#ffffff"}" style="border-radius:10px;${solid ? "" : `border:1.5px solid ${b.color};`}">` +
    `<a href="${esc(href)}" style="display:inline-block;padding:${solid ? "13px 22px" : "11.5px 20px"};white-space:nowrap;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:${solid ? "#ffffff" : b.color};text-decoration:none;border-radius:10px;">${esc(label)}</a></td></tr></table></td>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(m.role.title)}</title></head>
<body style="margin:0;padding:0;background:#F3EFE7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(m.role.title + (meta.length ? " · " + meta.join(" · ") : ""))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3EFE7" style="background:#F3EFE7;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td style="padding:0 4px 16px;">${mark}</td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid #E6E1D6;border-radius:16px;padding:28px 28px 20px;">
${m.paragraphs.map((p) => `<p style="${P}">${esc(p)}</p>`).join("\n")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px;"><tr><td bgcolor="#F6F4EE" style="background:#F6F4EE;border-radius:12px;padding:18px 20px;">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;font-weight:bold;color:${b.color};margin:0 0 6px;">THE ROLE</div>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;color:#14201B;line-height:1.35;margin:0 0 6px;">${esc(m.role.title)}</div>
${metaHtml ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#56605A;line-height:1.5;">${metaHtml}</div>` : ""}
${m.role.pay ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14201B;line-height:1.5;margin-top:4px;"><b>Pay:</b> ${esc(m.role.pay)}</div>` : ""}
${m.summary ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14201B;line-height:1.55;margin-top:10px;">${esc(m.summary)}</div>` : ""}
</td></tr></table>
${m.mustHaves.length ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#14201B;margin:0 0 8px;">Must-have requirements</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${m.mustHaves.map((x) =>
    `<tr><td valign="top" style="padding:0 10px 7px 2px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:${b.color};">&#10003;</td><td valign="top" style="padding:0 0 7px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#14201B;">${esc(x)}</td></tr>`).join("")}</table>` : ""}
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${btn(m.applyUrl, "I'm interested", true)}${btn(m.referUrl, "Refer someone", false)}</tr></table>
<p style="margin:4px 0 18px;font-size:13px;line-height:1.5;color:#56605A;font-family:Arial,Helvetica,sans-serif;">Not quite right for you? If you know someone who'd be great, we'd love an introduction.</p>
<p style="margin:0;font-size:15px;line-height:1.5;color:#14201B;font-family:Arial,Helvetica,sans-serif;">${esc(signName)}${m.senderTitle ? `<br><span style="color:#56605A;font-size:13px;">${esc(m.senderTitle)}${m.agency ? ", " + esc(m.agency) : ""}</span>` : ""}</p>
</td></tr>
<tr><td align="center" style="padding:18px 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#56605A;text-align:center;">
${esc([m.senderName, m.senderTitle].filter(Boolean).join(", "))}${m.agency ? " &middot; " + esc(m.agency) : ""}<br>
${m.address ? esc(m.address) + "<br>" : ""}
${why ? `<span style="color:#8A8578;">${esc(why)}</span><br>` : ""}
<a href="${esc(m.unsubUrl)}" style="color:#56605A;text-decoration:underline;">Unsubscribe</a>${why ? ` &nbsp;&middot;&nbsp; <a href="${esc(m.deleteUrl)}" style="color:#56605A;text-decoration:underline;">Delete my details</a>` : ""}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { text, html };
}
