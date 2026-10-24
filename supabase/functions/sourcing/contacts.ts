// Who a client pitch goes to. Each contact gets their own email (never copied on one).
//   1. Anyone named in the job description with a work email (e.g. "send your CV to jane@acme.com")
//   2. The person who posted the job, when the job feed names them
//   3. Talent Acquisition (TA / recruiting / HR lead)
//   4. The hiring manager (the titles this role likely reports to, from the job description)
//   5. The CEO (or founder / managing director)
// Apollo is the main source (outreach.emailLookup: "apollo_only" by default since ContactOut's credits
// ran out; "apollo" = ContactOut as backup; "contactout" = ContactOut first). Apollo: search the company
// by title, then reveal the work email. ContactOut the same way; the other source covers anyone missed.
// Work emails only (never personal), and only
// verified ones from either source; never anyone who unsubscribed. Looked up once per lead, when the
// pitch is written (each email revealed costs a credit). With nobody found the lead waits for
// Rec Ops / an Admin to add a contact by hand.

import { apolloKey, matchById, matchByName, searchCompanyPeople, type ApolloPerson } from "./apollo.ts";
import { contactoutByLinkedIn, contactoutKey, contactoutSearch } from "./contactout.ts";
import { emailHash } from "./send.ts";

export type Contact = {
  role: string; name: string; first_name: string; title: string; email: string; linkedin: string; apollo_id: string; source: string;
  token: string;            // their own unsubscribe / "interested" links (lead token ~ this)
  unsubscribed?: boolean;
};

const TA_TITLES = ["Talent Acquisition", "Head of Talent", "Recruiting Manager", "Recruiter", "Head of Recruitment", "HR Manager", "HR Director", "Head of People", "People Operations Manager", "Human Resources Manager"];
const CEO_TITLES = ["CEO", "Chief Executive Officer", "Founder", "Co-Founder", "Managing Director", "President", "Owner"];
const HM_FALLBACK = ["Head of Department", "Director"];
const MAX_CONTACTS = 5;

// Personal mailboxes are never used for clients.
const PERSONAL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|mail|yandex|zoho|qq|163)\.[a-z.]+$/i;
export const workEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !PERSONAL.test(e) && !/noreply|no-reply|donotreply/i.test(e);
export const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("");
const first = (name: string) => String(name || "").trim().split(/\s+/)[0] || "";

async function suppressed(admin: any, email: string) {
  const { data } = await admin.from("outreach_suppressions").select("email_norm").eq("email_norm", await emailHash(email)).maybeSingle();
  return !!data;
}

function fromApollo(role: string, p: ApolloPerson, source = "Apollo"): Contact {
  const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(" ");
  return { role, name, first_name: p.first_name || first(name), title: p.title, email: p.email, linkedin: p.linkedin_url, apollo_id: p.id, source, token: newToken() };
}

// Contacts named in the job description: only addresses that really appear in its text.
export function jdContacts(description: string, aiFound: any[]): Contact[] {
  const text = String(description || "");
  const inText = new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((e) => e.toLowerCase()));
  const out: Contact[] = [];
  const add = (email: string, name = "", title = "") => {
    const e = email.trim().toLowerCase();
    if (!inText.has(e) || !workEmail(e) || out.some((c) => c.email === e)) return;
    out.push({ role: "Named in the job description", name: name.slice(0, 120), first_name: first(name), title: title.slice(0, 120), email: e, linkedin: "", apollo_id: "", source: "Job description", token: newToken() });
  };
  for (const c of Array.isArray(aiFound) ? aiFound : []) add(String(c?.email || ""), String(c?.name || ""), String(c?.title || ""));
  for (const e of inText) add(e);
  return out.slice(0, 3);
}

// Find the contacts at the lead's company, in order.
export async function findCompanyContacts(admin: any, lead: any, hmTitles: string[], order: string = "apollo_only"): Promise<{ contacts: Contact[]; tried: string[]; error?: string }> {
  const contacts: Contact[] = [];
  const tried: string[] = [];
  const errors: string[] = [];
  const emails = new Set<string>();
  const keep = async (c: Contact | null) => {
    if (!c?.email || !workEmail(c.email)) return false;
    const e = c.email.toLowerCase();
    if (emails.has(e) || await suppressed(admin, c.email)) return false;
    emails.add(e); contacts.push({ ...c, email: e }); return true;
  };
  const co = !!contactoutKey() && order !== "apollo_only", ap = !!apolloKey();
  const coFirst = order === "contactout";

  // 1. Named in the job description (found when it was read).
  for (const c of Array.isArray(lead.data?.jd_contacts) ? lead.data.jd_contacts : []) await keep({ ...c, token: c.token || newToken() });
  if (contacts.length) tried.push("Job description");

  // 2. The person who posted the job (job feed): ContactOut by their LinkedIn, else Apollo by name.
  const team: any[] = Array.isArray(lead.data?.hiring_team) ? lead.data.hiring_team : [];
  const poster = team.find((h) => /talent|recruit|hiring|people|hr\b|human/i.test(h.role || "")) || team[0] || null;
  if (poster) {
    tried.push("Job poster");
    let got = false;
    const posterCo = async () => {
      if (got || !co || !poster.linkedin_url) return;
      try {
        const r = await contactoutByLinkedIn(poster.linkedin_url, true);
        if (r.status === "verified") got = await keep({ role: "Posted the job", name: poster.full_name || "", first_name: poster.first_name || first(poster.full_name), title: poster.role || "", email: r.email, linkedin: poster.linkedin_url, apollo_id: "", source: "ContactOut", token: newToken() });
      } catch (e) { errors.push(String((e as Error)?.message || e)); }
    };
    const posterAp = async () => {
      if (got || !ap) return;
      const parts = String(poster.full_name || "").trim().split(/\s+/);
      try {
        const p = await matchByName(poster.first_name || parts[0] || "", parts.slice(1).join(" "), lead.company_domain || "", lead.company || "");
        if (p?.email && p.email_status === "verified") got = await keep({ ...fromApollo("Posted the job", p), linkedin: p.linkedin_url || poster.linkedin_url || "" });
      } catch (e) { errors.push(String((e as Error)?.message || e)); }
    };
    if (coFirst) { await posterCo(); await posterAp(); } else { await posterAp(); await posterCo(); }
  }

  // 3-5. Talent Acquisition, hiring manager, CEO: the main source first, the other for whoever it misses.
  const roles: { role: string; titles: string[] }[] = [
    { role: "Talent Acquisition", titles: TA_TITLES },
    { role: "Hiring manager", titles: (hmTitles.length ? hmTitles : HM_FALLBACK).slice(0, 8) },
    { role: "CEO", titles: CEO_TITLES },
  ];
  for (const r of roles) {
    if (contacts.length >= MAX_CONTACTS) break;
    tried.push(r.role);
    let got = false;
    const roleCo = async () => {
      if (got || !co) return;
      try {
        const hits = await contactoutSearch({ domain: lead.company_domain, company: lead.company, titles: r.titles, limit: 3 });
        for (const h of hits.slice(0, 2)) {   // up to 2 reveals per role
          const rv = await contactoutByLinkedIn(h.linkedin, true);
          if (rv.status !== "verified") continue;
          got = await keep({ role: r.role, name: h.name, first_name: first(h.name), title: h.title, email: rv.email, linkedin: h.linkedin, apollo_id: "", source: "ContactOut", token: newToken() });
          if (got) break;
        }
      } catch (e) { errors.push(String((e as Error)?.message || e)); console.error("contactout contacts", r.role, errors[errors.length - 1]); }
    };
    const roleAp = async () => {
      if (got || !ap) return;
      try {
        const hits = (await searchCompanyPeople({ domain: lead.company_domain, company: lead.company, titles: r.titles, perPage: 10 })).filter((h) => h.has_email);
        for (const h of hits.slice(0, 2)) {
          const p = await matchById(h.id);
          if (!p?.email || p.email_status !== "verified") continue;
          got = await keep(fromApollo(r.role, p));
          if (got) break;
        }
      } catch (e) { errors.push(String((e as Error)?.message || e)); console.error("apollo contacts", r.role, errors[errors.length - 1]); }
    };
    if (coFirst) { await roleCo(); await roleAp(); } else { await roleAp(); await roleCo(); }
  }
  if (!co && !ap) errors.push("Apollo isn't connected");
  // Lookup problems are kept even when someone was found (shown on the lead), so a source that
  // stopped working doesn't go unnoticed.
  return { contacts: contacts.slice(0, MAX_CONTACTS), tried, ...(errors.length ? { error: [...new Set(errors.map((e) => e.slice(0, 160)))].join("; ").slice(0, 300) } : {}) };
}

// Who still gets the pitch: everyone on the lead who hasn't unsubscribed.
export const liveContacts = (lead: any): Contact[] => (Array.isArray(lead?.data?.contacts) ? lead.data.contacts : []).filter((c: any) => c?.email && !c.unsubscribed && !c.removed);

// The lead's single-contact fields (shown in lists and used by older screens): the first contact.
export function contactFields(contacts: Contact[]) {
  const main = contacts.find((c) => !c.unsubscribed) || null;
  return {
    contact_name: main?.name || null, contact_first_name: main?.first_name || null, contact_role: main ? (main.title || main.role) : null,
    contact_linkedin: main?.linkedin || null, contact_email: main?.email || null, contact_email_status: main ? "verified" : null,
    channel: main?.email ? "email" : main?.linkedin ? "linkedin" : "none",
  };
}

// The pitch body for one contact: the greeting uses their first name.
export const greet = (body: string, c: { first_name?: string }) =>
  String(body || "").replace(/^\s*(Hi|Hello|Dear)\b[^,\n]*,/i, `Hi ${c.first_name || "there"},`);

// Rec Ops / an Admin on a lead's contacts: look again, add one by hand, or take one off.
export async function leadContactsAction(admin: any, leadId: string, op: string, body: any, order = "apollo_only") {
  const { data: lead } = await admin.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) throw new Error("Lead not found");
  let list: Contact[] = (Array.isArray(lead.data?.contacts) ? lead.data.contacts : []).filter((c: any) => c && !c.removed);
  const extra: Record<string, unknown> = {};
  let message = "Saved";
  if (op === "find") {
    const found = await findCompanyContacts(admin, lead, lead.data?.role?.hmTitles || [], order);
    const have = new Set(list.map((c) => c.email.toLowerCase()));
    const added = found.contacts.filter((c) => !have.has(c.email.toLowerCase()));
    list = [...list, ...added];
    Object.assign(extra, { contacts_checked_at: new Date().toISOString(), contacts_tried: found.tried, contacts_error: found.error || null });
    message = added.length ? `Found ${added.length} new contact${added.length === 1 ? "" : "s"}` : found.error ? "Couldn't look them up: " + found.error : "No one new found";
  } else if (op === "add") {
    const email = String(body?.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Add a valid email address");
    if (!workEmail(email)) throw new Error("Use their work email (not a personal Gmail, Yahoo, Outlook… address)");
    if (list.some((c) => c.email.toLowerCase() === email)) throw new Error("That contact is already on this lead");
    if (await suppressed(admin, email)) throw new Error("This person unsubscribed, so they can't be emailed");
    const name = String(body?.name || "").trim().slice(0, 120);
    list = [...list, { role: "Added by hand", name, first_name: first(name), title: String(body?.title || "").trim().slice(0, 120), email, linkedin: "", apollo_id: "", source: "Added by hand", token: newToken() }];
    message = "Contact added. They'll get their own email";
  } else if (op === "remove") {
    const i = Number(body?.index);
    if (!(i >= 0 && i < list.length)) throw new Error("Contact not found");
    const [c] = list.splice(i, 1);
    await admin.from("outreach_messages").update({ status: "skipped", error: "Taken off the lead" }).eq("lead_id", lead.id).eq("status", "queued").eq("to_email", c.email);
    message = "Contact taken off";
  } else throw new Error("Unknown contact action");
  await admin.from("leads").update({ data: { ...(lead.data || {}), ...extra, contacts: list }, ...contactFields(list) }).eq("id", lead.id);
  return { ok: true, message, contacts: list };
}
