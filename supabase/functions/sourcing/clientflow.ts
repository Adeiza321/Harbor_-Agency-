// The client side of client sourcing.
//
//   Pitch page (/?t=s-<client token>): each candidate with the must-haves they meet and their blind
//   resume. Opening a blind resume shows the terms in a pop-up (no fee to interview; a fee only on
//   hire, 10% of annual gross salary, 20% off it for a first-time client): the client can close it
//   and read the blind resume, or sign our agreement to unlock the full resumes.
//   Signing (one signature per client company, covering every candidate we send them): typed name,
//   title, company, company address, email and "I'm authorised to sign"; stamped with date, time,
//   IP and device; countersigned at once by the Agency's point of contact. Then, automatically:
//     - each candidate: "<Client> likes your profile and wants to talk" (client copied; the first
//       time the candidate learns the employer's name);
//     - the client: their point of contact (default Ahmed), with "Book a call" or "tell us your
//       hiring timeline";
//     - each candidate, separately: congratulations and an estimated joining bonus (from the
//       salary; no amount when it isn't known).
//   After a hire: 7 days after the joining date the client is asked for feedback and whether to
//   make the arrangement permanent (we source every new role free, paid only on hire); permanent
//   clients get a monthly check-in for new roles.

import { pitchFacts, pitchRecipients } from "./queue.ts";
import { button, emailShell, esc, loadBrand, sendBrevo, type Brand } from "./brand.ts";
import { UK_ADDRESS } from "./common.ts";

const portalBase = () => (Deno.env.get("PORTAL_BASE_URL") || "https://recruitment.pronextglobal.com").replace(/\/+$/, "");
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const first = (n: unknown) => String(n || "").trim().split(/\s+/)[0] || "";
const p = (t: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${t}</p>`;
// Placements recorded before this went live never get the feedback email.
const FOLLOWUPS_FROM = "2026-10-23";

// Same as public.norm_company() in the database.
export const companyKey = (s: unknown) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")
  .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|plc|group|holdings|the)\b/g, "").replace(/\s+/g, " ").trim();

// ---- Settings ------------------------------------------------------------------------------------
export type Poc = { id: string | null; name: string; first: string; title: string; email: string; phone: string; photo: string | null; bookingUrl: string };
// The phone number shown to a client depends on where they are: the US number for US clients, the
// UK / Europe number for UK and European clients, none otherwise (never a person's own number).
export async function loadPoc(admin: any, region = ""): Promise<Poc> {
  const { data: set } = await admin.from("agency_settings").select("client_poc").limit(1).maybeSingle();
  const cfg = set?.client_poc || {};
  const { data: u } = cfg.userId ? await admin.from("profiles").select("id,full_name,email,phone,avatar_url,role").eq("id", cfg.userId).maybeSingle() : { data: null };
  const name = String(u?.full_name || "Ahmed Sanni").replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();
  const phones = cfg.phones || {};
  const phone = String((region === "US" ? phones.us : region === "EU" ? phones.eu : "") || "").trim();
  return { id: u?.id || null, name, first: first(name), title: cfg.title || (u?.role === "admin" ? "Client Partner" : "Recruitment Partner"), email: u?.email || "", phone,
    photo: u?.avatar_url || null, bookingUrl: String(cfg.bookingUrl || "").trim() };
}
export type Terms = { title: string; body: string; version: number; feePct: number; discountPct: number; effectivePct: number; firstTime: boolean };
export async function agreementFor(admin: any, company: string) {
  const { data } = await admin.from("client_agreements").select("*").eq("company_key", companyKey(company)).order("signed_at", { ascending: false }).limit(1);
  return (data || [])[0] || null;
}
// First-time client: nobody from that company has been placed by us before.
export async function isFirstTime(admin: any, company: string) {
  const key = companyKey(company);
  if (!key) return true;
  const { data: jobs } = await admin.from("jobs").select("id,client").ilike("client", "%" + key.split(" ")[0] + "%").limit(200);
  const ids = (jobs || []).filter((j: any) => companyKey(j.client) === key).map((j: any) => j.id);
  if (!ids.length) return true;
  const { count } = await admin.from("placements").select("id", { count: "exact", head: true }).in("job_id", ids).neq("status", "Fallout");
  return !count;
}
const pct = (n: number) => (Math.round(n * 100) / 100).toString().replace(/\.0+$/, "") + "%";
export async function termsFor(admin: any, company: string): Promise<Terms> {
  const { data: set } = await admin.from("agency_settings").select("client_agreement").limit(1).maybeSingle();
  const a = set?.client_agreement || {};
  const feePct = Number(a.feePct) > 0 ? Number(a.feePct) : 10, discountPct = Number(a.firstTimeDiscountPct) >= 0 ? Number(a.firstTimeDiscountPct ?? 20) : 20;
  const firstTime = await isFirstTime(admin, company);
  const effectivePct = firstTime ? feePct * (1 - discountPct / 100) : feePct;
  return { title: a.title || "Candidate Introduction Terms", body: String(a.body || ""), version: Number(a.version) || 1, feePct, discountPct, effectivePct, firstTime };
}
export function feeLine(t: Terms) {
  return `${pct(t.feePct)} of the candidate's annual gross salary` + (t.firstTime && t.discountPct ? ` (as a first-time client you get ${pct(t.discountPct)} off your first hire, so ${pct(t.effectivePct)})` : "");
}
export function fillTerms(t: Terms, v: { client: string; clientAddress: string; date: string; companyNo?: string }) {
  return t.body.replaceAll("{{client_company_no}}", v.companyNo ? ` (company number ${v.companyNo})` : "")
    .replaceAll("{{agency_company_no}}", "")
    .replaceAll("{{client}}", v.client).replaceAll("{{client_address}}", v.clientAddress || "[company address]").replaceAll("{{agency_address}}", UK_ADDRESS)
    .replaceAll("{{date}}", v.date).replaceAll("{{fee}}", pct(t.feePct))
    .replaceAll("{{discount}}", t.firstTime && t.discountPct ? ` As a first-time client, the Client receives a ${pct(t.discountPct)} discount on the Introduction Fee for the first Candidate it Engages under these Terms, so that fee is ${pct(t.effectivePct)} of the Remuneration.` : "");
}
const longDate = (d = new Date()) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// The agreement as email HTML (same layout as the page: "## " lines are headings).
export function termsHtml(body: string) {
  return String(body || "").split("\n").map((l) => /^##\s/.test(l)
    ? `<div style="margin:18px 0 6px;padding-bottom:3px;border-bottom:1px solid #E6E1D6;font-family:Georgia,serif;font-size:15px;color:#1F6F54;">${esc(l.replace(/^##\s+/, ""))}</div>`
    : l.trim() ? `<p style="margin:0 0 8px;font-size:13.5px;line-height:1.6;">${esc(l)}</p>` : "").join("");
}
const stamp = (t: unknown) => { try { return new Date(String(t)).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"; } catch { return String(t || ""); } };

// ---- The pitch page ----------------------------------------------------------------------------
// The candidates in a lead's pitch, with what the client may see: blind resume pages always;
// name, contact details and the full resume once the company has signed.
export async function shortlistFor(admin: any, l: any) {
  const ids: string[] = Array.isArray(l.data?.pitched) ? l.data.pitched.map(String) : [];
  const ms: any[] = Array.isArray(l.matches) ? l.matches : [];
  const ag = await agreementFor(admin, l.company);
  const { data: cands } = ids.length ? await admin.from("candidates").select("id,name,email,phone,linkedin_url,current_title,location,blind_pages,blind_checked_at,resume_path,cv_path").in("id", ids) : { data: [] };
  const out: any[] = [];
  for (const id of ids.slice(0, 5)) {
    const c = (cands || []).find((x: any) => x.id === id);
    const m = ms.find((x: any) => x.candidate_id === id) || {};
    const n = c && c.blind_checked_at ? Math.max(0, Math.min(12, Number(c.blind_pages) || 0)) : 0;
    let pages: string[] = [];
    if (n) {
      const { data: signed } = await admin.storage.from("blind-resumes").createSignedUrls(Array.from({ length: n }, (_, i) => `cand-${id}/${i + 1}.webp`), 600);
      pages = (signed || []).map((x: any) => x.signedUrl).filter(Boolean);
    }
    const musts = Array.isArray(m.musts) && m.musts.length ? m.musts : (m.bullets || []).map((b: string) => ({ item: b, evidence: "" }));
    out.push({ n: out.length + 1, verdict: m.verdict || "", fit: m.fit || null, musts, ...pitchFacts(m), bullets: Array.isArray(m.bullets) ? m.bullets.slice(0, 3) : [], pages,
      ...(ag && c ? { name: c.name, email: c.email || "", phone: c.phone || "", linkedin: c.linkedin_url || "", title: c.current_title || "", location: c.location || "", hasResume: !!(c.resume_path || c.cv_path) } : {}) });
  }
  return { candidates: out, agreement: ag };
}
// The full resume of candidate n (1-based), once the company has signed.
export async function fullResume(admin: any, l: any, n: number) {
  if (!(await agreementFor(admin, l.company))) throw new Error("Sign the agreement to unlock the full resume");
  const ids: string[] = Array.isArray(l.data?.pitched) ? l.data.pitched.map(String) : [];
  const id = ids[n - 1];
  if (!id) throw new Error("Candidate not found");
  const { data: c } = await admin.from("candidates").select("resume_path,cv_path").eq("id", id).maybeSingle();
  const path = c?.resume_path || c?.cv_path;
  if (!path) throw new Error("No resume on file");
  const { data: s } = await admin.storage.from(c?.resume_path ? "resumes" : "cvs").createSignedUrl(path, 600);
  if (!s?.signedUrl) throw new Error("Couldn't open the resume");
  return s.signedUrl;
}

// ---- Signing ---------------------------------------------------------------------------------------
export async function signForLead(admin: any, l: any, f: any, ip: string, ua: string) {
  const v = {
    name: clip(f?.name, 120), title: clip(f?.title, 120), company: clip(f?.company, 160) || l.company, address: String(f?.address || "").trim().slice(0, 400),
    email: clip(f?.email, 200).toLowerCase(), authorised: f?.authorised === true,
    companyNo: clip(f?.companyNo, 40), website: clip(f?.website, 200),
  };
  if (v.name.length < 3) throw new Error("Type your full name to sign");
  if (!v.title) throw new Error("Add your job title");
  if (v.companyNo.length < 3) throw new Error("Add your company number (company registration number)");
  if (v.address.length < 8) throw new Error("Add your company address");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) throw new Error("Add your work email");
  if (!v.authorised) throw new Error("Confirm you're authorised to sign on behalf of " + v.company);
  const existing = await agreementFor(admin, l.company);
  if (existing) return { agreement: existing, already: true };
  const t = await termsFor(admin, l.company);
  const poc = await loadPoc(admin, l.region || "");
  const now = new Date();
  const { data: ag, error } = await admin.from("client_agreements").insert({
    company_key: companyKey(l.company), company: v.company, lead_id: l.id, version: t.version, title: t.title,
    body: fillTerms(t, { client: v.company.toUpperCase(), clientAddress: v.address, date: longDate(now), companyNo: v.companyNo }),
    company_number: v.companyNo || null, website: v.website || null,
    fee_pct: t.effectivePct, first_time: t.firstTime, signer_name: v.name, signer_title: v.title, signer_email: v.email, company_address: v.address,
    ip: ip.slice(0, 80) || null, user_agent: ua.slice(0, 300) || null,
    agency_signer_name: poc.name, agency_signer_title: poc.title, agency_signed_at: now.toISOString(),
  }).select("*").single();
  if (error) throw new Error("Couldn't save your signature: " + error.message);
  await admin.from("leads").update({
    status: "replied", interested_at: now.toISOString(), contract_sent_at: now.toISOString(),
    notes: [l.notes, `Signed the agreement ${now.toISOString().slice(0, 10)}: ${v.name}, ${v.title}`].filter(Boolean).join("\n"),
    data: { ...(l.data || {}), agreement_id: ag.id, signer: { name: v.name, title: v.title, email: v.email } },
  }).eq("id", l.id);
  try { await afterSigned(admin, l, ag, poc); } catch (e) { console.error("after signing", String((e as Error)?.message || e)); }
  return { agreement: ag, already: false };
}

// Estimated joining bonus: 10% of our fee, worked out from the posting's pay ("$90,000 - $100,000 a
// year", "$45/hr", "80k-100k"). null when there's no usable salary.
export function bonusEstimate(salary: unknown, feePct: number): string | null {
  const s = String(salary || "");
  const nums = [...s.replace(/,/g, "").matchAll(/(\d+(?:\.\d+)?)\s*(k)?/gi)].map((m) => Number(m[1]) * (m[2] ? 1000 : 1)).filter((n) => n > 0);
  if (!nums.length) return null;
  let mid = nums.length > 1 ? (nums[0] + nums[1]) / 2 : nums[0];
  if (/hour|\/\s*hr|hourly/i.test(s)) mid *= 1920; // 40 hours x 4 weeks x 12
  else if (/month/i.test(s)) mid *= 12;
  else if (/week/i.test(s)) mid *= 52;
  if (mid < 5000) return null;
  const bonus = Math.round((mid * feePct / 100) * 0.1 / 10) * 10;
  if (!bonus) return null;
  const sym = (s.match(/[$£€₦]/) || [])[0] || "";
  const code = sym ? "" : ((s.match(/\b(USD|GBP|EUR|NGN|CAD|AUD|SAR|AED|MYR)\b/i) || [])[1] || "").toUpperCase();
  return (sym || (code ? code + " " : "")) + bonus.toLocaleString("en-US");
}

async function afterSigned(admin: any, l: any, ag: any, poc: Poc) {
  const b = await loadBrand(admin);
  const ids: string[] = Array.isArray(l.data?.pitched) ? l.data.pitched.map(String) : [];
  const { data: cands } = ids.length ? await admin.from("candidates").select("id,name,email,email_opt_out,portal_token").in("id", ids) : { data: [] };
  const { data: offers } = await admin.from("lead_offers").select("id,candidate_id,candidate_job_id").eq("lead_id", l.id).in("candidate_id", ids);
  const client = ag.company || l.company;
  const clientEmail = ag.signer_email || l.contact_email || "";
  const role = l.job_title || "the role", place = l.location || "";
  const bonus = bonusEstimate(l.salary, Number(ag.fee_pct) || 10);
  const pocLine = `${esc(poc.name)}${poc.title ? ", " + esc(poc.title) : ""}${poc.email ? " &middot; " + esc(poc.email) : ""}${poc.phone ? " &middot; " + esc(poc.phone) : ""}`;
  const reply = poc.email ? { email: poc.email, name: poc.name } : null;
  for (const c of cands || []) {
    const o = (offers || []).find((x: any) => x.candidate_id === c.id);
    const portal = c.portal_token ? `${portalBase()}/?c=${encodeURIComponent(c.portal_token)}` : "";
    if (o?.candidate_job_id) {
      await admin.from("candidate_jobs").update({ client_revealed: true, client_revealed_at: new Date().toISOString() }).eq("id", o.candidate_job_id);
      await admin.from("candidate_job_messages").insert({ link_id: o.candidate_job_id, sender: "recruiter", body: `Good news: ${client} has reviewed your profile for ${role} and would like to talk. Look out for next steps from them.${bonus ? " You also qualify for an estimated joining bonus of " + bonus + " if you're hired." : ""}`, staff_id: poc.id });
    }
    await admin.from("candidate_timeline").insert({ candidate_id: c.id, title: `${client} signed our terms and wants to talk (${role})`, done: true });
    if (!c.email || c.email_opt_out) continue;
    // 1. The employer wants to talk (client copied).
    await sendBrevo(b, { email: c.email, name: c.name }, `${client} likes your profile and wants to talk`, emailShell(b, `${client} wants to talk to you about ${role}`,
      p(`Hi ${esc(first(c.name))},`) +
      p(`Great news: <b>${esc(client)}</b>, the employer behind the <b>${esc(role)}</b> role${place ? " in " + esc(place) : ""}, has reviewed your profile and would like to talk to you.`) +
      p(`They're copied on this email, so please look out for next steps from them: usually an email or a call to arrange a first conversation.`) +
      p(`${esc(poc.first)} will coordinate with you and ${esc(client)} throughout. If anything comes up, just reply to this email.`) +
      (portal ? button(b, portal, "Open your candidate page") : "") + p(`<br>${esc(poc.first)}<br><span style="color:#56605A;font-size:13px;">${esc(b.legal || b.name)}</span>`)),
      undefined, { cc: clientEmail ? [{ email: clientEmail, name: ag.signer_name }] : [], replyTo: reply });
    // 2. Joining bonus (just the candidate).
    await sendBrevo(b, { email: c.email, name: c.name }, "Congratulations: you qualify for a joining bonus", emailShell(b, "You qualify for a joining bonus",
      p(`Hi ${esc(first(c.name))},`) +
      p(`Congratulations on getting ${esc(client)}'s interest for the ${esc(role)} role.`) +
      p(bonus ? `If you're hired by ${esc(client)}, you'll receive a joining bonus from us: an estimated <b>${esc(bonus)}</b>, worked out from the role's salary.` : `If you're hired by ${esc(client)}, you'll receive a joining bonus from us.`) +
      p(`So please stay responsive and keep us up to date at every step: interviews, feedback, offers and your start date. We'll follow up with ${esc(client)} on our side to help get it over the line.`) +
      (portal ? button(b, portal, "Open your candidate page") : "") + p(`<br>${esc(poc.first)}<br><span style="color:#56605A;font-size:13px;">${esc(b.legal || b.name)}</span>`)),
      undefined, { replyTo: reply });
  }
  // 3. A copy of the signed agreement to the person who signed and everyone at the client we
  //    pitched the role to (so the company knows it has signed: clause 14.3), the POC copied.
  try {
    const to = new Map<string, string>();
    if (clientEmail) to.set(clientEmail.toLowerCase(), ag.signer_name || "");
    for (const r of pitchRecipients(l)) if (r.email && !to.has(r.email.toLowerCase())) to.set(r.email.toLowerCase(), r.name || "");
    const sig = (who: string, name: string, title: string, at: unknown, extra = "") => `<td style="vertical-align:top;padding:10px 12px;border:1px solid #E6E1D6;border-radius:10px;font-size:13px;line-height:1.5;width:50%;"><div style="font-size:11px;letter-spacing:1px;color:#8A8578;">${who}</div><div style="font-family:Georgia,serif;font-size:18px;margin-top:4px;">${esc(name)}</div><div>${esc(title)}</div><div style="color:#56605A;">Signed ${esc(stamp(at))}${extra}</div></td>`;
    const html = emailShell(b, `Signed: ${ag.title || "Terms of Business"}`,
      p(`<b>${esc(ag.signer_name)}</b>${ag.signer_title ? " (" + esc(ag.signer_title) + ")" : ""} signed our ${esc(ag.title || "Terms of Business")} on behalf of <b>${esc(client)}</b> on ${esc(stamp(ag.signed_at))}. A copy is below for your records.`) +
      p(`If anything here is unexpected, or the person who signed wasn't authorised to sign for ${esc(client)}, please reply within 5 business days.`) +
      `<div style="margin:14px 0;padding:14px 16px;border:1px solid #E6E1D6;border-radius:12px;background:#FFFFFF;">${termsHtml(ag.body)}</div>` +
      `<table role="presentation" cellpadding="0" cellspacing="6" border="0" style="width:100%;"><tr>${sig("FOR THE AGENCY", ag.agency_signer_name || poc.name, ag.agency_signer_title || poc.title, ag.agency_signed_at || ag.signed_at)}${sig("FOR THE CLIENT", ag.signer_name, [ag.signer_title, client].filter(Boolean).join(", "), ag.signed_at, ag.ip ? " &middot; IP " + esc(ag.ip) : "")}</tr></table>`);
    for (const [email, name] of to) await sendBrevo(b, { email, name: name || undefined }, `Signed: ${ag.title || "Terms of Business"} (${client})`, html, undefined, { cc: poc.email ? [{ email: poc.email, name: poc.name }] : [], replyTo: reply });
    await admin.from("client_agreements").update({ copies_sent_to: [...to.keys()], copies_sent_at: new Date().toISOString() }).eq("id", ag.id);
  } catch (e) { console.error("signed copy", String((e as Error)?.message || e)); }

  // 4. The client: their point of contact, a call or their hiring timeline.
  if (clientEmail) {
    const page = `${portalBase()}/?t=s-${encodeURIComponent(l.client_token)}`;
    const many = ids.length > 1;
    await sendBrevo(b, { email: clientEmail, name: ag.signer_name }, `Next steps for your ${role} role`, emailShell(b, `Meet ${poc.first}, your point of contact`,
      p(`Hi ${esc(first(ag.signer_name))},`) +
      p(`Thank you for signing our terms. ${many ? "The candidates' full resumes are" : "The candidate's full resume is"} now unlocked, and ${many ? "they've" : "they've"} been told you'd like to talk.`) +
      button(b, page, many ? "View the full resumes" : "View the full resume") +
      `<div style="margin:18px 0 12px;padding:14px 16px;background:#F6F3EC;border-radius:12px;font-size:14px;line-height:1.6;">Your point of contact<br><b style="font-size:16px;">${pocLine}</b><br>${esc(poc.first)} will coordinate with ${many ? "the candidates" : "the candidate"} throughout: interviews, feedback and offers.</div>` +
      p(`<b>Would you like to talk it through?</b> ${poc.bookingUrl ? "Book a call with " + esc(poc.first) + " at a time that suits you." : "Reply to this email and " + esc(poc.first) + " will set up a call."}`) +
      (poc.bookingUrl ? button(b, poc.bookingUrl, "Book a call with " + poc.first) : "") +
      p(`<br><b>Prefer to manage ${many ? "the candidates" : "the candidate"} yourselves?</b> That's fine: just tell us your hiring timeline so we can keep ${many ? "them" : "them"} informed and manage expectations.`) +
      button(b, page + "&timeline=1", "Share your hiring timeline") +
      p(`<br>${esc(poc.first)}<br><span style="color:#56605A;font-size:13px;">${esc(b.legal || b.name)}</span>`)),
      undefined, { cc: poc.email ? [{ email: poc.email, name: poc.name }] : [], replyTo: reply });
  }
}

// The client's hiring timeline (if they manage the candidate themselves): saved and sent to the POC.
export async function saveTimeline(admin: any, l: any, text: string) {
  const t = String(text || "").trim().slice(0, 2000);
  if (t.length < 3) throw new Error("Tell us your hiring timeline");
  await admin.from("leads").update({ data: { ...(l.data || {}), timeline: { text: t, at: new Date().toISOString() } },
    notes: [l.notes, "Hiring timeline: " + t].filter(Boolean).join("\n") }).eq("id", l.id);
  const poc = await loadPoc(admin);
  if (poc.email) {
    const b = await loadBrand(admin);
    await sendBrevo(b, { email: poc.email, name: poc.name }, `${l.company}: hiring timeline for ${l.job_title}`, emailShell(b, "Hiring timeline",
      p(`${esc(l.company)} shared their hiring timeline for <b>${esc(l.job_title)}</b>:`) + `<div style="padding:12px 14px;background:#F6F3EC;border-radius:10px;font-size:14px;white-space:pre-wrap;">${esc(t)}</div>`), undefined);
  }
  return { ok: true };
}

// "Discuss these terms": the client asks for a call about the agreement, or suggests a change.
// Saved on the lead and emailed to the point of contact, who replies straight to the client.
export async function discussTerms(admin: any, l: any, f: any) {
  const v = { name: clip(f?.name, 120), email: clip(f?.email, 200).toLowerCase(), when: clip(f?.when, 200), message: String(f?.message || "").trim().slice(0, 3000) };
  if (v.name.length < 2) throw new Error("Add your name");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) throw new Error("Add your work email");
  if (v.message.length < 3) throw new Error("Tell us what you'd like to discuss or change");
  const at = new Date().toISOString();
  const list = Array.isArray(l.data?.terms_discussions) ? l.data.terms_discussions : [];
  await admin.from("leads").update({ data: { ...(l.data || {}), terms_discussions: [...list, { ...v, at }].slice(-20) },
    notes: [l.notes, `Asked to discuss the terms ${at.slice(0, 10)} (${v.name}): ${v.message.slice(0, 300)}`].filter(Boolean).join("\n") }).eq("id", l.id);
  const poc = await loadPoc(admin, l.region || "");
  if (poc.email) {
    const b = await loadBrand(admin);
    await sendBrevo(b, { email: poc.email, name: poc.name }, `${l.company}: wants to discuss the terms (${l.job_title})`, emailShell(b, "Discuss the terms",
      p(`<b>${esc(v.name)}</b> (${esc(v.email)}) at <b>${esc(l.company)}</b> would like to discuss our terms for the <b>${esc(l.job_title)}</b> role.`) +
      `<div style="padding:12px 14px;background:#F6F3EC;border-radius:10px;font-size:14px;white-space:pre-wrap;">${esc(v.message)}</div>` +
      (v.when ? p(`<br>Times that suit them: <b>${esc(v.when)}</b>`) : "") +
      p(`<br>Reply to this email to answer them or arrange a call. Any change we agree must be in writing (clause 2.3).`)),
      undefined, { replyTo: { email: v.email, name: v.name } });
  }
  return { ok: true, poc: poc.first || poc.name };
}

// ---- After a hire: feedback, permanent arrangement, monthly check-ins ----------------------------
async function relationFor(admin: any, company: string, contactName: string, contactEmail: string) {
  const key = companyKey(company);
  const { data: cur } = await admin.from("client_relations").select("*").eq("company_key", key).maybeSingle();
  if (cur) {
    if (contactEmail && !cur.contact_email) await admin.from("client_relations").update({ contact_email: contactEmail, contact_name: contactName || cur.contact_name }).eq("id", cur.id);
    return { ...cur, contact_email: cur.contact_email || contactEmail, contact_name: cur.contact_name || contactName };
  }
  const { data } = await admin.from("client_relations").insert({ company_key: key, company, contact_name: contactName || null, contact_email: contactEmail || null }).select("*").single();
  return data;
}
async function clientContact(admin: any, jobId: string | null, company: string) {
  const ag = await agreementFor(admin, company);
  if (ag?.signer_email) return { name: ag.signer_name, email: ag.signer_email };
  if (jobId) {
    const { data: l } = await admin.from("leads").select("contact_name,contact_email").eq("converted_job_id", jobId).not("contact_email", "is", null).limit(1).maybeSingle();
    if (l?.contact_email) return { name: l.contact_name || "", email: l.contact_email };
  }
  const { data: rel } = await admin.from("client_relations").select("contact_name,contact_email").eq("company_key", companyKey(company)).maybeSingle();
  return rel?.contact_email ? { name: rel.contact_name || "", email: rel.contact_email } : null;
}

// Every 10 minutes (sourcing tick).
export async function stepClientFollowups(admin: any) {
  const out = { feedback: 0, checkins: 0, skipped: 0 };
  const b = await loadBrand(admin);
  const poc = await loadPoc(admin);
  const reply = poc.email ? { email: poc.email, name: poc.name } : null;
  // 1. A week after the joining date: how is it going, and make it permanent?
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const { data: due } = await admin.from("placements").select("id,candidate_name,job_id,start_date,status,feedback_token,created_at")
    .is("feedback_sent_at", null).is("feedback_note", null).lte("start_date", weekAgo).gte("created_at", FOLLOWUPS_FROM).neq("status", "Fallout").limit(10);
  for (const pl of due || []) {
    const { data: job } = pl.job_id ? await admin.from("jobs").select("client,role_title").eq("id", pl.job_id).maybeSingle() : { data: null };
    const company = job?.client || "";
    const who = company ? await clientContact(admin, pl.job_id, company) : null;
    if (!who?.email) { await admin.from("placements").update({ feedback_note: "No client email to ask for feedback" }).eq("id", pl.id); out.skipped++; continue; }
    await relationFor(admin, company, who.name, who.email);
    const page = `${portalBase()}/?t=f-${encodeURIComponent(pl.feedback_token)}`;
    const stars = [5, 4, 3, 2, 1].map((n) => `<a href="${esc(page + "&r=" + n)}" style="display:inline-block;margin:0 4px 6px 0;padding:8px 12px;border:1px solid #E6E1D6;border-radius:9px;color:#14201B;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;">${"&#9733;".repeat(n)}</a>`).join("");
    const sent = await sendBrevo(b, { email: who.email, name: who.name }, `How is ${first(pl.candidate_name)} settling in?`, emailShell(b, "A quick question about your new hire",
      p(`Hi ${esc(first(who.name)) || "there"},`) +
      p(`It's been a week since ${esc(pl.candidate_name)} joined you as ${esc(job?.role_title || "your new hire")}. How are we doing? We'd really value your feedback.`) +
      `<div style="margin:6px 0 14px;">${stars}</div>` +
      p(`<b>Would you like to make our arrangement permanent?</b> Send us any new role and we'll source it for free. There's no retainer: we're only paid when we fill a role for you.`) +
      button(b, page, "Share feedback") + p(`<br>${esc(poc.first)}<br><span style="color:#56605A;font-size:13px;">${esc(b.legal || b.name)}</span>`)),
      undefined, { replyTo: reply });
    await admin.from("placements").update(sent ? { feedback_sent_at: new Date().toISOString() } : { feedback_note: "Feedback email didn't send" }).eq("id", pl.id);
    if (sent) out.feedback++;
  }
  // 2. Monthly check-in with clients who made it permanent.
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: rels } = await admin.from("client_relations").select("*").eq("permanent", true).not("contact_email", "is", null).limit(50);
  for (const r of rels || []) {
    const last = r.last_checkin_at || r.permanent_at;
    if (last && last > monthAgo) continue;
    const page = `${portalBase()}/?t=r-${encodeURIComponent(r.token)}`;
    const sent = await sendBrevo(b, { email: r.contact_email, name: r.contact_name || undefined }, `Any new roles we can fill for ${r.company}?`, emailShell(b, "Any new roles?",
      p(`Hi ${esc(first(r.contact_name)) || "there"},`) +
      p(`Just checking in: is there a new role we can fill for ${esc(r.company)}? As agreed, we'll source it for free and we're only paid when we fill it.`) +
      button(b, page, "Send us a role") + p(`Or just reply with the details.`) + p(`<br>${esc(poc.first)}<br><span style="color:#56605A;font-size:13px;">${esc(b.legal || b.name)}</span>`)),
      undefined, { replyTo: reply });
    if (sent) { await admin.from("client_relations").update({ last_checkin_at: new Date().toISOString() }).eq("id", r.id); out.checkins++; }
  }
  return out;
}

// The feedback page (/?t=f-<token>).
export async function feedbackGet(admin: any, token: string) {
  const { data: pl } = await admin.from("placements").select("id,candidate_name,job_id").eq("feedback_token", token).maybeSingle();
  if (!pl) throw new Error("Link not found");
  const { data: job } = pl.job_id ? await admin.from("jobs").select("client,role_title").eq("id", pl.job_id).maybeSingle() : { data: null };
  const { data: rel } = job?.client ? await admin.from("client_relations").select("permanent,feedback").eq("company_key", companyKey(job.client)).maybeSingle() : { data: null };
  const mine = (Array.isArray(rel?.feedback) ? rel.feedback : []).find((f: any) => f.placementId === pl.id) || null;
  return { candidate: first(pl.candidate_name), role: job?.role_title || "", company: job?.client || "", permanent: rel?.permanent ?? null, submitted: mine };
}
export async function feedbackSubmit(admin: any, token: string, f: any) {
  const { data: pl } = await admin.from("placements").select("id,candidate_name,job_id").eq("feedback_token", token).maybeSingle();
  if (!pl) throw new Error("Link not found");
  const { data: job } = pl.job_id ? await admin.from("jobs").select("client,role_title").eq("id", pl.job_id).maybeSingle() : { data: null };
  if (!job?.client) throw new Error("Link not found");
  const rating = Math.max(1, Math.min(5, Math.round(Number(f?.rating) || 0)));
  const comment = String(f?.comment || "").trim().slice(0, 2000);
  const permanent = f?.permanent === true ? true : f?.permanent === false ? false : null;
  const who = await clientContact(admin, pl.job_id, job.client);
  const rel = await relationFor(admin, job.client, who?.name || "", who?.email || "");
  const fb = [...(Array.isArray(rel.feedback) ? rel.feedback : []).filter((x: any) => x.placementId !== pl.id), { placementId: pl.id, candidate: pl.candidate_name, role: job.role_title, rating, comment, at: new Date().toISOString() }];
  await admin.from("client_relations").update({ feedback: fb, ...(permanent !== null ? { permanent, permanent_at: permanent ? new Date().toISOString() : null } : {}) }).eq("id", rel.id);
  const poc = await loadPoc(admin);
  if (poc.email) {
    const b = await loadBrand(admin);
    await sendBrevo(b, { email: poc.email, name: poc.name }, `${job.client} feedback: ${"★".repeat(rating)}${permanent ? " · made it permanent" : ""}`, emailShell(b, "Client feedback",
      p(`<b>${esc(job.client)}</b> rated us ${rating}/5 for ${esc(pl.candidate_name)} (${esc(job.role_title)}).`) + (comment ? `<div style="padding:12px 14px;background:#F6F3EC;border-radius:10px;font-size:14px;white-space:pre-wrap;">${esc(comment)}</div>` : "") +
      p(permanent === true ? "They'd like to make the arrangement permanent: they'll get a monthly check-in for new roles." : permanent === false ? "They don't want a permanent arrangement for now." : "")), undefined);
  }
  return { ok: true };
}
// The monthly check-in page (/?t=r-<token>): send us a role.
export async function relationGet(admin: any, token: string) {
  const { data: r } = await admin.from("client_relations").select("company,permanent").eq("token", token).maybeSingle();
  if (!r) throw new Error("Link not found");
  return { company: r.company, permanent: r.permanent };
}
export async function relationRequest(admin: any, token: string, f: any) {
  const { data: r } = await admin.from("client_relations").select("*").eq("token", token).maybeSingle();
  if (!r) throw new Error("Link not found");
  const req = { title: clip(f?.title, 160), location: clip(f?.location, 160), details: String(f?.details || "").trim().slice(0, 4000), at: new Date().toISOString() };
  if (!req.title) throw new Error("Add the job title");
  await admin.from("client_relations").update({ requests: [...(Array.isArray(r.requests) ? r.requests : []), req] }).eq("id", r.id);
  // A draft job for Rec Ops / Admins to review and open.
  await admin.from("jobs").insert({ role_title: req.title, client: r.company, location: req.location || null, description: req.details || null, status: "Draft" });
  const poc = await loadPoc(admin);
  if (poc.email) {
    const b = await loadBrand(admin);
    await sendBrevo(b, { email: poc.email, name: poc.name }, `New role from ${r.company}: ${req.title}`, emailShell(b, "New role",
      p(`<b>${esc(r.company)}</b> sent a new role: <b>${esc(req.title)}</b>${req.location ? " (" + esc(req.location) + ")" : ""}. It's saved as a draft job under Jobs.`) +
      (req.details ? `<div style="padding:12px 14px;background:#F6F3EC;border-radius:10px;font-size:14px;white-space:pre-wrap;">${esc(req.details)}</div>` : "")), undefined);
  }
  return { ok: true };
}
