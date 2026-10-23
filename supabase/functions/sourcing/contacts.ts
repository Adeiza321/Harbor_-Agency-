// Who a client pitch goes to: found on Apollo at the employer, not taken from the job posting.
//   1. Talent Acquisition (TA / recruiting / HR lead)
//   2. The hiring manager (the titles this role likely reports to, from the job description)
//   3. The CEO (or founder / managing director)
// One email: the first one found in that order is the main recipient and the others are copied.
// Only verified work emails, never personal ones, never anyone who unsubscribed. Searching is
// free; each email revealed costs 1 Apollo credit, so it's done once per lead, when the pitch is
// written. If Apollo finds no one, the person who posted the job (from the job feed) is tried;
// if there's still no one, the lead waits for Rec Ops / an Admin to add a contact by hand.

import { apolloKey, matchById, matchByName, searchCompanyPeople, type ApolloPerson } from "./apollo.ts";
import { emailHash } from "./send.ts";

export type Contact = { role: string; name: string; first_name: string; title: string; email: string; linkedin: string; apollo_id: string; source: string };

const TA_TITLES = ["Talent Acquisition", "Head of Talent", "Recruiting Manager", "Recruiter", "Head of Recruitment", "HR Manager", "HR Director", "Head of People", "People Operations Manager", "Human Resources Manager"];
const CEO_TITLES = ["CEO", "Chief Executive Officer", "Founder", "Co-Founder", "Managing Director", "President", "Owner"];
const HM_FALLBACK = ["Head of Department", "Director"];

async function suppressed(admin: any, email: string) {
  const { data } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(email)).maybeSingle();
  return !!data;
}

function toContact(role: string, p: ApolloPerson, source = "apollo"): Contact {
  return { role, name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" "), first_name: p.first_name, title: p.title,
    email: p.email, linkedin: p.linkedin_url, apollo_id: p.id, source };
}

// Find the three contacts at the lead's company. Returns them in order (main recipient first).
export async function findCompanyContacts(admin: any, lead: any, hmTitles: string[]): Promise<{ contacts: Contact[]; tried: string[]; error?: string }> {
  const contacts: Contact[] = [];
  const tried: string[] = [];
  if (!apolloKey()) return { contacts, tried, error: "Apollo isn't connected" };
  const seen = new Set<string>();
  const emails = new Set<string>();
  const roles: { role: string; titles: string[] }[] = [
    { role: "Talent Acquisition", titles: TA_TITLES },
    { role: "Hiring manager", titles: (hmTitles.length ? hmTitles : HM_FALLBACK).slice(0, 8) },
    { role: "CEO", titles: CEO_TITLES },
  ];
  let error = "";
  for (const r of roles) {
    tried.push(r.role);
    try {
      const hits = (await searchCompanyPeople({ domain: lead.company_domain, company: lead.company, titles: r.titles, perPage: 10 }))
        .filter((h) => !seen.has(h.id) && h.has_email);
      // Up to 2 reveals per role (1 credit each when an email comes back).
      for (const h of hits.slice(0, 2)) {
        seen.add(h.id);
        const p = await matchById(h.id);
        if (!p?.email || p.email_status !== "verified") continue;
        const e = p.email.toLowerCase();
        if (emails.has(e) || await suppressed(admin, p.email)) continue;
        emails.add(e);
        contacts.push(toContact(r.role, p));
        break;
      }
    } catch (e) { error = String((e as Error)?.message || e).slice(0, 200); console.error("apollo contacts", r.role, error); }
  }
  // Nobody on Apollo: the person who posted the job, when the job feed names them.
  if (!contacts.length) {
    const team: any[] = Array.isArray(lead.data?.hiring_team) ? lead.data.hiring_team : [];
    const poster = team.find((h) => /talent|recruit|hiring|people|hr\b|human/i.test(h.role || "")) || team[0] || null;
    if (poster) {
      tried.push("Job poster");
      const parts = String(poster.full_name || "").trim().split(/\s+/);
      try {
        const p = await matchByName(poster.first_name || parts[0] || "", parts.slice(1).join(" "), lead.company_domain || "", lead.company || "");
        if (p?.email && p.email_status === "verified" && !await suppressed(admin, p.email)) contacts.push({ ...toContact("Posted the job", p, "job feed"), linkedin: p.linkedin_url || poster.linkedin_url || "" });
      } catch (e) { error = String((e as Error)?.message || e).slice(0, 200); }
    }
  }
  return { contacts, tried, ...(error && !contacts.length ? { error } : {}) };
}

// The lead's contact fields from the contacts list: the first is the main recipient, the rest copied.
export function contactFields(contacts: Contact[]) {
  const main = contacts[0] || null;
  return {
    contact_name: main?.name || null, contact_first_name: main?.first_name || null, contact_role: main ? (main.title || main.role) : null,
    contact_linkedin: main?.linkedin || null, contact_email: main?.email || null, contact_email_status: main ? "verified" : null,
    channel: main?.email ? "email" : main?.linkedin ? "linkedin" : "none",
  };
}

// The copied contacts of a lead (everyone after the main recipient).
export function ccOf(lead: any): { email: string; name: string }[] {
  const list: any[] = Array.isArray(lead?.data?.contacts) ? lead.data.contacts : [];
  const main = String(lead?.contact_email || "").toLowerCase();
  return list.filter((c) => c?.email && String(c.email).toLowerCase() !== main && !c.removed).map((c) => ({ email: String(c.email), name: String(c.name || "") }));
}

// Rec Ops / an Admin on a lead's contacts: look them up on Apollo again, add one by hand, make one
// the main recipient, or take one off. The first in the list is who the pitch goes to; the rest
// are copied.
export async function leadContactsAction(admin: any, leadId: string, op: string, body: any) {
  const { data: lead } = await admin.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) throw new Error("Lead not found");
  let list: Contact[] = (Array.isArray(lead.data?.contacts) ? lead.data.contacts : []).filter((c: any) => c && !c.removed);
  const extra: Record<string, unknown> = {};
  let message = "Saved";
  if (op === "find") {
    const found = await findCompanyContacts(admin, lead, lead.data?.role?.hmTitles || []);
    const have = new Set(list.map((c) => c.email.toLowerCase()));
    const added = found.contacts.filter((c) => !have.has(c.email.toLowerCase()));
    list = [...list, ...added];
    Object.assign(extra, { contacts_checked_at: new Date().toISOString(), contacts_tried: found.tried, contacts_error: found.error || null });
    message = added.length ? `Found ${added.length} contact${added.length === 1 ? "" : "s"} on Apollo` : found.error ? "Apollo: " + found.error : "No one new found on Apollo";
  } else if (op === "add") {
    const email = String(body?.email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Add a valid email address");
    if (list.some((c) => c.email.toLowerCase() === email.toLowerCase())) throw new Error("That contact is already on this lead");
    if (await suppressed(admin, email)) throw new Error("This person unsubscribed, so they can't be emailed");
    const name = String(body?.name || "").trim().slice(0, 120);
    const c: Contact = { role: String(body?.role || "Added by hand").slice(0, 60), name, first_name: name.split(/\s+/)[0] || "", title: String(body?.title || "").trim().slice(0, 120), email, linkedin: "", apollo_id: "", source: "manual" };
    list = body?.main ? [c, ...list] : [...list, c];
    message = body?.main || list.length === 1 ? "Contact added. The pitch goes to them" : "Contact added. They'll be copied";
  } else if (op === "main" || op === "remove") {
    const i = Number(body?.index);
    if (!(i >= 0 && i < list.length)) throw new Error("Contact not found");
    const [c] = list.splice(i, 1);
    if (op === "main") { list.unshift(c); message = "The pitch goes to " + (c.name || c.email) + " now"; }
    else message = "Contact taken off";
  } else throw new Error("Unknown contact action");
  await admin.from("leads").update({ data: { ...(lead.data || {}), ...extra, contacts: list }, ...contactFields(list) }).eq("id", lead.id);
  // Still waiting in the send queue: the queued email follows the change.
  const f = contactFields(list);
  if (f.contact_email) await admin.from("outreach_messages").update({ to_email: f.contact_email, to_name: f.contact_name, cc: list.slice(1).map((c) => ({ email: c.email, name: c.name })) }).eq("lead_id", lead.id).eq("status", "queued");
  else await admin.from("outreach_messages").update({ status: "skipped", error: "No contact" }).eq("lead_id", lead.id).eq("status", "queued");
  return { ok: true, message, contacts: list };
}
