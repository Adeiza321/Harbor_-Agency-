// Outreach templates: the first email to an outside candidate, set per job (jobs.outreach_template).
//
// A template is { subject, body } in the agency's own words, for example:
//   Subject: Gas Safe Plumber – £25-30K, Croydon (Hybrid)
//   Hi [First Name],
//   I came across your profile while searching for Gas Safe plumbers in the London area.
//   We're working on a Plumber role:
//   - **Location:** Croydon (Hybrid – 3 days on-site, 2 remote)
//   ...
//   Your [specific skill/experience from their profile] caught my attention.
//   If you're open to exploring it, you can apply here: {{APPLY_LINK}}
//   Ahmed
//
// Placeholders: [First Name], [specific skill/experience from their profile] (one short phrase the
// AI picks from that person's profile, e.g. "NICEIC registration and commercial installation
// work"), and {{APPLY_LINK}} (the job's tracked apply link, so clicks still mark people as
// interested). Any pasted apply URL for the job is turned into {{APPLY_LINK}} on save.
// A job without a template gets one written by the AI in the same style the first time it's needed,
// then kept on the job so the team can edit it. The client is never named.

import { askAI } from "./ai.ts";
import { anonymizeJd } from "./common.ts";
import { payText } from "./outreach.ts";

export type Template = { subject: string; body: string; source?: "agency" | "ai"; at?: string };
export const SKILL_RX = /\[\s*specific skill[^\]]*\]/gi;
export const NAME_RX = /\[\s*first name\s*\]/gi;
const SKILL_TEST = /\[\s*specific skill[^\]]*\]/i;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Clean a template sent by a person: plain text, the job's apply URLs turned into {{APPLY_LINK}}.
export function cleanTemplate(t: any): Template | null {
  if (!t || typeof t !== "object") return null;
  const subject = clip(t.subject, 160);
  let body = String(t.body || "").replace(/\r/g, "").slice(0, 4000).trim();
  if (!subject || !body) return null;
  body = body.replace(/https?:\/\/[^\s)]*\/jobs\/[^\s)]*/gi, "{{APPLY_LINK}}");
  if (!/\{\{APPLY_LINK\}\}/.test(body)) body += "\n\nYou can apply here: {{APPLY_LINK}}";
  return { subject, body, source: t.source === "ai" ? "ai" : "agency", at: new Date().toISOString() };
}

// The job's template, writing one in the house style if it has none.
export async function templateFor(admin: any, job: any, senderFirst: string, includePay: boolean): Promise<Template | null> {
  const t = job?.outreach_template;
  if (t?.subject && t?.body) return t as Template;
  try {
    const pay = payText(job, includePay);
    const sys = "You write a recruiter's first outreach email template for one job, in a fixed house style. Reply with STRICT JSON only: {\"subject\": string, \"body\": string}. " +
      "subject: '<role title> – <pay if given>, <location> (<work setup>)', under 80 characters. " +
      "body, exactly this shape (plain text, keep the placeholders exactly as written):\n" +
      "Hi [First Name],\n\nI came across your profile while searching for <the kind of people this role needs> in <the area>.\n\nWe're working on a <role title> role:\n" +
      "- **Location:** <place> (<work setup>)\n- **Salary:** <pay> (leave this line out if no pay is given)\n- **Requirements:** <the 2-3 essential requirements, comma-separated>\n\n" +
      "Your [specific skill/experience from their profile] caught my attention.\n\nIf you're open to exploring it, you can apply here: {{APPLY_LINK}}\n\nHappy to answer any questions.\n\n<sender first name>\n" +
      "Never name the hiring company or describe it in a way that identifies it. Use only facts from the job; don't invent pay or requirements.";
    const text = `Role title: ${job.role_title}\nLocation: ${job.location || job.country || "?"}\nWork setup: ${job.work_setup || "?"}\nEmployment: ${job.employment_type || "?"}\nPay: ${pay || "(not given)"}\nSender first name: ${senderFirst || "the recruiter"}\n\nDescription:\n${anonymizeJd(job.description, job.client).slice(0, 5000)}`;
    const out = await askAI(sys, text, 1500);
    const made = cleanTemplate({ subject: anonymizeJd(out?.subject, job.client), body: anonymizeJd(out?.body, job.client), source: "ai" });
    if (made) await admin.from("jobs").update({ outreach_template: made }).eq("id", job.id);
    return made;
  } catch (e) {
    console.error("template", job?.id, String((e as Error)?.message || e));
    return null;
  }
}

// Fill the template for each person: their first name, and one short phrase from their profile.
export async function fillTemplate(job: any, tpl: Template, people: any[]): Promise<Record<string, { subject: string; body: string }>> {
  const out: Record<string, { subject: string; body: string }> = {};
  let hooks: Record<string, string> = {};
  if (SKILL_TEST.test(tpl.body)) {
    try {
      const line = (tpl.body.split("\n").find((l) => SKILL_TEST.test(l)) || "Your [specific skill/experience from their profile] caught my attention.").trim();
      const sys = "For each person, write the short phrase that fills the blank in this sentence of a recruiting email: \"" + line + "\". Reply with STRICT JSON only: {\"hooks\": [{\"id\": string, \"phrase\": string}]}. " +
        "The phrase is 3 to 12 words naming one or two specific, real things from that person's profile that match the role (a licence, certification, employer, years in a field, a kind of work), " +
        "written so the sentence reads naturally after 'Your' (e.g. 'Gas Safe registration and five years servicing boilers at British Gas'). No praise words, no 'impressive', nothing you can't see in their profile.";
      const who = people.map((p) => `id=${p.id} | ${clip(p.title, 120)} at ${clip(p.company, 80)} | ${clip(p.data?.overview || p.fit_reason, 300)} | ${clip(p.data?.history, 300)}`).join("\n");
      const r = await askAI(sys, `Role: ${job.role_title}\n\nPeople:\n${who}`, 2500);
      for (const h of Array.isArray(r?.hooks) ? r.hooks : []) hooks[String(h.id)] = clip(anonymizeJd(h.phrase, job.client), 140);
    } catch (e) { console.error("template hooks", String((e as Error)?.message || e)); hooks = {}; }
  }
  for (const p of people) {
    const first = clip(p.first_name || String(p.full_name || "").split(" ")[0], 40) || "there";
    const hook = hooks[p.id] || clip(p.title, 80) && `experience as ${clip(p.title, 80)}` || "background";
    const fill = (s: string) => s.replace(NAME_RX, first).replace(SKILL_RX, hook);
    out[p.id] = { subject: fill(tpl.subject).slice(0, 160), body: fill(tpl.body) };
  }
  return out;
}

// Draft (or redraft) template emails for these prospects. Returns how many were written.
export async function draftFromTemplate(admin: any, job: any, people: any[], senderFirst: string, includePay: boolean): Promise<number> {
  if (!people.length) return 0;
  const tpl = await templateFor(admin, job, senderFirst, includePay);
  if (!tpl) return 0;
  const filled = await fillTemplate(job, tpl, people);
  let n = 0;
  for (const p of people) {
    const m = filled[p.id];
    if (!m) continue;
    await admin.from("prospects").update({ subject: m.subject, body: m.body, data: { ...(p.data || {}), template: true } }).eq("id", p.id);
    n++;
  }
  return n;
}

// Template emails, rendered: **bold**, "- " lines as a list, {{APPLY_LINK}} as a link.
export const isTemplateBody = (body: string) => /\{\{APPLY_LINK\}\}/.test(String(body || ""));
export function templateParts(body: string) {
  const lines = String(body || "").replace(/\r/g, "").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let signoff = "";
  const last = (lines[lines.length - 1] || "").trim();
  if (last && last.length <= 40 && !/https?:|\{\{/.test(last)) { signoff = last; lines.pop(); }
  return { text: lines.join("\n").trim(), signoff };
}
