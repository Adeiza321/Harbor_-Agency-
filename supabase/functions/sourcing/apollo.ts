// Apollo.io: people search (free, no emails) and people match (reveals email, 1 credit).
// Key: APOLLO_API_KEY. Docs: https://docs.apollo.io
//   POST /api/v1/mixed_people/api_search  -> people[] (id, first_name, last_name_obfuscated, title, organization, has_email)
//   POST /api/v1/people/match             -> person (email, email_status, name, linkedin_url, city/state/country, employment_history)

const BASE = "https://api.apollo.io/api/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const apolloKey = () => Deno.env.get("APOLLO_API_KEY") || "";

async function call(path: string, params: Record<string, unknown>) {
  const key = apolloKey();
  if (!key) throw new Error("Apollo isn't connected yet (APOLLO_API_KEY)");
  // Apollo documents these as query parameters; arrays use the key[] form.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k + "[]", String(x)));
    else qs.append(k, String(v));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}${path}?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": key },
      body: JSON.stringify(params),
    });
    if (res.status === 429) { await sleep(attempt === 0 ? 5000 : 20000); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Apollo " + res.status + ": " + String(data?.error || data?.message || "").slice(0, 200));
    return data;
  }
  throw new Error("Apollo is rate-limiting requests; try again in a minute");
}

export type ApolloHit = { id: string; first_name: string; title: string; company: string; has_email: boolean };

export async function searchPeople(opts: { titles: string[]; locations: string[]; perPage?: number; page?: number }): Promise<{ hits: ApolloHit[]; total: number }> {
  const data = await call("/mixed_people/api_search", {
    person_titles: opts.titles.slice(0, 10),
    include_similar_titles: false,
    person_locations: opts.locations.slice(0, 40),
    contact_email_status: ["verified"],
    per_page: Math.min(opts.perPage || 100, 100),
    page: opts.page || 1,
  });
  const hits = (Array.isArray(data?.people) ? data.people : []).map((p: any) => ({
    id: String(p.id || ""), first_name: String(p.first_name || ""), title: String(p.title || ""),
    company: String(p.organization?.name || p.organization_name || ""), has_email: p.has_email !== false,
  })).filter((p: ApolloHit) => p.id);
  return { hits, total: Number(data?.total_entries || data?.pagination?.total_entries || hits.length) };
}

export type ApolloPerson = {
  id: string; first_name: string; last_name: string; name: string; title: string; email: string; email_status: string;
  linkedin_url: string; city: string; state: string; country: string; company: string; domain: string; history: string;
};

function toPerson(p: any): ApolloPerson | null {
  if (!p) return null;
  const hist = (Array.isArray(p.employment_history) ? p.employment_history : []).slice(0, 6)
    .map((h: any) => `${h.title || "?"} at ${h.organization_name || "?"} (${String(h.start_date || "").slice(0, 7) || "?"} to ${h.current ? "now" : String(h.end_date || "").slice(0, 7) || "?"})`).join("; ");
  return {
    id: String(p.id || ""), first_name: String(p.first_name || ""), last_name: String(p.last_name || ""), name: String(p.name || ""),
    title: String(p.title || ""), email: String(p.email || ""), email_status: String(p.email_status || ""),
    linkedin_url: String(p.linkedin_url || ""), city: String(p.city || ""), state: String(p.state || ""), country: String(p.country || ""),
    company: String(p.organization?.name || ""), domain: String(p.organization?.primary_domain || p.organization?.website_url || ""), history: hist,
  };
}

// Reveal one person by Apollo id (1 credit when an email comes back).
export async function matchById(id: string): Promise<ApolloPerson | null> {
  const data = await call("/people/match", { id, reveal_personal_emails: false, reveal_phone_number: false });
  return toPerson(data?.person);
}

// Find a named person at a company (for a job poster whose email we don't have).
export async function matchByName(first: string, last: string, domain: string, company: string): Promise<ApolloPerson | null> {
  const data = await call("/people/match", { first_name: first, last_name: last, domain: domain || undefined, organization_name: domain ? undefined : company, reveal_personal_emails: false, reveal_phone_number: false });
  return toPerson(data?.person);
}

// ---- Sending through Apollo sequences ----------------------------------------------------
// Pronext writes each email itself; Apollo sends it from a linked mailbox (on the outreach
// domain, never pronextglobal.com) through a one-step sequence whose email is just
// {{Pronext subject}} / {{Pronext email}} — two contact custom fields Pronext fills per person.
//   APOLLO_SEQUENCE_ID          the sequence to add people to (client pitches: APOLLO_CLIENT_SEQUENCE_ID, optional)
//   APOLLO_MAILBOX_ID           optional; comma-separated for rotation. Default: every active linked
//                               mailbox not on pronextglobal.com.
//   APOLLO_BODY                 "html" (default, the branded email) or "text".
async function api(method: "GET" | "POST" | "PUT", path: string, body?: Record<string, unknown>, query?: URLSearchParams) {
  const key = apolloKey();
  if (!key) throw new Error("Apollo isn't connected yet (APOLLO_API_KEY)");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}${path}${query ? "?" + query : ""}`, {
      method,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": key },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await sleep(attempt === 0 ? 5000 : 20000); continue; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error("Apollo needs a Master API key for sending (Settings > Integrations > API > create a key with 'Set as master key').");
    if (!res.ok) throw new Error("Apollo " + res.status + ": " + String(data?.error || data?.message || "").slice(0, 200));
    return data;
  }
  throw new Error("Apollo is rate-limiting requests; try again in a minute");
}

export type ApolloMailbox = { id: string; email: string; active: boolean };
export async function apolloMailboxes(): Promise<ApolloMailbox[]> {
  const d = await api("GET", "/email_accounts");
  return (d?.email_accounts || []).map((a: any) => ({ id: String(a.id), email: String(a.email || ""), active: a.active !== false && !a.revoked_at }));
}
export async function apolloSequences(): Promise<{ id: string; name: string; active: boolean }[]> {
  const d = await api("POST", "/emailer_campaigns/search", { per_page: 100 });
  return (d?.emailer_campaigns || []).map((c: any) => ({ id: String(c.id), name: String(c.name || ""), active: !!c.active }));
}
export async function apolloFields(): Promise<{ id: string; name: string; type: string }[]> {
  const d = await api("GET", "/typed_custom_fields");
  return (d?.typed_custom_fields || d?.fields || []).filter((f: any) => !f.modality || f.modality === "contact")
    .map((f: any) => ({ id: String(f.id), name: String(f.name || f.label || ""), type: String(f.type || "") }));
}

const isSubjectField = (n: string) => /pronext/i.test(n) && /subject/i.test(n);
const isBodyField = (n: string) => /pronext/i.test(n) && /(email|body|message)/i.test(n) && !/subject/i.test(n);
let setupCache: { at: number; subj: string; body: string; mailboxes: string[] } | null = null;

async function sendSetup() {
  if (setupCache && Date.now() - setupCache.at < 10 * 60000) return setupCache;
  const fields = await apolloFields();
  const subj = fields.find((f) => isSubjectField(f.name))?.id || "";
  const body = fields.find((f) => isBodyField(f.name))?.id || "";
  if (!subj || !body) throw new Error("In Apollo, create two contact custom fields named 'Pronext subject' and 'Pronext email' (long text).");
  let mailboxes = String(Deno.env.get("APOLLO_MAILBOX_ID") || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!mailboxes.length) mailboxes = (await apolloMailboxes()).filter((m) => m.active && !/@pronextglobal\.com$/i.test(m.email)).map((m) => m.id);
  if (!mailboxes.length) throw new Error("No mailbox on your outreach domain is linked in Apollo yet (Settings > Mailboxes).");
  setupCache = { at: Date.now(), subj, body, mailboxes };
  return setupCache;
}

// What Pronext can see in Apollo, for the setup screen.
export async function apolloSendCheck() {
  const out: Record<string, unknown> = { key: !!apolloKey(), sequenceId: Deno.env.get("APOLLO_SEQUENCE_ID") || "" };
  try { out.mailboxes = await apolloMailboxes(); } catch (e) { out.mailboxesError = String((e as Error).message); }
  try { out.sequences = await apolloSequences(); } catch (e) { out.sequencesError = String((e as Error).message); }
  try {
    const f = await apolloFields();
    out.subjectField = f.find((x) => isSubjectField(x.name))?.name || null;
    out.bodyField = f.find((x) => isBodyField(x.name))?.name || null;
  } catch (e) { out.fieldsError = String((e as Error).message); }
  return out;
}

export async function sendViaApollo(m: { kind: string; to: string; firstName: string; lastName: string; company: string; subject: string; body: string; html?: string }): Promise<string> {
  const seq = (m.kind === "client" && Deno.env.get("APOLLO_CLIENT_SEQUENCE_ID")) || Deno.env.get("APOLLO_SEQUENCE_ID") || "";
  if (!seq) throw new Error("APOLLO_SEQUENCE_ID isn't set");
  const st = await sendSetup();
  const content = (Deno.env.get("APOLLO_BODY") || "html") === "text" || !m.html ? m.body : m.html;
  const c = await api("POST", "/contacts", {
    first_name: m.firstName || undefined, last_name: m.lastName || undefined, organization_name: m.company || undefined,
    email: m.to, run_dedupe: true, typed_custom_fields: { [st.subj]: m.subject, [st.body]: content },
  });
  const contactId = String(c?.contact?.id || c?.id || "");
  if (!contactId) throw new Error("Apollo didn't return a contact");
  const q = new URLSearchParams();
  q.set("emailer_campaign_id", seq);
  q.append("contact_ids[]", contactId);
  st.mailboxes.forEach((id) => q.append(st.mailboxes.length > 1 ? "send_email_from_email_account_id[]" : "send_email_from_email_account_id", id));
  q.set("sequence_unverified_email", "true");
  const r = await api("POST", `/emailer_campaigns/${encodeURIComponent(seq)}/add_contact_ids`, undefined, q);
  const skipped = r?.skipped_contact_ids || {};
  if (skipped && typeof skipped === "object" && contactId in skipped) throw new Error("Apollo skipped this person: " + String((skipped as any)[contactId]).slice(0, 120));
  return contactId;
}
