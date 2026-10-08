// One-page PDF "role summary" sent with the first outreach email: the role, where and how it's
// worked, pay (when outreach is allowed to mention it) and ONLY the must-have requirements.
// The client is never named. Claude picks the must-haves from the description once; the PDF is
// cached in the public job-briefs bucket under a hash of everything on it, so it's rebuilt only
// when the job (or the apply link) changes. Public on purpose: it's what the public apply page
// shows anyway, and the path can't be guessed.

import { PDFDocument, PDFString, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { askAI } from "./ai.ts";
import { anonymizeJd } from "./common.ts";

const BUCKET = "job-briefs";
export type Brief = { url: string; name: string; bytes: Uint8Array };

// Standard PDF fonts only cover Latin-1: swap smart punctuation, drop anything else.
const latin = (v: unknown) => String(v ?? "")
  .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
  .replace(/[–—−]/g, "-").replace(/[•●▪‣⁃]/g, "-").replace(/…/g, "...")
  .replace(/ /g, " ").normalize("NFKC").replace(/[^\x20-\x7E\xA1-\xFF\n]/g, "").replace(/[ \t]+/g, " ").trim();

async function hashOf(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function payLine(job: any, includePay: boolean) {
  if (!includePay || job.commission_only || !(job.min_pay || job.max_pay)) return "";
  const fmt = (n: unknown) => Number(n) ? Number(n).toLocaleString("en-US") : "";
  const nums = [fmt(job.min_pay), fmt(job.max_pay)].filter(Boolean);
  const range = nums.length === 2 && nums[0] === nums[1] ? nums[0] : nums.join(" - ");
  const per = ({ Yearly: "a year", Monthly: "a month", Weekly: "a week", Daily: "a day", Hourly: "an hour" } as any)[job.salary_period || "Yearly"] || "";
  return `${job.currency || ""} ${range} ${per}`.replace(/\s+/g, " ").trim();
}

async function pickMustHaves(job: any): Promise<{ summary: string; mustHaves: string[] }> {
  const sys = "You turn job descriptions into a short candidate-facing summary. Reply with STRICT JSON only: " +
    "{\"summary\": string, \"mustHaves\": string[]}. summary: two plain sentences on what the role is and what the person will do. " +
    "mustHaves: ONLY the essential requirements a candidate must already have (experience, skills, qualifications, licences, location or work-rights rules), " +
    "4 to 8 items, each under 18 words, most important first. Leave out nice-to-haves, 'preferred' or 'bonus' items, benefits, perks and company blurb. " +
    "Never name the hiring company: call it 'our client' if you must refer to it. Don't invent anything that isn't in the description.";
  const text = `Job title: ${job.role_title}\nLocation: ${job.location || "?"}${job.work_setup ? " (" + job.work_setup + ")" : ""}\n\nDescription:\n${anonymizeJd(job.description, job.client).slice(0, 7000)}`;
  const r = await askAI(sys, text, 2000);
  const mustHaves = (Array.isArray(r?.mustHaves) ? r.mustHaves : []).map((x: unknown) => latin(x)).filter(Boolean).slice(0, 10);
  if (!mustHaves.length) throw new Error("No must-have requirements found in the description");
  return { summary: latin(r?.summary).slice(0, 600), mustHaves };
}

function wrap(text: string, font: any, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) out.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {   // one very long "word" (a URL)
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        out.push(line.slice(0, cut)); line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

async function buildPdf(job: any, info: { summary: string; mustHaves: string[] }, o: { agency: string; address: string; pay: string; applyUrl: string; referUrl: string }) {
  const doc = await PDFDocument.create();
  doc.setTitle(latin(job.role_title) + " - role summary");
  doc.setAuthor(latin(o.agency));
  const page = doc.addPage([595.28, 841.89]);   // A4
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const dark = rgb(0.071, 0.141, 0.114), green = rgb(0.122, 0.435, 0.329), lime = rgb(0.784, 0.945, 0.412);
  const ink = rgb(0.078, 0.125, 0.106), ink2 = rgb(0.337, 0.376, 0.353), line = rgb(0.902, 0.882, 0.839);
  const W = 595.28, M = 48, CW = W - M * 2;

  // Header band.
  page.drawRectangle({ x: 0, y: 841.89 - 150, width: W, height: 150, color: dark });
  page.drawText(latin(o.agency).toUpperCase(), { x: M, y: 841.89 - 46, size: 9, font: bold, color: lime });
  let y = 841.89 - 84;
  for (const l of wrap(latin(job.role_title), serif, 26, CW).slice(0, 2)) { page.drawText(l, { x: M, y, size: 26, font: serif, color: rgb(1, 1, 1) }); y -= 30; }
  const meta = [latin(job.location), latin(job.work_setup), latin(job.employment_type)].filter(Boolean)
    .filter((v, i, a) => i === 0 || !a[0].toLowerCase().includes(v.toLowerCase())).join("  |  ");
  if (meta) page.drawText(wrap(meta, reg, 10.5, CW)[0], { x: M, y: Math.max(y + 4, 841.89 - 140), size: 10.5, font: reg, color: rgb(0.85, 0.9, 0.87) });

  y = 841.89 - 150 - 34;
  if (o.pay) {
    page.drawRectangle({ x: M, y: y - 8, width: Math.min(CW, bold.widthOfTextAtSize("Pay: " + latin(o.pay), 10.5) + 24), height: 24, color: rgb(0.91, 0.957, 0.933) });
    page.drawText("Pay: " + latin(o.pay), { x: M + 12, y: y, size: 10.5, font: bold, color: green });
    y -= 36;
  }

  if (info.summary) {
    page.drawText("THE ROLE", { x: M, y, size: 9, font: bold, color: green }); y -= 18;
    for (const l of wrap(info.summary, reg, 11, CW)) { page.drawText(l, { x: M, y, size: 11, font: reg, color: ink }); y -= 16; }
    y -= 14;
  }

  page.drawText("MUST-HAVE REQUIREMENTS", { x: M, y, size: 9, font: bold, color: green }); y -= 20;
  for (const item of info.mustHaves) {
    const lines = wrap(item, reg, 11, CW - 22);
    if (y - lines.length * 16 < 214) break;
    page.drawCircle({ x: M + 4, y: y + 3.5, size: 2.6, color: green });
    for (const l of lines) { page.drawText(l, { x: M + 18, y, size: 11, font: reg, color: ink }); y -= 16; }
    y -= 6;
  }

  // How to apply / refer.
  const boxTop = y - 14;
  page.drawRectangle({ x: M, y: boxTop - 108, width: CW, height: 108, color: rgb(0.953, 0.937, 0.906), borderColor: line, borderWidth: 1 });
  page.drawText("Interested?", { x: M + 18, y: boxTop - 28, size: 14, font: serif, color: ink });
  page.drawText("Apply in two minutes:", { x: M + 18, y: boxTop - 50, size: 10, font: reg, color: ink2 });
  page.drawText(wrap(o.applyUrl, bold, 10, CW - 36)[0], { x: M + 18, y: boxTop - 64, size: 10, font: bold, color: green });
  page.drawText("Know someone who'd fit? Refer them:", { x: M + 18, y: boxTop - 84, size: 10, font: reg, color: ink2 });
  page.drawText(wrap(o.referUrl, bold, 10, CW - 36)[0], { x: M + 18, y: boxTop - 98, size: 10, font: bold, color: green });
  // Make both links clickable.
  const linkAt = (url: string, y0: number) => page.node.addAnnot(doc.context.register(doc.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [M + 14, y0 - 4, W - M - 14, y0 + 12], Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
  })));
  linkAt(o.applyUrl, boxTop - 64);
  linkAt(o.referUrl, boxTop - 98);

  // Footer.
  page.drawLine({ start: { x: M, y: 60 }, end: { x: W - M, y: 60 }, thickness: 1, color: line });
  page.drawText(latin(o.agency), { x: M, y: 44, size: 9, font: bold, color: ink2 });
  if (o.address) page.drawText(wrap(latin(o.address), reg, 8.5, CW)[0], { x: M, y: 31, size: 8.5, font: reg, color: ink2 });
  return await doc.save();
}

// The role summary for a job, built (and cached) when needed. Never throws: outreach still goes
// out without the PDF if the description is empty or the AI is unavailable.
export async function ensureBrief(admin: any, job: any, o: { agency: string; address: string; includePay: boolean; applyUrl: string; referUrl: string }): Promise<Brief | null> {
  try {
    if (!job?.id || String(job.description || "").trim().length < 80) return null;
    const pay = payLine(job, o.includePay);
    const key = await hashOf(JSON.stringify(["v1", job.role_title, job.description, job.location, job.work_setup, job.employment_type, pay, o.agency, o.address, o.applyUrl, o.referUrl, job.client]));
    const path = `${job.id}/${key}.pdf`;
    const slugTitle = latin(job.role_title).replace(/[^A-Za-z0-9]+/g, " ").trim().slice(0, 60) || "Role";
    const name = `${slugTitle} - role summary.pdf`;
    const url = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl as string;
    const { data: have } = await admin.storage.from(BUCKET).download(path);
    if (have) return { url, name, bytes: new Uint8Array(await have.arrayBuffer()) };
    const info = await pickMustHaves(job);
    const bytes = await buildPdf(job, info, { agency: o.agency, address: o.address, pay, applyUrl: o.applyUrl, referUrl: o.referUrl });
    const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
    if (error) throw new Error(error.message);
    return { url, name, bytes };
  } catch (e) {
    console.error("role summary", job?.id, String((e as Error)?.message || e));
    return null;
  }
}
