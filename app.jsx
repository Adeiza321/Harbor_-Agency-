import React, { useState, useEffect } from "react";
import {
  LayoutDashboard, Users, Inbox as InboxIcon, Briefcase, TrendingUp, Send,
  CreditCard, Megaphone, Search, Bell, ChevronDown, ChevronRight, ChevronLeft,
  Plus, Download, Filter, Upload, Check, X, Lock, Copy, MessageSquare,
  Sparkles, AlertTriangle, Mail, MapPin, Clock, Settings, Shield,
  Phone, CheckCircle2, MoreHorizontal, UserPlus, Pencil, Info,
} from "lucide-react";

/* Design tokens */
const C = {
  canvas: "#F3EFE7", card: "#FFFFFF", ink: "#14201B", ink2: "#56605A",
  ink3: "#8C948E", line: "#E6E1D6", side: "#12241D", lime: "#C8F169",
  em: "#1F6F54", emTint: "#DDEFE6", warnBg: "#FBEFD8", warnFg: "#A5670A",
  dangerBg: "#FBE4DD", dangerFg: "#B8432A", infoBg: "#E5E8FB", infoFg: "#3B4BB8",
  neutralBg: "#EFEBE1", neutralFg: "#56605A",
};
const SERIF = { fontFamily: '"Iowan Old Style","Palatino Linotype",Georgia,serif' };
const TONE = {
  em: { bg: C.emTint, fg: C.em }, warn: { bg: C.warnBg, fg: C.warnFg },
  danger: { bg: C.dangerBg, fg: C.dangerFg }, info: { bg: C.infoBg, fg: C.infoFg },
  neutral: { bg: C.neutralBg, fg: C.neutralFg },
};
const STATUS_TONE = {
  Interview: "info", "With client": "info", "In review": "warn",
  "Active file": "neutral", Placed: "em", Rejected: "danger", Hired: "em",
  Open: "info", Engaged: "em", Closing: "warn", Closed: "neutral",
  Guarantee: "warn", Ready: "em", Invoiced: "info", Paid: "em", Fallout: "danger",
  Sent: "em", Scheduled: "info", Draft: "neutral", Live: "em",
  "Pending approval": "warn", Ended: "neutral", Active: "em", Invited: "warn",
};

/* Mock data */
const PEOPLE_TONE = { AN: "em", TR: "warn", PN: "info", JW: "danger", LF: "neutral", KM: "neutral", MO: "info" };

const CHANNEL_TONE = { LI: { bg: "#E5E8FB", fg: "#3B4BB8" }, FB: { bg: "#EEEBFB", fg: "#6B4FD6" }, GA: { bg: "#FBEFD8", fg: "#A5670A" }, GJ: { bg: "#DDEFE6", fg: "#1F6F54" } };
const CHANNEL_NAME = { LI: "LinkedIn", FB: "Facebook", GA: "Google Ads", GJ: "Google for Jobs" };

/* ===== Backend: Supabase over plain REST ===== */
const SB_URL = "https://acjmsihvvupqiikxckho.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w";
const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : "id" + Date.now() + Math.random().toString(16).slice(2));
async function sbFetch(path, { method = "GET", body, token, prefer } = {}) {
  const r = await fetch(SB_URL + path, { method, headers: { apikey: SB_KEY, Authorization: "Bearer " + (token || SB_KEY), "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = { message: t }; }
  if (!r.ok) throw new Error((j && (j.message || j.msg || j.error_description || j.error)) || r.statusText);
  return j;
}
const store = { get: () => { try { return JSON.parse(localStorage.getItem("harbor.session") || "null"); } catch (e) { return null; } }, set: (v) => { try { if (v) localStorage.setItem("harbor.session", JSON.stringify(v)); else localStorage.removeItem("harbor.session"); } catch (e) {} } };
const toSession = (j) => ({ token: j.access_token, refresh: j.refresh_token, uid: j.user.id, exp: Date.now() + j.expires_in * 1000 });
const signIn = async (email, password) => toSession(await sbFetch("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } }));
const refreshSession = async (s) => toSession(await sbFetch("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: s.refresh } }));

const ROLE_KEY_LABEL = { admin: "Admin", recops: "Rec Ops manager", recruiter: "Recruiter" };
const initialsOf = (n) => (n || "?").split(/[ @.]/).filter(Boolean).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
const fdate = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const ago = (d) => { const m = (Date.now() - new Date(d)) / 60000; return m < 60 ? Math.max(1, Math.round(m)) + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : m < 10080 ? Math.round(m / 1440) + "d ago" : fdate(d); };
// Formats a span of milliseconds as a short duration ("42m", "3.2h", "6.5d") for the job engagement log.
const formatDuration = (ms) => { const mins = ms / 60000; if (mins < 60) return Math.max(1, Math.round(mins)) + "m"; const hrs = mins / 60; if (hrs < 24) return hrs.toFixed(1) + "h"; return (hrs / 24).toFixed(1) + "d"; };
const naira = (n) => "\u20A6" + Number(n || 0).toLocaleString("en-NG");
/* Builds a CSV client-side and triggers a browser download \u2014 no server round-trip needed. */
function downloadCsv(filename, headers, rows) {
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [headers.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
// Sums placement fees per currency (mixed-currency totals can't be added together) and
// joins them for display, e.g. "\u20A64,000,000" or "\u20A64,000,000 + $1,200" when currencies differ.
const sumByCurrency = (placements, numKey, curKey) => {
  const totals = {};
  placements.forEach((p) => { const cur = p[curKey] || "NGN"; totals[cur] = (totals[cur] || 0) + (p[numKey] || 0); });
  const entries = Object.entries(totals).filter(([, v]) => v);
  if (entries.length === 0) return naira(0);
  return entries.map(([cur, v]) => money(v, cur)).join(" + ");
};
/* Money in a job's own currency (jobs.currency, ISO code). Falls back to naira. */
const money = (n, cur) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "NGN", maximumFractionDigits: 0 }).format(Number(n || 0)); } catch (e) { return naira(n); } };
const curSymbol = (cur) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).formatToParts(0).find((p) => p.type === "currency").value; } catch (e) { return cur; } };
/* Suggests a client fee + recruiter incentive for a placement, from the job's
   billing/incentive settings and (for a % fee) the candidate's salary. Both
   figures are only a starting point — always editable before saving. */
function suggestBilling(job, candidatePay) {
  if (!job) return { fee: "", feeCurrency: "NGN", incentive: "", incentiveCurrency: "NGN" };
  const salary = num(candidatePay) || job.maxPay || job.minPay || 0;
  const fee = job.billingType === "flat" ? (job.billingAmount || 0) : Math.round((salary * (job.billingAmount || 0)) / 100);
  const feeCurrency = job.billingType === "flat" ? (job.billingCurrency || "NGN") : (job.currency || "NGN");
  const incentive = job.incentiveType === "flat" ? (job.incentiveAmount || 0) : Math.round((fee * (job.incentiveAmount || 0)) / 100);
  const incentiveCurrency = job.incentiveType === "flat" ? (job.incentiveCurrency || "NGN") : feeCurrency;
  return { fee: fee || "", feeCurrency, incentive: incentive || "", incentiveCurrency };
}
/* Resume formats the AI reads (see supabase/functions/ai-screen/resume.ts). */
const RESUME_ACCEPT = ".pdf,.doc,.docx,.odt,.rtf,.txt,.jpg,.jpeg,.png,.webp,.heic,.heif";
const RESUME_TYPES = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", odt: "application/vnd.oasis.opendocument.text", rtf: "application/rtf", txt: "text/plain", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
const resumeMime = (name, fallback) => RESUME_TYPES[((name.match(/\.([A-Za-z0-9]+)$/) || [])[1] || "").toLowerCase()] || fallback || "application/octet-stream";
const PIPELINE_STAGES = ["Sourced", "In review", "Screening", "Submitted", "Interview", "Offer", "Placed", "Rejected", "Withdrawn"];
/* A Google Calendar "quick add" link — no OAuth needed, just opens their calendar pre-filled. */
const gcalUrl = (job, candidateName) => "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent("Interview: " + candidateName + " – " + job.role) + "&details=" + encodeURIComponent("Interview for " + job.role + " at " + job.client + " with " + candidateName + ".");
const CURRENCIES = ["NGN", "USD", "GBP", "EUR", "CAD", "AUD", "ZAR", "KES", "GHS", "AED", "INR"];
/* Picking a hiring country pre-selects its usual currency (still overridable). */
const COUNTRY_CURRENCY = { Nigeria: "NGN", "United States": "USD", "United Kingdom": "GBP", Canada: "CAD", Ghana: "GHS", Kenya: "KES", "South Africa": "ZAR", "United Arab Emirates": "AED", Germany: "EUR", Ireland: "EUR", Netherlands: "EUR", France: "EUR", India: "INR", Australia: "AUD", "Remote \u2013 worldwide": "" };
/* City/state suggestions for the "City / state" field, keyed by hiring country. Just a
   starting-point list for the datalist \u2014 typing anything else is still fine. */
const CITY_STATE_OPTIONS = {
  Nigeria: ["Lagos, Lagos State", "Abuja, FCT", "Port Harcourt, Rivers State", "Kano, Kano State", "Ibadan, Oyo State",
    "Kaduna, Kaduna State", "Enugu, Enugu State", "Benin City, Edo State", "Abeokuta, Ogun State", "Uyo, Akwa Ibom State",
    "Warri, Delta State", "Asaba, Delta State", "Owerri, Imo State", "Calabar, Cross River State", "Jos, Plateau State",
    "Ilorin, Kwara State", "Akure, Ondo State", "Abakaliki, Ebonyi State", "Awka, Anambra State", "Makurdi, Benue State",
    "Minna, Niger State", "Sokoto, Sokoto State", "Maiduguri, Borno State", "Bauchi, Bauchi State", "Gombe, Gombe State",
    "Yola, Adamawa State", "Jalingo, Taraba State", "Lafia, Nasarawa State", "Lokoja, Kogi State", "Osogbo, Osun State",
    "Ado Ekiti, Ekiti State", "Umuahia, Abia State", "Yenagoa, Bayelsa State", "Dutse, Jigawa State",
    "Birnin Kebbi, Kebbi State", "Gusau, Zamfara State", "Damaturu, Yobe State", "Katsina, Katsina State"],
  "United States": ["New York, NY", "Los Angeles, CA", "Chicago, IL", "Houston, TX", "San Francisco, CA", "Austin, TX",
    "Seattle, WA", "Boston, MA", "Atlanta, GA", "Miami, FL", "Denver, CO", "Remote, US"],
  "United Kingdom": ["London", "Manchester", "Birmingham", "Leeds", "Glasgow", "Edinburgh", "Bristol", "Liverpool", "Remote, UK"],
  Canada: ["Toronto, ON", "Vancouver, BC", "Montreal, QC", "Calgary, AB", "Ottawa, ON", "Edmonton, AB", "Remote, Canada"],
  Ghana: ["Accra, Greater Accra", "Kumasi, Ashanti", "Tamale, Northern", "Takoradi, Western"],
  Kenya: ["Nairobi", "Mombasa", "Kisumu", "Nakuru"],
  "South Africa": ["Johannesburg, Gauteng", "Cape Town, Western Cape", "Durban, KwaZulu-Natal", "Pretoria, Gauteng"],
  "United Arab Emirates": ["Dubai", "Abu Dhabi", "Sharjah"],
  Germany: ["Berlin", "Munich", "Frankfurt", "Hamburg", "Cologne"],
  Ireland: ["Dublin", "Cork", "Galway"],
  Netherlands: ["Amsterdam", "Rotterdam", "The Hague", "Utrecht"],
  France: ["Paris", "Lyon", "Marseille", "Toulouse"],
  India: ["Bengaluru, Karnataka", "Mumbai, Maharashtra", "Delhi", "Hyderabad, Telangana", "Pune, Maharashtra", "Chennai, Tamil Nadu"],
  Australia: ["Sydney, NSW", "Melbourne, VIC", "Brisbane, QLD", "Perth, WA", "Remote, Australia"],
};
const num = (x) => Number(String(x || "").replace(/[^0-9.]/g, "")) || 0;
const DEFAULT_NOTIF_PREFS = { newCandidate: true, screeningReady: true, placementRecorded: true, jobPosted: true };
const mapUser = (p) => ({ id: p.id, name: p.full_name || p.email, role: ROLE_KEY_LABEL[p.role] || p.level, roleKey: p.role, email: p.email, status: p.status, phone: p.phone || "", avatarUrl: p.avatar_url || null, notificationPrefs: { ...DEFAULT_NOTIF_PREFS, ...(p.notification_prefs || {}) }, isOwner: !!p.is_owner });

function mapAll(d) {
  const pm = {}; d.profiles.forEach((p) => (pm[p.id] = p));
  const pname = (id) => (pm[id] ? pm[id].full_name || pm[id].email : "");
  // Draft candidates (created mid-way through "Add candidate", not yet Submitted) stay
  // out of every normal list — the whole point of a draft is that nobody sees it, not
  // even Admin/Rec Ops, until it's submitted. The "Add candidate" flow tracks its own
  // draft in local state, so it never needs to find it in here.
  const cands = d.candidates.filter((c) => !c.is_draft).map((c) => ({
    id: c.id, name: c.name, role: c.role_title, location: c.location, recruiterId: c.recruiter_id,
    recruiter: c.recruiter_id ? pname(c.recruiter_id) : null, recruiterInit: c.recruiter_id ? initialsOf(pname(c.recruiter_id)) : "",
    status: c.status, ai: c.ai_score || 0, email: c.email_verified ? "Verified" : "Unverified", emailAddr: c.email || "", phone: c.phone || "", opens: c.opens,
    activity: ago(c.updated_at), createdAt: new Date(c.created_at).getTime(), updatedAt: c.updated_at ? new Date(c.updated_at).getTime() : new Date(c.created_at).getTime(), experience: c.experience || "-", notice: c.notice || "-", pay: c.pay || "-",
    skills: c.skills || [], strengths: c.strengths || [], gaps: c.gaps || [], screening: c.screening || { state: "pending" }, matches: c.matches || [], portal: c.portal_token, source: c.source, cv: c.resume_path || c.cv_path || null, cvName: c.resume_name || null,
    ai_locked: !!c.ai_locked, ai_locked_reason: c.ai_locked_reason || "", isDraft: !!c.is_draft,
    industries: Array.isArray(c.industries) ? c.industries : [], industriesAt: c.industries_checked_at || null,
    jobLinks: (c.candidate_jobs || []).map((l) => ({ id: l.id, jobId: l.job_id, stage: l.stage, fit: l.fit, screeningAnswers: l.screening_answers || [], ai: l.ai || {}, response: l.candidate_response || "accepted", createdAt: l.created_at ? new Date(l.created_at).getTime() : 0, submittedAt: l.submitted_at ? new Date(l.submitted_at).getTime() : null })),
    endorsed: (c.candidate_endorsements || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((e) => ({ company: e.company, role: e.role_title, by: fdate(e.created_at) + " by " + pname(e.endorsed_by).split(" ")[0], status: e.status, next: e.next_step || "" })),
    comments: (c.candidate_comments || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((m) => ({ who: pname(m.author_id).split(" ")[0], role: ROLE_KEY_LABEL[(pm[m.author_id] || {}).role] || "", init: initialsOf(pname(m.author_id)), tone: "info", when: fdate(m.created_at), text: m.body })),
    timeline: (c.candidate_timeline || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((t) => ({ t: t.title, d: fdate(t.created_at), done: t.done, at: new Date(t.created_at).getTime() })),
  }));
  const ends = d.candidates.flatMap((c) => c.candidate_endorsements || []);
  const jobs = d.jobs.map((j) => { const en = ends.filter((e) => e.company === j.client && e.role_title === j.role_title); const links = j.candidate_jobs || [];
    const active = links.filter((l) => l.stage !== "Rejected" && l.stage !== "Withdrawn");
    return { id: j.id, role: j.role_title, client: j.client, description: j.description || "", location: j.location || "", workSetup: j.work_setup || "", minPay: j.min_pay, maxPay: j.max_pay, currency: j.currency || "NGN", country: j.country || "", seo: j.seo || null, createdAt: j.created_at ? new Date(j.created_at).getTime() : Date.now(), screeningQuestions: j.screening_questions || [],
      salaryPeriod: j.salary_period || "Yearly", commissionOnly: !!j.commission_only, employmentType: j.employment_type || "", headcount: j.headcount != null ? j.headcount : 1,
      billingFrequency: j.billing_frequency || "One-off", billingMonths: j.billing_months,
      incentiveFrequency: j.incentive_frequency || "One-off", incentiveMonths: j.incentive_months,
      billingType: j.billing_type || "percent", billingAmount: j.billing_amount, billingCurrency: j.billing_currency || j.currency || "NGN",
      incentiveType: j.incentive_type || "percent", incentiveAmount: j.incentive_amount, incentiveCurrency: j.incentive_currency || j.currency || "NGN",
      recruiters: (j.job_recruiters || []).map((r) => initialsOf(pname(r.recruiter_id))),
      submitted: new Set([...en.map((e) => e.candidate_id), ...active.map((l) => l.candidate_id)]).size,
      interview: new Set([...en.filter((e) => e.status === "Interview").map((e) => e.candidate_id), ...links.filter((l) => l.stage === "Interview").map((l) => l.candidate_id)]).size, days: Math.floor((Date.now() - new Date(j.created_at)) / 864e5), status: j.status, link: "harbor.link/j/" + j.link_slug }; });
  const inbox = d.applications.map((a) => ({ id: a.id, name: a.name, role: a.role_title, source: a.source || "-", ai: a.ai_score || 0, when: ago(a.created_at), assigned: a.assigned_to ? initialsOf(pname(a.assigned_to)) : null, assignedId: a.assigned_to, candidateId: a.candidate_id }));
  const today = new Date();
  const placements = d.placements.map((p) => ({ id: p.id, name: p.candidate_name, role: p.role_desc, candidateId: p.candidate_id, jobId: p.job_id, recruiterId: p.recruiter_id, recruiter: initialsOf(pname(p.recruiter_id)), fee: money(p.fee, p.fee_currency), feeNum: Number(p.fee), feeCurrency: p.fee_currency || "NGN", incentive: p.recruiter_incentive != null ? money(p.recruiter_incentive, p.recruiter_incentive_currency || p.fee_currency) : null, incentiveNum: p.recruiter_incentive != null ? Number(p.recruiter_incentive) : null, guarantee: p.guarantee_ends ? (new Date(p.guarantee_ends) > today ? "Ends " : "Cleared ") + fdate(p.guarantee_ends) : "-", status: p.status, createdAt: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
    startDate: p.start_date || null, guaranteeDays: p.guarantee_days != null ? p.guarantee_days : null, guaranteeEnds: p.guarantee_ends || null,
    billedAt: p.billed_at ? new Date(p.billed_at).getTime() : null, invoice: p.invoice || {}, incentiveCurrency: p.recruiter_incentive_currency || p.fee_currency || "NGN" }));
  const campaigns = d.campaigns.map((c) => ({ id: c.id, name: c.name, meta: pname(c.created_by).split(" ")[0] + " \u00b7 " + fdate(c.created_at), audience: c.audience ? c.audience.toLocaleString() : "-", delivered: c.delivered ? c.delivered.toLocaleString() : "-", opened: c.opened_pct || 0, status: c.status }));
  const ads = d.ads.map((a) => ({ id: a.id, job: a.job_title, client: a.client || "", channels: a.channels, payerType: a.payer_type, payer: a.payer_type === "agency" ? "Agency" : pname(a.created_by) + " (recruiter)", budget: naira(a.budget), spent: naira(a.spent), apps: a.applicants, status: a.status }));
  const set = d.settings || {};
  const jobEngagements = (d.jobEngagements || []).map((e) => ({
    id: e.id, jobId: e.job_id, recruiterId: e.recruiter_id, recruiter: pname(e.recruiter_id) || "Unknown",
    engagedAt: new Date(e.engaged_at).getTime(), disengagedAt: e.disengaged_at ? new Date(e.disengaged_at).getTime() : null, reason: e.reason || "",
  })).sort((a, b) => b.engagedAt - a.engagedAt);
  const auditLog = (d.auditLog || []).map((a) => ({
    id: a.id, actorId: a.actor_id, actor: pname(a.actor_id) || "Unknown", action: a.action, entityType: a.entity_type, entityId: a.entity_id, detail: a.detail || "",
    when: fdate(a.created_at) + " " + new Date(a.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    createdAt: new Date(a.created_at).getTime(),
  })).sort((a, b) => b.createdAt - a.createdAt);
  return { cands, jobs, inbox, placements, campaigns, ads, jobEngagements, auditLog, users: d.profiles.map(mapUser),
    settings: { name: set.agency_name || "Harbor Agency", guaranteeDays: set.guarantee_days != null ? set.guarantee_days : 60, ai: set.ai_screening !== false,
      defaultCurrency: set.default_currency || "NGN", defaultCountry: set.default_country || "Nigeria", retentionDays: set.retention_days || null,
      integrations: set.integrations || {}, company: set.company || {}, invoicePrefix: set.invoice_prefix || "INV" } };
}
function buildTeam(users, cands, placements) {
  return users.filter((u) => u.status === "Active" && (u.roleKey === "recruiter" || u.roleKey === "recops")).map((u) => {
    const mine = cands.filter((c) => c.recruiterId === u.id); const placed = mine.filter((c) => c.status === "Placed").length;
    const billedPlacements = placements.filter((p) => p.recruiterId === u.id && ["Ready", "Invoiced", "Paid"].includes(p.status));
    return { id: u.id, init: initialsOf(u.name), name: u.name, level: u.role, submissions: mine.length, interviews: mine.filter((c) => c.status === "Interview").length, placed, conv: mine.length ? Math.round((placed / mine.length) * 100) : 0, billed: sumByCurrency(billedPlacements, "feeNum", "feeCurrency") };
  }).sort((a, b) => b.placed - a.placed).map((r, i) => ({ ...r, top: i === 0 && r.placed > 0 }));
}
const weekly = (cands) => { const b = Array(12).fill(0); cands.forEach((c) => { const w = Math.floor((Date.now() - c.createdAt) / 6048e5); if (w >= 0 && w < 12) b[11 - w]++; }); return b; };

// Merges timestamped events from candidates (added + their own timeline of status
// changes, submissions, messages, etc.), jobs and placements into one feed, newest
// first — so the notification bell reads like an actual activity log of everything
// happening in the system, not just a static "needs attention" summary.
function buildActivityFeed(S, limit = 30) {
  const events = [];
  (S.cands || []).forEach((c) => {
    events.push({ at: c.createdAt, icon: Users, text: "New candidate added: " + c.name, sub: c.role, go: () => S.openCandidate(c.id) });
    (c.timeline || []).forEach((t) => t.at && events.push({ at: t.at, icon: Clock, text: c.name + ": " + t.t, go: () => S.openCandidate(c.id) }));
  });
  (S.jobs || []).forEach((j) => events.push({ at: j.createdAt, icon: Briefcase, text: "New job posted: " + j.role, sub: j.client, go: () => S.go("jobs") }));
  (S.placements || []).forEach((p) => events.push({ at: p.createdAt, icon: CreditCard, text: "Placement recorded: " + p.name, sub: p.fee, go: () => S.go("billing") }));
  events.sort((a, b) => b.at - a.at);
  return events.slice(0, limit);
}

// Rolling window for the Overview page's Daily/Weekly/Monthly/Yearly toggle.
const PERIOD_DAYS = { Daily: 1, Weekly: 7, Monthly: 30, Yearly: 365 };
const periodRange = (period) => { const to = Date.now(); const from = to - (PERIOD_DAYS[period] || 30) * 864e5; return { from, to }; };

// Named date ranges for the "Submissions and placements" chart's own filter.
function namedRange(key, customFrom, customTo) {
  const now = new Date();
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const startOfWeek = (d) => { const x = startOfDay(d); const day = x.getDay(); const diff = day === 0 ? -6 : 1 - day; x.setDate(x.getDate() + diff); return x; };
  let from, to;
  if (key === "today") { from = startOfDay(now); to = now; }
  else if (key === "yesterday") { const y = new Date(now); y.setDate(y.getDate() - 1); from = startOfDay(y); to = startOfDay(now); }
  else if (key === "thisWeek") { from = startOfWeek(now); to = now; }
  else if (key === "lastWeek") { const sw = startOfWeek(now); from = new Date(sw); from.setDate(from.getDate() - 7); to = sw; }
  else if (key === "thisMonth") { from = new Date(now.getFullYear(), now.getMonth(), 1); to = now; }
  else if (key === "lastMonth") { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 1); }
  else if (key === "thisYear") { from = new Date(now.getFullYear(), 0, 1); to = now; }
  else if (key === "lastYear") { from = new Date(now.getFullYear() - 1, 0, 1); to = new Date(now.getFullYear(), 0, 1); }
  else if (key === "custom") { from = customFrom ? startOfDay(new Date(customFrom)) : startOfWeek(now); const ct = customTo ? new Date(customTo) : now; ct.setHours(23, 59, 59, 999); to = ct; }
  else { from = startOfWeek(now); to = now; }
  return { from: from.getTime(), to: Math.max(to.getTime(), from.getTime() + 1) };
}
// Buckets candidates (and, optionally, placements) created within [from, to] into
// hourly, daily, or weekly bars depending on how wide the range is, so a single day
// still reads as a chart. Passing `placements` gives a second, aligned series so the
// "Submissions and placements" chart can actually show both, not just submissions.
function bucketSeries(cands, from, to, placements) {
  const spanMs = Math.max(to - from, 1);
  const spanDays = spanMs / 864e5;
  let bucketMs, count, granularity;
  if (spanDays <= 1.5) { bucketMs = 36e5; count = Math.max(1, Math.ceil(spanMs / bucketMs)); granularity = "hour"; }
  else if (spanDays <= 31) { bucketMs = 864e5; count = Math.max(1, Math.ceil(spanDays)); granularity = "day"; }
  else { bucketMs = 6048e5; count = Math.max(1, Math.ceil(spanDays / 7)); granularity = "week"; }
  const bucketOf = (arr) => {
    const b = Array(count).fill(0);
    (arr || []).forEach((c) => { if (c.createdAt >= from && c.createdAt <= to) { const idx = Math.min(count - 1, Math.floor((c.createdAt - from) / bucketMs)); b[idx]++; } });
    return b;
  };
  return { buckets: bucketOf(cands), placedBuckets: placements ? bucketOf(placements) : null, granularity };
}
const RANGE_LABEL = { today: "Today", yesterday: "Yesterday", thisWeek: "This week", lastWeek: "Last week", thisMonth: "This month", lastMonth: "Last month", thisYear: "This year", lastYear: "Last year", custom: "Custom range" };
const RANGE_PREV = { today: "this time yesterday", yesterday: "the day before", thisWeek: "this time last week", lastWeek: "the week before", thisMonth: "this time last month", lastMonth: "the month before", thisYear: "this time last year", lastYear: "the year before", custom: "the period before" };
// The period to compare against: the same stretch of the previous day/week/month/year
// (e.g. Monday-to-now vs last Monday-to-same-time), or the previous full period.
function prevRange(key, from, to) {
  const shift = (t, k) => { const d = new Date(t); if (k === "day") d.setDate(d.getDate() - 1); if (k === "week") d.setDate(d.getDate() - 7); if (k === "month") d.setMonth(d.getMonth() - 1); if (k === "year") d.setFullYear(d.getFullYear() - 1); return d.getTime(); };
  const unit = { today: "day", yesterday: "day", thisWeek: "week", lastWeek: "week", thisMonth: "month", lastMonth: "month", thisYear: "year", lastYear: "year" }[key];
  if (!unit) return { from: from - (to - from), to: from };
  return { from: shift(from, unit), to: key.startsWith("this") || key === "today" ? shift(to, unit) : from };
}

/* ---- Dashboard helpers ---- */
// Re-renders every 30s so the greeting and clock follow the user's own time.
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  return now;
}
const greetingFor = (d) => { const h = d.getHours(); return h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : "Good evening"; };
// "Good afternoon, Sanni" / "Monday 28 September 2026 · 14:05 (Lagos time)", from the device's clock and time zone.
function GreetingHeader({ S, kicker, sub }) {
  const now = useClock();
  let place = "";
  try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; place = tz.includes("/") ? tz.split("/").pop().replace(/_/g, " ") : ""; } catch (e) { place = ""; }
  const date = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div>
      <div className="text-xs font-semibold tracking-widest mb-1" style={{ color: C.ink3 }}>{kicker}</div>
      <div className="text-3xl md:text-5xl mb-1" style={{ ...SERIF, color: C.ink }}>{greetingFor(now)}, {S.me.first}</div>
      <div className="text-sm" style={{ color: C.ink2 }}>{date} · {time}{place ? " (" + place + " time)" : ""}</div>
      {sub && <div className="text-sm mt-0.5" style={{ color: C.ink3 }}>{sub}</div>}
    </div>
  );
}
// Calendar-aligned buckets for [from, to]: hours for a day, days up to a month, weeks up to
// ~4 months, months beyond that. Each bucket carries a readable label for the x-axis.
function timeBuckets(from, to) {
  const span = (to - from) / 864e5;
  const out = [];
  const d = new Date(from);
  if (span <= 1.5) {
    d.setMinutes(0, 0, 0);
    while (d.getTime() < to) { const s = d.getTime(); d.setHours(d.getHours() + 1); out.push({ from: s, to: d.getTime(), label: new Date(s).toLocaleTimeString([], { hour: "numeric" }), long: new Date(s).toLocaleString("en-GB", { weekday: "short", hour: "numeric", minute: "2-digit" }) }); }
    return { buckets: out, unit: "hour" };
  }
  if (span <= 35) {
    d.setHours(0, 0, 0, 0);
    while (d.getTime() < to) { const s = d.getTime(); d.setDate(d.getDate() + 1); out.push({ from: s, to: d.getTime(), label: new Date(s).toLocaleDateString("en-GB", span <= 8 ? { weekday: "short", day: "numeric" } : { day: "numeric", month: "short" }), long: new Date(s).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) }); }
    return { buckets: out, unit: "day" };
  }
  if (span <= 120) {
    d.setHours(0, 0, 0, 0); const wd = d.getDay(); d.setDate(d.getDate() + (wd === 0 ? -6 : 1 - wd));
    while (d.getTime() < to) { const s = d.getTime(); d.setDate(d.getDate() + 7); out.push({ from: s, to: d.getTime(), label: new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" }), long: "Week of " + new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "long" }) }); }
    return { buckets: out, unit: "week" };
  }
  d.setDate(1); d.setHours(0, 0, 0, 0);
  while (d.getTime() < to) { const s = d.getTime(); d.setMonth(d.getMonth() + 1); out.push({ from: s, to: d.getTime(), label: new Date(s).toLocaleDateString("en-GB", { month: "short" }), long: new Date(s).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) }); }
  return { buckets: out, unit: "month" };
}
const countIn = (times, buckets) => buckets.map((b) => times.filter((t) => t >= b.from && t < b.to).length);
// Submissions = a candidate first submitted to the client on a job card (candidate_jobs.submitted_at).
const submissionsOf = (cands, recruiterId) => cands.filter((c) => !recruiterId || c.recruiterId === recruiterId)
  .flatMap((c) => (c.jobLinks || []).filter((l) => l.submittedAt).map((l) => ({ at: l.submittedAt, stage: l.stage, cand: c, link: l })));
const niceMax = (v) => { if (v <= 4) return 4; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };

/* Grouped bar chart with a y-axis, x-axis labels and a hover tooltip per group. */
function BarChart({ labels, longLabels, series, height = 220, valueLabels = false, ariaLabel }) {
  const [hover, setHover] = useState(null);
  const n = labels.length || 1;
  const max = niceMax(Math.max(1, ...series.flatMap((x) => x.data)));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max].filter((t) => Number.isInteger(t));
  const W = Math.max(560, n * (series.length * 14 + 14)), H = height, L = 30, R = 6, T = valueLabels ? 18 : 8, B = 24;
  const gw = (W - L - R) / n, bw = Math.max(4, Math.min(28, (gw - 8) / series.length - 2));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const every = Math.ceil(n / 12);
  const bar = (x, v) => { const top = y(v), bot = y(0), r = Math.min(4, bw / 2, bot - top); return `M${x},${bot} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${bot} Z`; };
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={ariaLabel} style={{ display: "block" }}>
        {ticks.map((t) => (
          <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={C.line} strokeWidth="1" /><text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill={C.ink3}>{t}</text></g>
        ))}
        {labels.map((lab, i) => {
          const gx = L + i * gw, x0 = gx + (gw - series.length * (bw + 2)) / 2;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
              <rect x={gx} y={T} width={gw} height={H - T - B} fill={hover === i ? "rgba(20,32,27,0.05)" : "transparent"} />
              {series.map((sr, k) => {
                const v = sr.data[i] || 0, x = x0 + k * (bw + 2);
                return v > 0 ? (
                  <g key={k}><path d={bar(x, v)} fill={sr.color} />{valueLabels && <text x={x + bw / 2} y={y(v) - 4} textAnchor="middle" fontSize="11" fill={C.ink2}>{v}</text>}</g>
                ) : null;
              })}
              {i % every === 0 && <text x={gx + gw / 2} y={H - 7} textAnchor="middle" fontSize="11" fill={C.ink2}>{lab}</text>}
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div className="absolute pointer-events-none rounded-lg border px-2.5 py-1.5 text-xs" style={{ top: 0, left: `${Math.min(78, Math.max(0, ((L + (hover + 0.5) * gw) / W) * 100 - 10))}%`, background: "#fff", borderColor: C.line, boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}>
          <div className="font-medium mb-0.5" style={{ color: C.ink }}>{(longLabels || labels)[hover]}</div>
          {series.map((sr) => <div key={sr.name} className="flex items-center gap-1.5" style={{ color: C.ink2 }}><span className="w-2 h-2 rounded-sm inline-block" style={{ background: sr.color }} />{sr.name}: <span className="font-medium" style={{ color: C.ink }}>{sr.data[hover] || 0}</span></div>)}
        </div>
      )}
    </div>
  );
}
const SERIES_COLORS = { submitted: "#534AB7", passed: "#EDA100", failed: "#D85A30", placed: "#1D9E75" };
const Legend = ({ items }) => (
  <div className="flex items-center gap-4 flex-wrap">{items.map(([name, color]) => <div key={name} className="flex items-center gap-1.5 text-xs" style={{ color: C.ink2 }}><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: color }} />{name}</div>)}</div>
);
const Delta = ({ now, prev, label }) => {
  const d = now - prev;
  return <span style={{ color: d > 0 ? C.em : d < 0 ? C.dangerFg : C.ink3 }}>{d > 0 ? "▲ " + d : d < 0 ? "▼ " + -d : "same as"}{d ? " vs " : " "}{label}</span>;
};

/* Submissions (first submitted to the client) and placements over a chosen range, with totals
   and the change against the period before. recruiterId scopes it to one recruiter. */
function SubmissionsCard({ S, recruiterId, title = "Submissions and placements" }) {
  const [range, setRange] = useState("thisWeek");
  const [cFrom, setCFrom] = useState("");
  const [cTo, setCTo] = useState("");
  const { from, to } = namedRange(range, cFrom, cTo);
  // "This week/month/year" show the whole period on the axis (days still to come stay empty).
  const today = new Date();
  const axisTo = range === "thisWeek" ? from + 7 * 864e5 : range === "thisMonth" ? new Date(today.getFullYear(), today.getMonth() + 1, 1).getTime() : range === "thisYear" ? new Date(today.getFullYear() + 1, 0, 1).getTime() : to;
  const { buckets, unit } = timeBuckets(from, axisTo);
  const subs = submissionsOf(S.cands, recruiterId).map((x) => x.at);
  const plc = S.placements.filter((p) => !recruiterId || p.recruiterId === recruiterId).map((p) => p.createdAt);
  const inR = (arr, a, b) => arr.filter((t) => t >= a && t < b).length;
  const pr = prevRange(range, from, to);
  const sNow = inR(subs, from, to + 1), sPrev = inR(subs, pr.from, pr.to), pNow = inR(plc, from, to + 1), pPrev = inR(plc, pr.from, pr.to);
  const sel = { borderColor: C.line, background: "#FAF8F3" };
  return (
    <Card className="md:col-span-2 flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <SectionTitle title={title} sub={"By " + unit + " · " + RANGE_LABEL[range]} />
        <div className="flex items-center gap-2 flex-wrap">
          <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Date range" className="rounded-lg border px-2.5 py-1.5 text-xs outline-none" style={sel}>
            {["today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth", "thisYear", "lastYear", "custom"].map((k) => <option key={k} value={k}>{RANGE_LABEL[k].replace(" range", "")}</option>)}
          </select>
          {range === "custom" && (<>
            <input type="date" value={cFrom} onChange={(e) => setCFrom(e.target.value)} aria-label="From" className="rounded-lg border px-2 py-1.5 text-xs outline-none" style={sel} />
            <input type="date" value={cTo} onChange={(e) => setCTo(e.target.value)} aria-label="To" className="rounded-lg border px-2 py-1.5 text-xs outline-none" style={sel} />
          </>)}
        </div>
      </div>
      <div className="flex gap-8 mt-3 mb-2 flex-wrap">
        <div><div className="text-2xl font-semibold">{sNow}</div><div className="text-xs" style={{ color: C.ink2 }}>submissions · <Delta now={sNow} prev={sPrev} label={RANGE_PREV[range]} /></div></div>
        <div><div className="text-2xl font-semibold">{pNow}</div><div className="text-xs" style={{ color: C.ink2 }}>placements · <Delta now={pNow} prev={pPrev} label={RANGE_PREV[range]} /></div></div>
      </div>
      <div className="flex-1 flex flex-col justify-end">
        <BarChart labels={buckets.map((b) => b.label)} longLabels={buckets.map((b) => b.long)} valueLabels={buckets.length <= 31} ariaLabel={"Submissions and placements by " + unit}
          series={[{ name: "Submissions", color: SERIES_COLORS.submitted, data: countIn(subs, buckets) }, { name: "Placements", color: SERIES_COLORS.placed, data: countIn(plc, buckets) }]} />
      </div>
      <div className="mt-2"><Legend items={[["Submissions", SERIES_COLORS.submitted], ["Placements", SERIES_COLORS.placed]]} /></div>
    </Card>
  );
}

/* A "needs attention" list where each row opens the people behind it: one person goes
   straight to their profile, several expand into a clickable list. */
function AttentionList({ title, items, S }) {
  const [open, setOpen] = useState(null);
  return (
    <Card>
      <SectionTitle title={title} />
      <div className="mt-3 flex flex-col">
        {items.map((r, i) => {
          const people = r.people || [];
          const click = () => {
            if (people.length === 1 && people[0].onOpen) return people[0].onOpen();
            if (people.length === 1 && people[0].id) return S.openCandidate(people[0].id);
            if (people.length > 1) return setOpen(open === i ? null : i);
            if (r.go) S.go(r.go);
          };
          return (
            <div key={i} style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
              <button type="button" onClick={click} aria-expanded={people.length > 1 ? open === i : undefined} className="w-full flex items-center gap-3 py-3 text-left">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: TONE[r.tone].bg }}><r.icon size={17} color={TONE[r.tone].fg} /></div>
                <div className="flex-1 min-w-0"><div className="text-sm font-medium">{r.t}</div><div className="text-xs" style={{ color: C.ink2 }}>{r.s}</div></div>
                {people.length > 1 ? <ChevronDown size={16} color={C.ink3} className="shrink-0" style={{ transform: open === i ? "rotate(180deg)" : "none" }} /> : <ChevronRight size={16} color={C.ink3} className="shrink-0" />}
              </button>
              {open === i && people.length > 1 && (
                <div className="pl-12 pb-2 flex flex-col">
                  {people.map((p, k) => (
                    <button key={k} type="button" onClick={() => (p.onOpen ? p.onOpen() : p.id ? S.openCandidate(p.id) : r.go && S.go(r.go))} className="flex items-center gap-2 py-1.5 text-left text-sm">
                      <span className="flex-1 min-w-0 truncate font-medium" style={{ color: C.em }}>{p.name}</span>
                      {p.sub && <span className="text-xs shrink-0" style={{ color: C.ink3 }}>{p.sub}</span>}
                      <ChevronRight size={14} color={C.ink3} className="shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
const daysAgo = (t) => { const d = Math.floor((Date.now() - t) / 864e5); return d <= 0 ? "today" : d === 1 ? "1 day" : d + " days"; };
const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
const jobName = (S, jobId) => { const j = S.jobs.find((x) => x.id === jobId); return j ? j.client : ""; };
const linkPeople = (S, pred) => S.cands.flatMap((c) => (c.jobLinks || []).filter((l) => pred(l, c)).map((l) => ({ id: c.id, name: c.name, sub: jobName(S, l.jobId) })));

/* Recruiter performance for one month or one year: four bars per recruiter. Counts the
   submissions made in that period and what has happened to each since. */
function RecruiterPerformanceChart({ S }) {
  const now = new Date();
  const [mode, setMode] = useState("month");
  const [month, setMonth] = useState(now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0"));
  const [year, setYear] = useState(String(now.getFullYear()));
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); return { v: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"), l: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) }; });
  const allSubs = submissionsOf(S.cands);
  const firstYear = Math.min(now.getFullYear(), ...allSubs.map((x) => new Date(x.at).getFullYear()));
  const years = Array.from({ length: now.getFullYear() - firstYear + 1 }, (_, i) => String(now.getFullYear() - i));
  const [y0, m0] = month.split("-").map(Number);
  const from = mode === "month" ? new Date(y0, m0 - 1, 1).getTime() : new Date(Number(year), 0, 1).getTime();
  const to = mode === "month" ? new Date(y0, m0, 1).getTime() : new Date(Number(year) + 1, 0, 1).getTime();
  const owners = new Set(S.cands.map((c) => c.recruiterId).filter(Boolean));
  const people = (S.users || []).filter((u) => u.status === "Active" && (u.roleKey === "recruiter" || u.roleKey === "recops" || owners.has(u.id)));
  const rows = people.map((u) => {
    const mine = allSubs.filter((x) => x.cand.recruiterId === u.id && x.at >= from && x.at < to);
    return { name: u.name, submitted: mine.length, passed: mine.filter((x) => x.stage === "Placed").length, failed: mine.filter((x) => ["Rejected", "Withdrawn"].includes(x.stage)).length };
  }).sort((a, b) => b.passed - a.passed || b.submitted - a.submitted);
  const label = mode === "month" ? months.find((m) => m.v === month)?.l : year;
  const sel = { borderColor: C.line, background: "#FAF8F3" };
  const series = [["Submitted", "submitted"], ["Failed", "failed"], ["Passed (placed)", "placed"]].map(([name, k]) => ({ name, color: SERIES_COLORS[k], data: rows.map((r) => r[k === "placed" ? "passed" : k]) }));
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <SectionTitle title="Recruiter performance" sub={"Submissions made in " + label + " and what has happened to them since"} />
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-lg border p-0.5" style={{ borderColor: C.line, background: "#fff" }}>
            {[["month", "Month"], ["year", "Year"]].map(([k, l]) => <button key={k} type="button" onClick={() => setMode(k)} className="rounded-md px-2.5 py-1 text-xs font-medium" style={mode === k ? { background: C.ink, color: "#fff" } : { color: C.ink2 }}>{l}</button>)}
          </div>
          {mode === "month"
            ? <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" className="rounded-lg border px-2.5 py-1.5 text-xs outline-none" style={sel}>{months.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}</select>
            : <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year" className="rounded-lg border px-2.5 py-1.5 text-xs outline-none" style={sel}>{years.map((v) => <option key={v} value={v}>{v}</option>)}</select>}
        </div>
      </div>
      <div className="mt-3 mb-2"><Legend items={series.map((x) => [x.name, x.color])} /></div>
      {rows.length ? (
        <BarChart labels={rows.map((r) => r.name.split(" ")[0])} longLabels={rows.map((r) => r.name)} series={series} valueLabels height={240} ariaLabel={"Recruiter performance, " + label} />
      ) : <div className="text-sm py-8 text-center" style={{ color: C.ink3 }}>No recruiters yet.</div>}
      <div className="text-xs mt-2" style={{ color: C.ink3 }}>Passed = placed. Failed = rejected or withdrawn after submission.</div>
    </div>
  );
}

/* Structured, non-AI pre-filter: finds candidates worth re-checking against a newly posted job.
   This is a cheap word-overlap pass over structured fields (skills, role title) so a new job
   posting never has to brute-force re-read every candidate's raw CV. Once AI-parsed skills are
   populated (see the CV-parsing feature), this becomes a real shortlist; the AI fit review then
   only runs against this short list, not the whole pool. Returns candidates with score > 0,
   highest first, capped at 5. */
const STOPWORDS = new Set(["and", "the", "for", "with", "a", "of", "to", "in", "on", "or", "an"]);
const words = (s) => (s || "").toLowerCase().match(/[a-z0-9+]+/g)?.filter((w) => w.length > 1 && !STOPWORDS.has(w)) || [];
function suggestFits(job, cands) {
  const jobWords = new Set([...words(job.role), ...words(job.description)]);
  return cands
    .filter((c) => ["Active file", "In review"].includes(c.status) && !c.endorsed.some((e) => e.company === job.client && e.role === job.role))
    .map((c) => {
      const candWords = new Set([...words(c.role), ...(c.skills || []).flatMap(words), ...(c.strengths || []).flatMap(words)]);
      let score = 0; jobWords.forEach((w) => { if (candWords.has(w)) score++; });
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.c);
}

/* Helpers */
const todayStr = () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
function downloadCSV(name, rows) {
  if (!rows.length) return false;
  const keys = Object.keys(rows[0]);
  const esc = (v) => `"${String(Array.isArray(v) ? v.join("; ") : v ?? "").replace(/"/g, '""')}"`;
  const csv = [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n");
  try { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click(); return true; } catch (e) { return false; }
}
/* PLACEHOLDER scoring: replace with your real AI rating service */
const scoreFor = (seed) => 60 + (Array.from(seed).reduce((a, c) => a + c.charCodeAt(0), 0) % 35);
const flat = (c) => ({ name: c.name, role: c.role, location: c.location, recruiter: c.recruiter || "", status: c.status, ai: c.ai, email: c.email });
/* How many company cards have follow-up questions in a given state (draft / sent / answered). */
const countFollowups = (cands, state) => cands.reduce((n, c) => n + (c.jobLinks || []).filter((l) => l.ai && l.ai.followups && l.ai.followups.state === state).length, 0);
const newCandidate = (o) => ({ id: uid(), recruiterId: null, emailAddr: "", phone: "", portal: "", createdAt: Date.now(), location: "Lagos, Nigeria", recruiter: null, recruiterInit: "", status: "In review", ai: 70, email: "Unverified", opens: 0, activity: "Just now", experience: "-", notice: "-", pay: "-", skills: [], strengths: [], gaps: [], endorsed: [], screening: { state: "pending" }, comments: [], timeline: [], matches: [], cv: null, ...o });

/* Desktop detection in JS, so layout never depends on responsive classes being available */
function useDesktop() {
  const get = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(min-width: 768px)").matches;
  const [d, setD] = useState(get);
  React.useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia("(min-width: 768px)");
    const f = () => setD(m.matches);
    m.addEventListener("change", f); f();
    return () => m.removeEventListener("change", f);
  }, []);
  return d;
}

/* Atoms */
function Card({ children, className = "", style = {}, dark = false }) {
  return (
    <div
      className={`rounded-2xl border p-5 md:p-6 ${className}`}
      style={{ background: dark ? C.side : C.card, borderColor: dark ? C.side : C.line, boxShadow: dark ? "none" : "0 2px 6px rgba(20,32,27,0.05)", minWidth: 0, ...style }}
    >
      {children}
    </div>
  );
}

function Pill({ children, tone = "neutral" }) {
  const t = TONE[tone] || TONE.neutral;
  return (
    <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap" style={{ background: t.bg, color: t.fg }}>
      {children}
    </span>
  );
}
function StatusPill({ status }) {
  return <Pill tone={STATUS_TONE[status] || "neutral"}>{status}</Pill>;
}
function Avatar({ init, tone = "neutral", size = 36, src }) {
  const t = TONE[tone] || TONE.neutral;
  if (src) return <img src={src} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />;
  return (
    <div className="flex items-center justify-center rounded-full font-semibold shrink-0" style={{ width: size, height: size, background: t.bg, color: t.fg, fontSize: size > 30 ? 12 : 10 }}>
      {init}
    </div>
  );
}
function KPI({ label, value, delta, foot, dark = false }) {
  return (
    <Card dark={dark}>
      <div className="flex items-center justify-between mb-2 gap-2">
        <span className="text-xs md:text-sm" style={{ color: dark ? "#A9BBB1" : C.ink2 }}>{label}</span>
        {delta && (
          <span className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold shrink-0" style={{ background: dark ? "rgba(255,255,255,0.1)" : C.emTint, color: dark ? C.lime : C.em }}>
            <TrendingUp size={11} strokeWidth={2.5} />{delta}
          </span>
        )}
      </div>
      <div className="text-2xl md:text-4xl mb-1 break-words" style={{ ...SERIF, color: dark ? C.lime : C.ink }}>{value}</div>
      <div className="text-xs" style={{ color: dark ? "#8FA69A" : C.ink3 }}>{foot}</div>
    </Card>
  );
}
function KPIGrid({ children, cols = 4 }) {
  const mdCols = { 4: "md:grid-cols-4", 5: "md:grid-cols-5" }[cols] || "md:grid-cols-4";
  return <div className={`grid grid-cols-2 ${mdCols} gap-3 md:gap-4`}>{children}</div>;
}

function SectionTitle({ title, sub, size = "text-2xl" }) {
  return (
    <div>
      <div className={size} style={{ ...SERIF, color: C.ink }}>{title}</div>
      {sub && <div className="text-sm mt-0.5" style={{ color: C.ink2 }}>{sub}</div>}
    </div>
  );
}

function Btn({ children, onClick, kind = "ghost", icon: Icon, className = "", full = false, type = "button", disabled = false }) {
  const base = `inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium ${full ? "w-full" : ""}`;
  const style =
    kind === "primary" ? { background: C.em, color: "#fff" } :
    kind === "dark" ? { background: C.ink, color: "#fff" } :
    kind === "danger" ? { background: C.dangerFg, color: "#fff" } :
    { background: "#fff", color: C.ink, border: `1px solid ${C.line}` };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${className}`} style={{ ...style, ...(disabled ? { opacity: 0.6, cursor: "not-allowed" } : {}) }}>
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}

function SearchInput({ value, onChange, placeholder }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border px-3 py-2.5 flex-1" style={{ borderColor: C.line, background: "#FAF8F3" }}>
      <Search size={16} color={C.ink3} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="bg-transparent outline-none text-sm flex-1 min-w-0" style={{ color: C.ink }} />
    </div>
  );
}

function Tabs({ tabs, active, setActive }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {tabs.map((t) => (
        <button key={t.key} onClick={() => setActive(t.key)} className="rounded-full px-3 py-1.5 text-xs font-medium" style={active === t.key ? { background: C.ink, color: "#fff" } : { border: `1px solid #D5D2C7`, color: C.ink2 }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ProgressBar({ pct, w = 80, tone = C.em }) {
  return (
    <div className="rounded-full h-2" style={{ width: w, background: "#EFEBE1" }}>
      <div className="rounded-full h-2" style={{ width: `${Math.min(100, pct)}%`, background: tone }} />
    </div>
  );
}

/* Loading UI: a small set of shared animations + a branded full-page loader
   and a slim top progress bar for quiet background refreshes. */
function GlobalStyles() {
  return (
    <style>{`
      @keyframes harborSpin { to { transform: rotate(360deg); } }
      @keyframes harborPulse { 0%, 100% { opacity: .4; transform: scale(0.98); } 50% { opacity: 1; transform: scale(1); } }
      @keyframes harborSweep { 0% { transform: translateX(-40%); } 100% { transform: translateX(140%); } }
      @keyframes harborDot { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
      @keyframes harborShimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    `}</style>
  );
}

function Loader({ label = "Loading…" }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-5" style={{ background: C.canvas }}>
      <GlobalStyles />
      <div className="relative flex items-center justify-center" style={{ width: 56, height: 56 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `3px solid ${C.line}` }} />
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "3px solid transparent", borderTopColor: C.em, animation: "harborSpin 0.85s linear infinite" }} />
        <div style={{ ...SERIF, fontSize: 20, color: C.em }}>H</div>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <div style={{ ...SERIF, fontSize: 18, color: C.ink, animation: "harborPulse 1.8s ease-in-out infinite" }}>Harbor</div>
        <div className="text-xs" style={{ color: C.ink3 }}>{label}</div>
      </div>
    </div>
  );
}

function TopProgressBar({ show }) {
  if (!show) return null;
  return (
    <div className="fixed top-0 left-0 right-0 z-50 overflow-hidden" style={{ height: 3, background: "transparent" }}>
      <GlobalStyles />
      <div style={{ width: "40%", height: "100%", background: `linear-gradient(90deg, transparent, ${C.em}, transparent)`, animation: "harborSweep 1.1s ease-in-out infinite" }} />
    </div>
  );
}

function InlineDots({ color = C.em }) {
  return (
    <span className="inline-flex items-end gap-0.5" style={{ height: 10 }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 4, height: 4, borderRadius: "50%", background: color, display: "inline-block", animation: `harborDot 1.1s ease-in-out ${i * 0.15}s infinite` }} />
      ))}
    </span>
  );
}

function Toast({ text }) {
  const desktop = useDesktop();
  if (!text) return null;
  return (
    <div className="fixed rounded-xl px-4 py-3 text-sm shadow-lg flex items-center gap-2" style={{ zIndex: 60, background: C.side, color: "#fff", bottom: desktop ? 24 : 80, ...(desktop ? { right: 24 } : { left: "50%", transform: "translateX(-50%)" }) }}>
      <CheckCircle2 size={16} color={C.lime} /> {text}
    </div>
  );
}

function Modal({ open, onClose, title, children, wide }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center">
      <div className="absolute inset-0" style={{ background: "rgba(20,32,27,0.45)" }} onClick={onClose} />
      <div className={"relative w-full rounded-t-2xl md:rounded-2xl p-5 md:p-6 overflow-y-auto " + (wide ? "md:max-w-2xl" : "md:max-w-lg")} style={{ background: "#fff", maxHeight: "88vh" }}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-xl" style={{ ...SERIF }}>{title}</div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: C.canvas }}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* Shared "are you sure" modal for destructive actions (delete candidate/job/campaign/ad). */
function ConfirmModal({ open, onClose, title, body, confirmLabel = "Delete", onConfirm, busy }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        <div className="text-sm" style={{ color: C.ink2 }}>{body}</div>
        <div className="flex gap-2 justify-end">
          <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn kind="danger" onClick={onConfirm} disabled={busy}>{busy ? <>Deleting <InlineDots color="#fff" /></> : confirmLabel}</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* Responsive data table: real table on desktop, cards on mobile */
function DataTable({ columns, rows, onRowClick, keyField = "id", empty = "Nothing here yet." }) {
  const desktop = useDesktop();
  const primary = columns[0];
  const rest = columns.slice(1);
  return (
    <div>
      <table className="w-full text-sm" style={{ display: desktop ? "table" : "none" }}>
        <thead>
          <tr className="text-left text-xs font-semibold" style={{ color: C.ink3, borderBottom: `1px solid ${C.line}` }}>
            {columns.map((c) => <th key={c.key} className="py-2 pr-3 font-semibold">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row[keyField] ?? i} onClick={() => onRowClick && onRowClick(row)} style={{ borderTop: `1px solid ${C.line}`, cursor: onRowClick ? "pointer" : "default" }}>
              {columns.map((c) => <td key={c.key} className="py-3 pr-3 align-top">{c.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-col gap-2.5" style={{ display: desktop ? "none" : "flex" }}>
        {rows.map((row, i) => (
          <div key={row[keyField] ?? i} onClick={() => onRowClick && onRowClick(row)} className="rounded-xl border p-3.5" style={{ borderColor: C.line, cursor: onRowClick ? "pointer" : "default" }}>
            <div className="mb-2">{primary.render(row)}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {rest.map((c) => (
                <div key={c.key} className="text-xs flex items-center gap-1">
                  <span style={{ color: C.ink3 }}>{c.label}:</span>
                  <span>{c.render(row)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {rows.length === 0 && <div className="text-sm text-center py-6" style={{ color: C.ink3 }}>{empty}</div>}
    </div>
  );
}

/* Nav config */
const NAV_RECOPS = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "candidates", label: "Candidates", icon: Users },
  { key: "inbox", label: "Inbox", icon: InboxIcon },
  { key: "jobs", label: "Jobs", icon: Briefcase },
  { key: "campaigns", label: "Campaigns", icon: Send },
  { key: "billing", label: "Billing", icon: CreditCard },
  { key: "ads", label: "Ads", icon: Megaphone },
];
const NAV_ADMIN_EXTRA = [
  { key: "users", label: "Users & permissions", icon: Shield },
  { key: "settings", label: "Agency settings", icon: Settings },
];
const NAV_RECRUITER = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "candidates", label: "My candidates", icon: Users },
  { key: "jobs", label: "Jobs", icon: Briefcase },
  { key: "campaigns", label: "Campaigns", icon: Send },
  { key: "billing", label: "Billing", icon: CreditCard },
];
const byKey = (list, key) => list.find((x) => x.key === key);
const MOBILE_TABS = {
  recops: [byKey(NAV_RECOPS, "overview"), byKey(NAV_RECOPS, "candidates"), byKey(NAV_RECOPS, "inbox"), byKey(NAV_RECOPS, "jobs")],
  recruiter: [byKey(NAV_RECRUITER, "overview"), byKey(NAV_RECRUITER, "candidates"), byKey(NAV_RECRUITER, "jobs"), byKey(NAV_RECRUITER, "campaigns")],
  admin: [byKey(NAV_RECOPS, "overview"), byKey(NAV_RECOPS, "candidates"), byKey(NAV_RECOPS, "inbox"), byKey(NAV_RECOPS, "jobs")],
};
const ROLE_LABEL = { recops: "Rec Ops manager", recruiter: "Recruiter", admin: "Admin, owner" };
const ROLE_NAME = { recops: "Maya Okoye", recruiter: "Adaeze Nwosu", admin: "Ade Balogun" };
const ROLE_INIT = { recops: "MO", recruiter: "AN", admin: "AB" };

/* The logged-in user's own account: name, email, phone, role, and a profile picture. */
const NOTIF_EVENTS = [
  { key: "newCandidate", label: "New candidate added", sub: "A candidate is added to your pipeline." },
  { key: "screeningReady", label: "AI screening ready for review", sub: "AI has drafted or reviewed a screening question that needs your approval." },
  { key: "placementRecorded", label: "Placement recorded", sub: "A hire is logged for one of your roles." },
  { key: "jobPosted", label: "New job posted", sub: "A new role goes live." },
];

function AccountTab({ S, toast }) {
  const me = S.me;
  const [name, setName] = useState(me.name);
  const [phone, setPhone] = useState(me.phone || "");
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileRef = React.useRef(null);
  const dirty = name.trim() !== me.name || phone.trim() !== (me.phone || "");
  const save = () => {
    if (!name.trim()) { toast("Add your name"); return; }
    setBusy(true);
    S.updateMyProfile({ name: name.trim(), phone: phone.trim() }).then(() => toast("Profile updated")).catch(() => {}).finally(() => setBusy(false));
  };
  const pickAvatar = () => fileRef.current && fileRef.current.click();
  const onAvatarFile = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (!f.type.startsWith("image/")) { toast("Pick an image file"); return; }
    setAvatarBusy(true);
    S.uploadAvatar(f).then(() => toast("Profile picture updated")).catch(() => {}).finally(() => setAvatarBusy(false));
  };
  return (
    <Card>
      <div className="flex items-center gap-4 mb-6">
        <div className="relative">
          <Avatar init={me.init} src={me.avatarUrl} tone="em" size={72} />
          <button onClick={pickAvatar} disabled={avatarBusy} className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full flex items-center justify-center border-2" style={{ background: C.em, borderColor: "#fff" }} title="Change profile picture">
            <Pencil size={12} color="#fff" />
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onAvatarFile} />
        </div>
        <div>
          <div className="text-lg font-medium">{me.name}</div>
          <div className="mt-1"><Pill tone="em">{me.label}</Pill></div>
          {avatarBusy && <div className="text-xs mt-1" style={{ color: C.ink3 }}>Uploading <InlineDots /></div>}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Full name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        </div>
        <div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Email</label>
          <div className="flex items-center gap-2 rounded-lg px-3.5 py-2.5 mt-1.5 text-sm" style={{ background: C.canvas }}>
            <Mail size={14} color={C.ink2} className="shrink-0" /><span style={{ color: C.ink2 }} className="truncate">{me.email}</span>
          </div>
          <div className="text-xs mt-1" style={{ color: C.ink3 }}>Contact an admin to change the email on your account.</div>
        </div>
        <div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Phone number</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Not set" className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        </div>
        <div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Role</label>
          <div className="flex items-center gap-2 rounded-lg px-3.5 py-2.5 mt-1.5 text-sm" style={{ background: C.canvas, color: C.ink2 }}>{me.label}</div>
          <div className="text-xs mt-1" style={{ color: C.ink3 }}>Even as an admin, you can't change your own role here — go to Users & permissions to change anyone's role, yours included.</div>
        </div>
        <Btn kind="primary" full disabled={!dirty || busy} onClick={save}>{busy ? <>Saving <InlineDots color="#fff" /></> : "Save changes"}</Btn>
      </div>
    </Card>
  );
}

function NotificationsTab({ S, toast }) {
  const [prefs, setPrefs] = useState({ ...DEFAULT_NOTIF_PREFS, ...(S.me.notificationPrefs || {}) });
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(prefs) !== JSON.stringify({ ...DEFAULT_NOTIF_PREFS, ...(S.me.notificationPrefs || {}) });
  const toggle = (k) => setPrefs((p) => ({ ...p, [k]: !p[k] }));
  const save = () => { setBusy(true); S.updateNotificationPrefs(prefs).then(() => toast("Notification preferences saved")).catch(() => {}).finally(() => setBusy(false)); };
  return (
    <Card>
      <SectionTitle title="In-app notifications" sub="Choose which activity shows up in your notification bell." size="text-lg" />
      <div className="flex flex-col gap-1 mt-4">
        {NOTIF_EVENTS.map((e) => (
          <button key={e.key} onClick={() => toggle(e.key)} className="py-3 flex items-center justify-between gap-3 text-left" style={{ borderTop: `1px solid ${C.line}` }}>
            <div><div className="text-sm font-medium">{e.label}</div><div className="text-xs" style={{ color: C.ink2 }}>{e.sub}</div></div>
            <div className="w-10 h-6 rounded-full flex items-center px-0.5 shrink-0" style={{ background: prefs[e.key] ? C.em : "#D5D2C7" }}><div className={`w-5 h-5 rounded-full bg-white ${prefs[e.key] ? "ml-auto" : ""}`} /></div>
          </button>
        ))}
      </div>
      <div className="text-xs mt-3" style={{ color: C.ink3 }}>Email alerts aren't set up yet — these preferences will also cover email once they are.</div>
      <Btn kind="primary" className="mt-4" disabled={!dirty || busy} onClick={save}>{busy ? <>Saving <InlineDots color="#fff" /></> : "Save preferences"}</Btn>
    </Card>
  );
}

function SecurityTab({ S, toast }) {
  const [pw1, setPw1] = useState(""); const [pw2, setPw2] = useState(""); const [pwBusy, setPwBusy] = useState(false);
  const [factors, setFactors] = useState(null); // null = loading, [] = none
  const [enroll, setEnroll] = useState(null); // { factorId, qr, secret }
  const [code, setCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  React.useEffect(() => { S.mfaListFactors().then(setFactors).catch(() => setFactors([])); }, []);
  const verified = (factors || []).filter((f) => f.status === "verified");

  const savePassword = () => {
    if (pw1.length < 8) { toast("Use at least 8 characters"); return; }
    if (pw1 !== pw2) { toast("Passwords don't match"); return; }
    setPwBusy(true);
    S.changePassword(pw1).then(() => { toast("Password updated"); setPw1(""); setPw2(""); }).catch(() => {}).finally(() => setPwBusy(false));
  };
  const startEnroll = () => {
    setMfaBusy(true);
    S.mfaEnroll().then((j) => setEnroll({ factorId: j.id, qr: j.totp && j.totp.qr_code, secret: j.totp && j.totp.secret })).catch((e) => toast(e.message)).finally(() => setMfaBusy(false));
  };
  const confirmEnroll = () => {
    if (!code.trim()) { toast("Enter the 6-digit code"); return; }
    setMfaBusy(true);
    S.mfaChallenge(enroll.factorId)
      .then((ch) => S.mfaVerify(enroll.factorId, ch.id, code.trim()))
      .then(() => { toast("Two-factor authentication turned on"); setEnroll(null); setCode(""); return S.mfaListFactors().then(setFactors); })
      .catch((e) => toast(e.message))
      .finally(() => setMfaBusy(false));
  };
  const removeFactor = (id) => {
    setMfaBusy(true);
    S.mfaUnenroll(id).then(() => { toast("Two-factor authentication turned off"); return S.mfaListFactors().then(setFactors); }).catch((e) => toast(e.message)).finally(() => setMfaBusy(false));
  };
  const signOutEverywhere = () => {
    setSignOutBusy(true);
    S.signOutEverywhere().then(() => toast("Signed out everywhere else")).catch(() => {}).finally(() => setSignOutBusy(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle title="Change password" size="text-lg" />
        <div className="flex flex-col gap-3 mt-4">
          <input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} placeholder="New password" className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Confirm new password" className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
          <Btn kind="primary" disabled={!pw1 || !pw2 || pwBusy} onClick={savePassword}>{pwBusy ? <>Updating <InlineDots color="#fff" /></> : "Update password"}</Btn>
        </div>
      </Card>
      <Card>
        <SectionTitle title="Two-factor authentication" sub="Adds a one-time code from an authenticator app when you sign in." size="text-lg" />
        <div className="mt-4">
          {factors === null && <div className="text-sm" style={{ color: C.ink3 }}>Loading <InlineDots /></div>}
          {factors !== null && verified.length > 0 && !enroll && (
            <div className="flex items-center justify-between gap-3 rounded-xl p-3.5" style={{ background: C.emTint }}>
              <div className="flex items-center gap-2 text-sm font-medium" style={{ color: C.em }}><CheckCircle2 size={16} /> Two-factor authentication is on</div>
              <Btn kind="danger" disabled={mfaBusy} onClick={() => removeFactor(verified[0].id)}>Turn off</Btn>
            </div>
          )}
          {factors !== null && verified.length === 0 && !enroll && (
            <Btn kind="primary" disabled={mfaBusy} onClick={startEnroll}>{mfaBusy ? <>Starting <InlineDots color="#fff" /></> : "Set up two-factor authentication"}</Btn>
          )}
          {enroll && (
            <div className="flex flex-col gap-3">
              <div className="text-sm" style={{ color: C.ink2 }}>Scan this in your authenticator app, or enter the code manually, then type the 6-digit code it shows.</div>
              {enroll.qr && <div className="w-40 h-40 [&_svg]:w-full [&_svg]:h-full" dangerouslySetInnerHTML={{ __html: enroll.qr }} />}
              {enroll.secret && <div className="text-xs font-mono rounded-lg px-3 py-2" style={{ background: C.canvas, color: C.ink2 }}>{enroll.secret}</div>}
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
              <div className="flex gap-2">
                <Btn onClick={() => { setEnroll(null); setCode(""); }} disabled={mfaBusy}>Cancel</Btn>
                <Btn kind="primary" disabled={mfaBusy} onClick={confirmEnroll}>{mfaBusy ? <>Verifying <InlineDots color="#fff" /></> : "Verify and turn on"}</Btn>
              </div>
            </div>
          )}
        </div>
      </Card>
      <Card>
        <SectionTitle title="Sessions" size="text-lg" />
        <div className="text-sm mt-1 mb-3" style={{ color: C.ink2 }}>If you signed in on a device you no longer use, sign out everywhere else. This one stays signed in.</div>
        <Btn disabled={signOutBusy} onClick={signOutEverywhere}>{signOutBusy ? <>Signing out <InlineDots /></> : "Sign out of all other devices"}</Btn>
      </Card>
    </div>
  );
}

function MyProfilePage({ S, toast, onBack }) {
  const [tab, setTab] = useState("account");
  return (
    <div className="flex flex-col gap-5 md:gap-6 max-w-2xl">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Back</button>
      <SectionTitle size="text-3xl md:text-4xl" title="My profile" sub="Your account details, visible to the rest of the team." />
      <Tabs tabs={[{ key: "account", label: "Account" }, { key: "notifications", label: "Notifications" }, { key: "security", label: "Security" }]} active={tab} setActive={setTab} />
      {tab === "account" && <AccountTab S={S} toast={toast} />}
      {tab === "notifications" && <NotificationsTab S={S} toast={toast} />}
      {tab === "security" && <SecurityTab S={S} toast={toast} />}
    </div>
  );
}

/* Sidebar (desktop) + Mobile bottom nav + More sheet */
function NavList({ items, page, setPage, dark, onNavigate }) {
  return (
    <div className="flex flex-col gap-1">
      {items.map((it) => {
        const active = page === it.key;
        const Icon = it.icon;
        return (
          <button
            key={it.key}
            onClick={() => { setPage(it.key); onNavigate && onNavigate(); }}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-left"
            style={
              dark
                ? { background: active ? "rgba(255,255,255,0.1)" : "transparent", color: active ? "#fff" : "#A9BBB1", fontWeight: active ? 500 : 400 }
                : { background: active ? C.emTint : "transparent", color: active ? C.em : C.ink2, fontWeight: active ? 500 : 400 }
            }
          >
            <Icon size={18} />
            <span className="flex-1">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Sidebar({ role, page, setPage, me, pendingQ, onSignOut }) {
  const desktop = useDesktop();
  const [collapsed, setCollapsed] = useState(false);
  const items = role === "recruiter" ? NAV_RECRUITER : NAV_RECOPS;
  const extra = role === "admin" ? NAV_ADMIN_EXTRA : [];
  return (
    <div className="flex-col shrink-0 h-screen sticky top-0" style={{ display: desktop ? "flex" : "none", width: collapsed ? 72 : 260, background: C.side }}>
      <div className="flex items-center gap-2.5 px-4 pt-6 pb-5">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: C.lime }}>
          <span style={{ ...SERIF, color: C.side, fontSize: 18 }}>H</span>
        </div>
        {!collapsed && <span className="text-xl flex-1" style={{ ...SERIF, color: "#fff" }}>Harbor</span>}
        <button onClick={() => setCollapsed((c) => !c)} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(255,255,255,0.08)" }}>
          {collapsed ? <ChevronRight size={16} color="#A9BBB1" /> : <ChevronLeft size={16} color="#A9BBB1" />}
        </button>
      </div>
      {!collapsed && <div className="px-4 pb-1.5 text-xs font-semibold tracking-widest" style={{ color: "#6F8A7D" }}>WORKSPACE</div>}
      <div className="px-3">{collapsed ? <NavList items={items.map((i) => ({ ...i, label: "" }))} page={page} setPage={setPage} dark /> : <NavList items={[...items, ...extra]} page={page} setPage={setPage} dark />}</div>
      <div className="flex-1" />
      {!collapsed && (
        <div className="px-3 pb-3">
          <div className="rounded-xl p-3.5 mb-3" style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)" }}>
            <div className="flex items-center gap-2 mb-1"><Sparkles size={15} color={C.lime} /><span className="text-xs font-medium text-white">AI needs your approval</span></div>
            <div className="text-xs" style={{ color: "#A9BBB1" }}>{pendingQ} sets of screening questions are waiting for approval.</div>
          </div>
          <button onClick={onSignOut} className="w-full text-left text-xs rounded-lg px-2 py-2" style={{ color: "#A9BBB1", border: "1px solid rgba(255,255,255,0.12)" }}>Sign out</button>
        </div>
      )}
      <button onClick={() => setPage("myProfile")} className="px-4 pb-5 pt-2 flex items-center gap-2.5 text-left w-full" style={{ background: page === "myProfile" ? "rgba(255,255,255,0.07)" : "transparent" }} title="My profile">
        <Avatar init={me.init} src={me.avatarUrl} tone="em" />
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white truncate">{me.name}</div>
            <div className="text-xs truncate" style={{ color: "#8FA69A" }}>{me.label}</div>
          </div>
        )}
      </button>
    </div>
  );
}

function MobileBottomNav({ role, page, setPage, onMore }) {
  const desktop = useDesktop();
  const items = MOBILE_TABS[role];
  return (
    <div className="fixed bottom-0 left-0 right-0 items-stretch border-t z-40" style={{ display: desktop ? "none" : "flex", background: "#fff", borderColor: C.line }}>
      {items.map((it) => {
        const active = page === it.key;
        const Icon = it.icon;
        return (
          <button key={it.key} onClick={() => setPage(it.key)} className="flex-1 flex flex-col items-center justify-center gap-1 py-2.5">
            <Icon size={20} color={active ? C.em : C.ink3} />
            <span className="leading-none" style={{ fontSize: 10, color: active ? C.em : C.ink3, fontWeight: active ? 600 : 400 }}>{it.label}</span>
          </button>
        );
      })}
      <button onClick={onMore} className="flex-1 flex flex-col items-center justify-center gap-1 py-2.5">
        <MoreHorizontal size={20} color={C.ink3} />
        <span className="leading-none" style={{ fontSize: 10, color: C.ink3 }}>More</span>
      </button>
    </div>
  );
}

function MoreSheet({ open, onClose, role, page, setPage, me, onSignOut }) {
  const desktop = useDesktop();
  if (!open || desktop) return null;
  const items = role === "recruiter" ? NAV_RECRUITER : NAV_RECOPS;
  const extra = role === "admin" ? NAV_ADMIN_EXTRA : [];
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0" style={{ background: "rgba(20,32,27,0.45)" }} onClick={onClose} />
      <div className="absolute bottom-0 left-0 right-0 rounded-t-2xl p-5 overflow-y-auto" style={{ background: "#fff", maxHeight: "80vh" }}>
        <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: C.line }} />
        <NavList items={[...items, ...extra]} page={page} setPage={setPage} onNavigate={onClose} />
        <div className="pt-3 mt-3" style={{ borderTop: `1px solid ${C.line}` }}>
          <button onClick={() => { setPage("myProfile"); onClose(); }} className="w-full flex items-center gap-2.5 text-left rounded-xl px-3 py-2.5">
            <Avatar init={me.init} src={me.avatarUrl} tone="em" size={32} />
            <div className="min-w-0"><div className="text-sm font-medium truncate">{me.name}</div><div className="text-xs truncate" style={{ color: C.ink3 }}>{me.label}</div></div>
          </button>
          <button onClick={() => { onSignOut(); onClose(); }} className="w-full text-left text-sm rounded-xl px-3 py-2.5" style={{ color: C.dangerFg }}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

function TopBar({ query, setQuery, S }) {
  const desktop = useDesktop();
  const [notifOpen, setNotifOpen] = useState(false);
  const feed = S ? buildActivityFeed(S, 30) : [];
  const unread = feed.filter((e) => Date.now() - e.at < 864e5).length; // last 24h
  return (
    <div className="flex items-center gap-3 px-4 md:px-8 py-4 md:py-5">
      <div className="w-8 h-8 rounded-lg items-center justify-center shrink-0" style={{ display: desktop ? "none" : "flex", background: C.side }}>
        <span style={{ ...SERIF, color: C.lime, fontSize: 16 }}>H</span>
      </div>
      <div className="flex items-center gap-2 rounded-xl border px-3.5 py-2.5 flex-1 max-w-xl" style={{ borderColor: C.line, background: "#fff" }}>
        <Search size={17} color={C.ink3} />
        <input id="harbor-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="bg-transparent outline-none text-sm flex-1 min-w-0" />
        <span className="rounded px-1.5 py-0.5" style={{ display: desktop ? "inline" : "none", fontSize: 11, background: C.canvas, color: C.ink2 }}>Ctrl K</span>
      </div>
      <div className="relative shrink-0">
        <button aria-label="Notifications" onClick={() => setNotifOpen((v) => !v)} className="w-10 h-10 md:w-11 md:h-11 rounded-xl border flex items-center justify-center relative" style={{ borderColor: C.line, background: "#fff" }}>
          <Bell size={18} color={C.ink} />
          {unread > 0 && <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full" style={{ background: "#D9573B" }} />}
        </button>
        {notifOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
            <div className="absolute right-0 top-12 z-50 w-80 rounded-xl border p-2" style={{ borderColor: C.line, background: "#fff", boxShadow: "0 12px 32px rgba(20,32,27,0.16)" }}>
              <div className="text-xs font-semibold px-2 py-1.5 tracking-widest" style={{ color: C.ink3 }}>ACTIVITY</div>
              <div className="flex flex-col overflow-y-auto" style={{ maxHeight: 380 }}>
                {feed.length === 0 && <div className="text-sm px-2 py-3" style={{ color: C.ink2 }}>Nothing has happened yet.</div>}
                {feed.map((it, i) => (
                  <button key={i} onClick={() => { it.go(); setNotifOpen(false); }} className="w-full flex items-start gap-2.5 text-left px-2 py-2 rounded-lg" style={{ background: "transparent", borderTop: i ? `1px solid ${C.line}` : "none" }}>
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: C.canvas }}><it.icon size={14} color={C.ink2} /></div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm leading-snug">{it.text}</div>
                      <div className="text-xs" style={{ color: C.ink3 }}>{it.sub ? it.sub + " · " : ""}{ago(it.at)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MiniBars({ data, data2, tone = C.em, tone2 = C.ink, height = 220 }) {
  const max = Math.max(1, ...data, ...(data2 || []));
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {data.map((v, i) => (
        <div key={i} className="flex-1 flex items-end gap-0.5 h-full">
          <div className="rounded-sm flex-1" style={{ height: `${(v / max) * 100}%`, background: i === data.length - 1 ? tone : "#D4E9DE" }} />
          {data2 && <div className="rounded-sm flex-1" style={{ height: `${((data2[i] || 0) / max) * 100}%`, background: tone2 }} />}
        </div>
      ))}
    </div>
  );
}
const TREND = [8, 11, 9, 13, 12, 10, 14, 16, 13, 15, 14, 18];

/* Overview pages */
function statsOf(S, forRecruiter) {
  const c = forRecruiter ? S.cands.filter((x) => x.recruiterId === forRecruiter) : S.cands;
  const pl = forRecruiter ? S.placements.filter((p) => p.recruiterId === forRecruiter) : S.placements;
  const billable = pl.filter((p) => ["Ready", "Invoiced", "Paid"].includes(p.status));
  return { placed: c.filter((x) => x.status === "Placed").length, total: c.length, interviews: c.filter((x) => x.status === "Interview").length, billed: sumByCurrency(billable, "feeNum", "feeCurrency"), ready: pl.filter((p) => p.status === "Ready").length, month: new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" }).toUpperCase() };
}

function OverviewRecOps({ S }) {
  const [period, setPeriod] = useState("Monthly");
  const st = statsOf(S);
  const monthLabel = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  // The Daily/Weekly/Monthly/Yearly toggle now scopes every card on this row by when the
  // record was created, so "Weekly" genuinely means "added in the last 7 days" everywhere.
  const { from: pFrom, to: pTo } = periodRange(period);
  const periodFoot = { Daily: "today", Weekly: "last 7 days", Monthly: "last 30 days", Yearly: "last 12 months" }[period];

  const totalLineup = S.cands.filter((c) => c.createdAt >= pFrom && c.createdAt <= pTo && c.status !== "Rejected" && c.status !== "Placed").length;
  const activeJobs = S.jobs.filter((j) => j.createdAt >= pFrom && j.createdAt <= pTo && j.status !== "Draft" && j.status !== "Closed").length;

  // Payment due is deliberately NOT period-scoped: it's "what's owed right now" (any
  // placement currently sitting in Invoiced status), not tied to when it was created.
  const invoicedDue = S.placements.filter((p) => p.status === "Invoiced");
  const paymentDue = sumByCurrency(invoicedDue, "feeNum", "feeCurrency");

  // Hires / Total billed: how many placements were created, and how much of that is
  // actually billable (Ready to invoice, Invoiced, or Paid — NOT the "Guarantee" stage,
  // which BillingPage treats as not billable yet), within the selected window.
  const periodPlacements = S.placements.filter((p) => p.createdAt >= pFrom && p.createdAt <= pTo);
  const hires = periodPlacements.length;
  const billedPeriod = sumByCurrency(periodPlacements.filter((p) => ["Ready", "Invoiced", "Paid"].includes(p.status)), "feeNum", "feeCurrency");

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <GreetingHeader S={S} kicker={"OVERVIEW · " + st.month} sub="Here is how the agency is performing." />
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex rounded-xl border p-1" style={{ borderColor: C.line, background: "#fff" }}>
            {["Daily", "Weekly", "Monthly", "Yearly"].map((p) => (
              <button key={p} onClick={() => setPeriod(p)} className="rounded-lg px-3 py-2 text-xs font-medium" style={period === p ? { background: C.ink, color: "#fff" } : { color: C.ink2 }}>{p}</button>
            ))}
          </div>
          <Btn icon={Download} kind="dark" onClick={() => S.toast(downloadCSV("recruiter-performance.csv", S.team) ? "Exported recruiter-performance.csv" : "Nothing to export")}>Export</Btn>
        </div>
      </div>
      <KPIGrid cols={5}>
        <KPI dark label="Total lineup" value={totalLineup} foot={"active in pipeline · " + periodFoot} />
        <KPI label="Active jobs" value={activeJobs} foot={"open roles · " + periodFoot} />
        <KPI label="Hires" value={hires} foot={periodFoot} />
        <KPI label="Total billed" value={billedPeriod} foot={periodFoot} />
        <KPI label="Payment due" value={paymentDue} foot={invoicedDue.length + " invoice" + (invoicedDue.length === 1 ? "" : "s") + " awaiting payment"} />
      </KPIGrid>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
        <SubmissionsCard S={S} />
        <AttentionList title="Needs attention" S={S} items={(() => {
          const drafts = linkPeople(S, (l) => l.ai && l.ai.followups && l.ai.followups.state === "draft");
          const review = S.cands.filter((c) => c.status === "In review").map((c) => ({ id: c.id, name: c.name, sub: daysAgo(c.updatedAt || c.createdAt) }));
          const unassigned = S.inbox.filter((x) => !x.assigned).map((x) => ({ id: x.candidateId || null, name: x.name, sub: x.role }));
          const guarantee = S.placements.filter((p) => p.status === "Guarantee").map((p) => ({ id: p.candidateId || null, name: p.name, sub: p.guarantee }));
          const toBill = awaitingBilling(S).map((c) => ({ id: c.id, name: c.name, sub: c.status, onOpen: () => S.startBilling(c.id) }));
          return [
            { icon: CreditCard, t: "Waiting to be billed", s: plural(toBill.length, "candidate") + " placed or hired, not billed yet", tone: "warn", people: toBill, go: "billing" },
            { icon: Sparkles, t: "Screening questions to approve", s: plural(drafts.length, "candidate") + " waiting", tone: "em", people: drafts, go: "candidates" },
            { icon: Clock, t: "Awaiting review", s: plural(review.length, "candidate") + " in review", tone: "warn", people: review, go: "candidates" },
            { icon: InboxIcon, t: "Unassigned applications", s: unassigned.length + " in the inbox", tone: "info", people: unassigned, go: "inbox" },
            { icon: AlertTriangle, t: "Placements in guarantee", s: plural(guarantee.length, "placement"), tone: "danger", people: guarantee, go: "billing" },
          ];
        })()} />
      </div>
      <Card>
        <RecruiterPerformanceChart S={S} />
        <div className="text-xs font-semibold mt-5 mb-1" style={{ color: C.ink3 }}>ALL-TIME TOTALS</div>
        <div>
          <DataTable
            rows={S.team}
            keyField="id"
            columns={[
              { key: "name", label: "RECRUITER", render: (r) => (
                <div className="flex items-center gap-3">
                  <Avatar init={r.init} tone={PEOPLE_TONE[r.init]} />
                  <div><div className="font-medium flex items-center gap-1.5 flex-wrap">{r.name}{r.top && <Pill tone="em">Top</Pill>}</div><div className="text-xs" style={{ color: C.ink2 }}>{r.level}</div></div>
                </div>
              ) },
              { key: "submissions", label: "SUBMISSIONS", render: (r) => r.submissions },
              { key: "interviews", label: "INTERVIEWS", render: (r) => r.interviews },
              { key: "placed", label: "PLACED", render: (r) => r.placed },
              { key: "conv", label: "CONVERSION", render: (r) => <div className="flex items-center gap-2"><ProgressBar pct={r.conv * 8} /><span className="text-xs">{r.conv}%</span></div> },
              { key: "billed", label: "BILLED", render: (r) => <span className="font-medium">{r.billed}</span> },
            ]}
          />
        </div>
      </Card>
    </div>
  );
}

function OverviewRecruiter({ S }) {
  const st = statsOf(S, S.me.id);
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <GreetingHeader S={S} kicker={"MY OVERVIEW · " + st.month} sub="Here is how your candidates are doing." />
        <Btn icon={Download} kind="dark" onClick={() => S.toast(downloadCSV("recruiter-performance.csv", S.team) ? "Exported recruiter-performance.csv" : "Nothing to export")}>Export</Btn>
      </div>
      <KPIGrid>
        <KPI dark label="My placements" value={st.placed} foot="all time" />
        <KPI label="My candidates" value={st.total} foot="on file" />
        <KPI label="My interviews" value={st.interviews} foot="in interview now" />
        <KPI label="My billed" value={st.billed} foot="after guarantee" />
      </KPIGrid>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SubmissionsCard S={S} recruiterId={S.me.id} title="My submissions and placements" />
        <AttentionList title="Your next steps" S={S} items={(() => {
          const matches = S.cands.filter((c) => (c.matches || []).length > 0).map((c) => ({ id: c.id, name: c.name, sub: plural(c.matches.length, "role") }));
          const waiting = linkPeople(S, (l) => l.ai && l.ai.followups && l.ai.followups.state === "sent");
          const routed = linkPeople(S, (l) => l.response === "pending");
          return [
            { icon: Sparkles, t: "Role matches", s: plural(matches.length, "candidate") + " match other roles", tone: "em", people: matches, go: "candidates" },
            { icon: InboxIcon, t: "Waiting on candidates", s: waiting.length + " awaiting screening answers", tone: "warn", people: waiting, go: "candidates" },
            { icon: Mail, t: "Routed roles", s: routed.length + " waiting for candidates to accept", tone: "info", people: routed, go: "candidates" },
          ];
        })()} />
      </div>
    </div>
  );
}

/* Candidates list */
function CandidatesList({ scope, data, openCandidate, setPage, onAddCandidate, S, toast }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("All");
  const [showF, setShowF] = useState(false);
  const [recF, setRecF] = useState("All");
  const [minAi, setMinAi] = useState(0);
  const [roleF, setRoleF] = useState("All");
  const [sourceF, setSourceF] = useState("All");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const gq = (S.query || "").toLowerCase();
  const hit = (c, t) => c.name.toLowerCase().includes(t) || c.role.toLowerCase().includes(t);
  const roles = Array.from(new Set(data.map((c) => c.role).filter(Boolean))).sort();
  const sources = Array.from(new Set(data.map((c) => c.source).filter(Boolean))).sort();
  const fromMs = dateFrom ? new Date(dateFrom + "T00:00:00").getTime() : null;
  const toMs = dateTo ? new Date(dateTo + "T23:59:59").getTime() : null;
  const filtered = data.filter((c) =>
    (tab === "All" || c.status === tab) && hit(c, q.toLowerCase()) && hit(c, gq) &&
    (recF === "All" || c.recruiter === recF) && c.ai >= minAi &&
    (roleF === "All" || c.role === roleF) && (sourceF === "All" || c.source === sourceF) &&
    (fromMs === null || c.createdAt >= fromMs) && (toMs === null || c.createdAt <= toMs));
  const activeFilterCount = [recF !== "All", minAi > 0, roleF !== "All", sourceF !== "All", !!dateFrom, !!dateTo].filter(Boolean).length;
  const tabs = ["All", "In review", "With client", "Interview", "Active file", "Hired", "Placed", "Rejected"].map((t) => ({ key: t, label: t === "All" ? `All ${data.length}` : `${t} ${data.filter((c) => c.status === t).length}` }));
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title={scope === "recruiter" ? "Your candidate bench" : "All candidates"} sub={scope === "recruiter" ? "Every applicant you have sourced, and active file candidates ready to reuse." : `${data.length} candidates across every recruiter, client, and source.`} />
        <div className="flex gap-2.5">
          <Btn icon={Filter} onClick={() => setShowF((v) => !v)} className="flex-1 md:flex-none justify-center">Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</Btn>
          <Btn icon={Download} onClick={() => toast(downloadCSV("candidates.csv", filtered.map(flat)) ? "Exported candidates.csv" : "Nothing to export")} className="flex-1 md:flex-none justify-center">Export</Btn>
          <Btn icon={Upload} kind="dark" className="flex-1 md:flex-none justify-center" onClick={onAddCandidate}>Add candidate</Btn>
        </div>
      </div>
      <Card>
        {showF && (
          <div className="flex flex-wrap gap-3 mb-3 rounded-xl p-3" style={{ background: "#F6F3EC" }}>
            <select value={recF} onChange={(e) => setRecF(e.target.value)} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line }}>
              <option value="All">All recruiters</option>
              {S.team.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
            </select>
            <select value={roleF} onChange={(e) => setRoleF(e.target.value)} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line }}>
              <option value="All">All roles</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={sourceF} onChange={(e) => setSourceF(e.target.value)} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line }}>
              <option value="All">All sources</option>
              {sources.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={minAi} onChange={(e) => setMinAi(Number(e.target.value))} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line }}>
              <option value={0}>Any AI score</option><option value={70}>AI 70%+</option><option value={80}>AI 80%+</option><option value={90}>AI 90%+</option>
            </select>
            <div className="flex items-center gap-1.5">
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line, color: dateFrom ? C.ink : C.ink3 }} />
              <span className="text-xs" style={{ color: C.ink3 }}>to</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line, color: dateTo ? C.ink : C.ink3 }} />
            </div>
            <button onClick={() => { setRecF("All"); setMinAi(0); setRoleF("All"); setSourceF("All"); setDateFrom(""); setDateTo(""); }} className="text-xs" style={{ color: C.em }}>Clear all</button>
          </div>
        )}
        <div className="mb-3"><SearchInput value={q} onChange={setQ} placeholder="Search candidates" /></div>
        <div className="mb-3 overflow-x-auto"><Tabs tabs={tabs} active={tab} setActive={setTab} /></div>
        <DataTable
          rows={filtered}
          onRowClick={openCandidate}
          empty="No candidates match this filter."
          columns={[
            { key: "name", label: "CANDIDATE", render: (c) => (
              <div className="flex items-center gap-3">
                <Avatar init={c.name.split(" ").map((x) => x[0]).join("")} tone={PEOPLE_TONE[c.recruiterInit] || "em"} />
                <div><div className="font-medium">{c.name}</div><div className="text-xs" style={{ color: C.ink2 }}>{c.role}</div></div>
              </div>
            ) },
            { key: "recruiter", label: "RECRUITER", render: (c) => c.recruiter ? <div className="flex items-center gap-2"><Avatar init={c.recruiterInit} tone={PEOPLE_TONE[c.recruiterInit]} size={24} /><span className="text-xs">{c.recruiter}</span></div> : <Pill tone="danger">Unassigned</Pill> },
            { key: "status", label: "STATUS", render: (c) => <StatusPill status={c.status} /> },
            { key: "ai", label: "AI", render: (c) => <Pill tone={!c.ai ? "neutral" : c.ai >= 80 ? "em" : c.ai >= 70 ? "warn" : "danger"}>{c.ai ? c.ai + "%" : "-"}</Pill> },
            { key: "email", label: "EMAIL", render: (c) => <Pill tone={c.email === "Verified" ? "em" : "warn"}>{c.email}</Pill> },
            { key: "activity", label: "ACTIVITY", render: (c) => <span className="text-xs" style={{ color: C.ink2 }}>{c.activity}</span> },
          ]}
        />
      </Card>
    </div>
  );
}

/* Candidate detail */
function CandidateDetail({ candidate, onBack, toast, S }) {
  const [tab, setTab] = useState("companies");
  const status = candidate.status;
  const patch = (fn) => S.updateCand(candidate.id, fn);
  const setStatus = (v) => patch((c) => ({ status: v, timeline: [...c.timeline, { t: "Status set to " + v, d: todayStr(), done: true }] }));
  const [panel, setPanel] = useState(null);
  const [delOpen, setDelOpen] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const confirmDelete = () => {
    setDelBusy(true);
    S.deleteCandidate(candidate.id).then(() => { toast("Candidate deleted"); onBack(); }).catch(() => {}).finally(() => setDelBusy(false));
  };
  const [msg, setMsg] = useState("");
  const [reply, setReply] = useState("");
  const placementJobs = S.jobs.filter((j) => candidate.jobLinks.some((l) => l.jobId === j.id) || candidate.endorsed.some((e) => e.role === j.role && e.company === j.client));
  const [placeJobId, setPlaceJobId] = useState("");
  const placeJob = placementJobs.find((j) => j.id === placeJobId) || placementJobs[0] || null;
  const [fee, setFee] = useState("");
  const [feeCur, setFeeCur] = useState("NGN");
  const [incentive, setIncentive] = useState("");
  const [incentiveCur, setIncentiveCur] = useState("NGN");
  const openPlaced = () => {
    const j = placementJobs[0] || null;
    setPlaceJobId(j ? j.id : "");
    const s = suggestBilling(j, candidate.pay);
    setFee(String(s.fee)); setFeeCur(s.feeCurrency); setIncentive(String(s.incentive)); setIncentiveCur(s.incentiveCurrency);
    setPanel("placed");
  };
  const sug = S.jobs.find((j) => j.status === "Open" && !candidate.endorsed.some((e) => e.role === j.role && e.company === j.client));
  const [fwd, setFwd] = useState(S.jobs[0] ? S.jobs[0].id : 0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reassign, setReassign] = useState(null);
  const comments = candidate.comments;
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [resumeDel, setResumeDel] = useState(false);
  const [resumeDelBusy, setResumeDelBusy] = useState(false);
  /* Upload a resume: saved to storage, read by AI for the profile (skills, experience, notice,
     salary expectation), then every company card the candidate is on is rescreened. */
  const attachCv = async (file) => {
    setAiBusy(true);
    try { await S.uploadResume(candidate.id, file); } catch (e) { setAiBusy(false); return; }
    const cards = candidate.jobLinks.filter((l) => l.response === "accepted").length;
    toast(cards ? "Resume saved. Reading it and rescreening their companies…" : "Resume saved. Reading it…");
    try {
      const r = await S.aiScreen("score_cv", { candidateId: candidate.id, rescreenCards: true });
      toast(r && r.rescreened ? "Resume read. " + r.rescreened + (r.rescreened === 1 ? " company" : " companies") + " rescreened." : "Resume read");
    } catch (e) { toast("Resume saved, but the AI couldn't read it: " + e.message); }
    setAiBusy(false);
  };
  const removeResume = async () => {
    setResumeDelBusy(true);
    try { await S.aiScreen("remove_resume", { candidateId: candidate.id }); setResumeDel(false); toast("Resume removed"); }
    catch (e) { toast(e.message); }
    setResumeDelBusy(false);
  };
  const [unlockBusy, setUnlockBusy] = useState(false);
  const unlockReview = async () => {
    setUnlockBusy(true);
    try { await patch(() => ({ ai_locked: false })); toast("Review unlocked. AI can re-screen this candidate again."); }
    catch (e) { toast(e.message); }
    setUnlockBusy(false);
  };
  const [editForm, setEditForm] = useState(null);
  const openEdit = () => setEditForm({ name: candidate.name, role: candidate.role, location: candidate.location, emailAddr: candidate.emailAddr, phone: candidate.phone, experience: candidate.experience, notice: candidate.notice, pay: candidate.pay });
  const saveEdit = () => {
    if (!editForm.name.trim()) { toast("Name can't be empty"); return; }
    patch(() => ({ ...editForm }));
    setEditForm(null); toast("Candidate details updated");
  };

  const doStatus = (opt) => {
    setMenuOpen(false);
    if (opt === "Not a fit for this role") {
      setStatus("Active file"); setReassign("searching"); toast("Moved to Active file");
      setTimeout(() => setReassign("found"), 1200);
    } else if (opt === "Approve, forward to client") { setStatus("With client"); toast("Forwarded to client"); }
    else if (opt === "Reject") { setStatus("Rejected"); toast("Candidate rejected"); }
    else if (opt === "Mark placed") { openPlaced(); }
    // A recruiter's only status action: flags the candidate for Rec Ops/Admin to confirm.
    // Doesn't create a placement or billing entry — that still only happens via Mark placed.
    else if (opt === "Hired") { setStatus("Hired"); toast("Marked Hired — Rec Ops or an Admin will confirm the placement"); }
    else { setStatus("In review"); toast("Status set to hold"); }
  };
  const markPlaced = async () => {
    const amt = num(fee); if (!amt) { toast("Enter the placement fee"); return; }
    const e = candidate.endorsed[candidate.endorsed.length - 1];
    try {
      await S.insertPlacement({
        name: candidate.name, role: placeJob ? placeJob.role + ", " + placeJob.client : (e ? e.role + ", " + e.company : candidate.role),
        candidateId: candidate.id, jobId: placeJob ? placeJob.id : null,
        recruiterId: candidate.recruiterId, recruiterInit: candidate.recruiterInit,
        fee: amt, feeCurrency: feeCur, incentive: incentive ? num(incentive) : null, incentiveCurrency: incentiveCur,
      });
      // insertPlacement itself moves the candidate to "Placed" (it's the single place
      // that creates a placement, so status stays in sync no matter which door was used).
      setPanel(null); setFee(""); setIncentive(""); toast("Marked as placed");
    } catch (e) { toast(e.message || "Could not record the placement"); }
  };
  const postComment = () => {
    if (!draft.trim()) { setErr("Write a note before posting."); return; }
    patch((c) => ({ comments: [{ who: S.me.first, role: S.me.label, init: S.me.init, tone: "info", when: "Just now", text: draft }, ...c.comments] }));
    setDraft(""); setErr("");
  };

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Candidates</button>
      <Modal open={panel === "msg"} onClose={() => setPanel(null)} title={"Message " + candidate.name.split(" ")[0]}>
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={4} placeholder="Write your message" className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none mb-4" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <Btn kind="primary" full onClick={() => { if (!msg.trim()) { toast("Write a message first"); return; } patch((c) => ({ timeline: [...c.timeline, { t: "Message sent: " + msg.slice(0, 60), d: todayStr(), done: true }] })); setMsg(""); setPanel(null); toast("Message logged. Email delivery needs your backend."); }}>Send message</Btn>
      </Modal>
      <Modal open={!!editForm} onClose={() => setEditForm(null)} title="Edit candidate details">
        {editForm && (
          <div className="flex flex-col gap-3">
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Name</label><input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Role</label><input value={editForm.role} onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Location</label><input value={editForm.location} onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Email</label><input value={editForm.emailAddr} onChange={(e) => setEditForm((f) => ({ ...f, emailAddr: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Phone</label><input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Experience</label><input value={editForm.experience} onChange={(e) => setEditForm((f) => ({ ...f, experience: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Notice</label><input value={editForm.notice} onChange={(e) => setEditForm((f) => ({ ...f, notice: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Salary expectation</label><input value={editForm.pay} onChange={(e) => setEditForm((f) => ({ ...f, pay: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            </div>
            <Btn kind="primary" full onClick={saveEdit}>Save changes</Btn>
          </div>
        )}
      </Modal>
      <Modal open={panel === "placed"} onClose={() => setPanel(null)} title="Mark as placed">
        <div className="flex flex-col gap-3">
          {placementJobs.length > 0 && (
            <div>
              <label className="text-xs font-medium" style={{ color: C.ink2 }}>Role placed on</label>
              <select value={placeJobId} onChange={(e) => { setPlaceJobId(e.target.value); const j = placementJobs.find((x) => x.id === e.target.value); const s = suggestBilling(j, candidate.pay); setFee(String(s.fee)); setFeeCur(s.feeCurrency); setIncentive(String(s.incentive)); setIncentiveCur(s.incentiveCurrency); }} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }}>
                {placementJobs.map((j) => <option key={j.id} value={j.id}>{j.role} – {j.client}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Client fee</label><input value={fee} onChange={(e) => setFee(e.target.value)} placeholder="e.g. 1500000" className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Currency</label><select value={feeCur} onChange={(e) => setFeeCur(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Recruiter incentive</label><input value={incentive} onChange={(e) => setIncentive(e.target.value)} placeholder="optional" className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Currency</label><select value={incentiveCur} onChange={(e) => setIncentiveCur(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
          </div>
          <div className="text-xs" style={{ color: C.ink3 }}>Prefilled from this role's billing settings — edit as needed before confirming.</div>
          <Btn kind="primary" full onClick={markPlaced}>Confirm placement</Btn>
        </div>
      </Modal>
      <Modal open={panel === "fwd"} onClose={() => setPanel(null)} title="Forward to a client">
        <div className="flex flex-col gap-2 mb-4">
          {S.jobs.filter((j) => j.status !== "Closed").map((j) => (
            <button key={j.id} onClick={() => setFwd(j.id)} className="rounded-xl border p-3 text-sm text-left" style={{ borderColor: fwd === j.id ? C.em : C.line, background: fwd === j.id ? C.emTint : "#fff" }}>{j.role}, {j.client}</button>
          ))}
        </div>
        <Btn kind="primary" full onClick={() => { const j = S.jobs.find((x) => x.id === fwd); if (!j) { toast("Pick a role"); return; } patch((c) => ({ status: "With client", endorsed: [...c.endorsed, { company: j.client, role: j.role, by: todayStr() + " by " + S.me.first, status: "With client", next: "Awaiting feedback" }], timeline: [...c.timeline, { t: "Forwarded to " + j.client, d: todayStr(), done: true }] })); setPanel(null); toast("Forwarded to " + j.client); }}>Forward</Btn>
      </Modal>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <div className="md:col-span-2 flex flex-col gap-4">
          <Card>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-4">
              <Avatar init={candidate.name.split(" ").map((x) => x[0]).join("")} tone="em" size={64} />
              <div className="flex-1 min-w-0">
                <div className="text-2xl md:text-3xl" style={{ ...SERIF }}>{candidate.name}</div>
                <div className="text-sm font-medium mt-0.5" style={{ color: C.em }}>{candidate.role || "Role not set"}</div>
                <div className="text-sm flex items-center gap-1 mt-0.5" style={{ color: C.ink2 }}><MapPin size={13} className="shrink-0" />{candidate.location || "Location not set"}</div>
              </div>
            </div>
            {candidate.ai_locked && (
              <div className="rounded-lg p-2.5 mb-3 flex items-center gap-2 text-xs flex-wrap" style={{ background: C.warnBg, color: C.warnFg }}>
                <Lock size={13} className="shrink-0" />
                <span className="flex-1">Review locked{candidate.ai_locked_reason ? " — " + candidate.ai_locked_reason : ""}. The AI can't overwrite this candidate's score, skills, strengths or gaps until unlocked.</span>
                {S.role === "admin" && <button type="button" onClick={unlockReview} disabled={unlockBusy} className="font-medium underline shrink-0">{unlockBusy ? "Unlocking…" : "Unlock"}</button>}
              </div>
            )}
            <div className="flex flex-wrap gap-2 mb-3">
              <Btn icon={Pencil} onClick={openEdit} className="flex-1 sm:flex-none justify-center">Edit</Btn>
              <Btn icon={MessageSquare} onClick={() => setPanel("msg")} className="flex-1 sm:flex-none justify-center">Message</Btn>
              {S.role !== "recruiter" && <Btn onClick={() => setPanel("fwd")} className="flex-1 sm:flex-none justify-center">Forward</Btn>}
              {S.role === "admin" && <Btn icon={X} onClick={() => setDelOpen(true)} className="flex-1 sm:flex-none justify-center">Delete</Btn>}
              {S.role === "recruiter" ? (
                !["Hired", "Placed", "Rejected"].includes(status) && (
                  <Btn kind="primary" className="flex-1 sm:flex-none justify-center" onClick={() => doStatus("Hired")}>Mark hired</Btn>
                )
              ) : (
              <div className="relative flex-1 sm:flex-none">
                <Btn kind="primary" className="w-full justify-center" onClick={() => setMenuOpen((m) => !m)}>Update status</Btn>
                {menuOpen && (
                  <div className="absolute right-0 top-11 rounded-xl border shadow-lg z-10 w-56 py-1" style={{ background: "#fff", borderColor: C.line }}>
                    {["Hold", "Approve, forward to client", "Not a fit for this role", "Mark placed", "Reject"].map((o) => (
                      <button key={o} onClick={() => doStatus(o)} className="w-full text-left px-3.5 py-2.5 text-sm" style={{ color: o === "Reject" ? C.dangerFg : C.ink }}>{o}</button>
                    ))}
                  </div>
                )}
              </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2 mb-4">
              <StatusPill status={status} />
              <Pill tone="em">Verified, opened {candidate.opens}x</Pill>
              {candidate.recruiter && <Pill tone="neutral">Sourced by {candidate.recruiter}</Pill>}
            </div>
            {reassign && (
              <div className="rounded-xl p-4 mb-4" style={{ background: C.emTint }}>
                {reassign === "searching" && <div className="text-sm flex items-center gap-2" style={{ color: C.em }}><Sparkles size={15} /> Comparing against other open roles&hellip;</div>}
                {(reassign === "found" || reassign === "submitted") && (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="text-sm" style={{ color: C.em }}>{reassign === "found" ? <><Sparkles size={15} className="inline mr-1" />{sug ? <>Suggested: <b>{sug.role}, {sug.client}</b></> : "No other open roles right now"}</> : "Submitted to " + (sug ? sug.role + ", " + sug.client : "the role")}</div>
                    {reassign === "found" && sug && <Btn kind="primary" onClick={() => { setReassign("submitted"); patch((c) => ({ status: "With client", endorsed: [...c.endorsed, { company: sug.client, role: sug.role, by: todayStr() + " by " + S.me.first, status: "With client", next: "Awaiting feedback" }] })); toast("Submitted to " + sug.role); }}>Submit to this role</Btn>}
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-3 gap-4 mb-4">
              {[["Experience", candidate.experience], ["Notice", candidate.notice], ["Salary expectation", candidate.pay]].map(([l, v]) => (
                <div key={l} className="min-w-0"><div className="text-xs" style={{ color: C.ink3 }}>{l}</div><div className="text-sm font-medium mt-0.5 break-words">{v || "-"}</div></div>
              ))}
            </div>
            <div className="mb-4">
              <div className="text-xs mb-1.5" style={{ color: C.ink3 }}>SKILLS</div>
              {candidate.skills.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">{candidate.skills.map((s, i) => <Pill key={i} tone="neutral">{s}</Pill>)}</div>
              ) : <div className="text-sm" style={{ color: C.ink3 }}>No skills on file yet.</div>}
            </div>
            <IndustryExperience candidate={candidate} S={S} toast={toast} />
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 pt-4 text-sm" style={{ borderTop: `1px solid ${C.line}` }}>
              <div className="flex items-center gap-2 min-w-0" style={{ color: C.ink2 }}><Mail size={15} className="shrink-0" /><span className="truncate">{candidate.emailAddr || "No email on file"}</span></div>
              <div className="flex items-center gap-2" style={{ color: C.ink2 }}><Phone size={15} className="shrink-0" />{candidate.phone || "No phone on file"}</div>
              <div className="flex items-center gap-1.5 sm:ml-auto">
                {aiBusy ? (
                  <span className="text-sm flex items-center gap-2" style={{ color: C.ink2 }}>Reading resume <InlineDots /></span>
                ) : candidate.cv ? (
                  <>
                    <Download size={15} color={C.em} className="shrink-0" />
                    <button type="button" onClick={() => S.openResume(candidate.cv)} className="text-sm font-medium" style={{ color: C.em }} title={candidate.cvName || "Resume"}>View resume</button>
                    <button type="button" aria-label="Remove resume" title="Remove resume" onClick={() => setResumeDel(true)} className="w-6 h-6 rounded-full border flex items-center justify-center" style={{ borderColor: C.line, color: C.ink2, background: "#fff" }}><X size={11} strokeWidth={2.5} /></button>
                  </>
                ) : (
                  <label className="inline-flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg border border-dashed cursor-pointer" style={{ borderColor: "#BFB9AB", color: C.ink }}>
                    <Upload size={14} />Upload resume
                    <input type="file" accept={RESUME_ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) attachCv(f); }} />
                  </label>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <div className="overflow-x-auto"><Tabs tabs={[{ key: "companies", label: "Companies" }, { key: "discussion", label: "Discussion" }, { key: "timeline", label: "Timeline" }]} active={tab} setActive={setTab} /></div>
            {tab === "companies" && (
              <div className="mt-4">
                <CompanyScreeningCards candidate={candidate} S={S} toast={toast} />
              </div>
            )}
            {tab === "discussion" && (
              <div className="mt-4">
                <div className="rounded-lg p-2.5 mb-3 flex items-center gap-2 text-xs" style={{ background: C.warnBg, color: C.warnFg }}><Lock size={13} className="shrink-0" /> Internal. Not visible to candidates or clients.</div>
                <div className="flex flex-col sm:flex-row gap-2 mb-1">
                  <input value={draft} onChange={(e) => { setDraft(e.target.value); setErr(""); }} placeholder="Add a note. Type @ to tag a teammate." className="flex-1 rounded-lg border px-3 py-2.5 text-sm outline-none min-w-0" style={{ borderColor: C.line }} />
                  <Btn kind="primary" onClick={postComment}>Post</Btn>
                </div>
                {err && <div className="text-xs mb-2" style={{ color: C.dangerFg }}>{err}</div>}
                {comments.map((c, i) => (
                  <div key={i} className="flex gap-3 py-3" style={{ borderTop: `1px solid ${C.line}` }}>
                    <Avatar init={c.init} tone={c.tone} size={30} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm flex flex-wrap items-center gap-1.5"><b className="font-medium">{c.who}</b><Pill tone="neutral">{c.role}</Pill><span className="text-xs" style={{ color: C.ink3 }}>{c.when}</span></div>
                      <div className="text-sm mt-0.5" style={{ color: C.ink2 }}>{c.text.split(/(@\w+)/g).map((part, j) => part.startsWith("@") ? <span key={j} style={{ color: C.infoFg, fontWeight: 500 }}>{part}</span> : part)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {tab === "timeline" && (
              <div className="mt-4">
                {candidate.timeline.map((t, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="flex flex-col items-center shrink-0">
                      <div className="w-3 h-3 rounded-full mt-1" style={t.done ? { background: C.em } : { border: `2px solid ${C.infoFg}` }} />
                      {i < candidate.timeline.length - 1 && <div className="w-0.5 flex-1" style={{ background: C.line }} />}
                    </div>
                    <div className="pb-4"><div className="text-sm font-medium">{t.t}</div><div className="text-xs" style={{ color: C.ink3 }}>{t.d}</div></div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <CandidateJobsCard candidate={candidate} S={S} toast={toast} />
          <Card>
            <SectionTitle title="Candidate page" sub="Their secure link. No login needed." size="text-xl" />
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 mt-3 text-sm" style={{ background: C.canvas }}><Lock size={14} color={C.ink2} className="shrink-0" /><span style={{ color: C.ink2 }} className="truncate">{window.location.host + "/?c=" + candidate.portal}</span><Copy size={15} color={C.ink2} className="ml-auto cursor-pointer shrink-0" onClick={() => { try { navigator.clipboard.writeText(window.location.origin + window.location.pathname + "?c=" + candidate.portal); toast("Link copied"); } catch (e) { toast("Copy failed. Select the link and copy it."); } }} /></div>
          </Card>
          <MatchesCard candidate={candidate} S={S} toast={toast} />
        </div>
      </div>
      <ConfirmModal
        open={delOpen}
        onClose={() => setDelOpen(false)}
        title="Delete this candidate?"
        body={"This permanently removes " + candidate.name + "'s profile, resume, screening history, and pipeline links. This can't be undone."}
        onConfirm={confirmDelete}
        busy={delBusy}
      />
      <ConfirmModal
        open={resumeDel}
        onClose={() => setResumeDel(false)}
        title="Remove this resume?"
        body={"This deletes " + (candidate.cvName || "the resume") + " from " + candidate.name + "'s profile. Their screening results stay until the next rescreen."}
        onConfirm={removeResume}
        busy={resumeDelBusy}
        confirmLabel="Remove"
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* AI screening: one collapsible card per company the candidate is on.       */
/* ------------------------------------------------------------------------- */
const VERDICT_TONE = { "Perfect fit": "em", "Possible fit": "warn", Reject: "danger" };
const FOLLOW_PILL = { draft: ["Waiting for approval", "warn"], sent: ["Sent · waiting for answers", "info"], answered: ["Answered", "em"] };
const NICE_RE = /\s*\((nice to have|preferred)\)\s*$/i;
// Why the card has its verdict: the stored reason, or one built from the must-have checklist.
function verdictWhy(ai) {
  // The label already names the verdict, so drop a reason that starts by repeating it.
  if (ai.verdict_reason) return String(ai.verdict_reason).replace(/^(perfect fit|possible fit|not a fit|rejected?)(\s*\([^)]*\))?[.:]\s*/i, "");
  const must = (ai.requirements || []).filter((r) => r.type === "must");
  if (!must.length) return "";
  const miss = must.filter((r) => r.status === "not met").map((r) => r.requirement);
  const part = must.filter((r) => r.status === "partial").map((r) => r.requirement);
  if (!miss.length && !part.length) return "Meets every must-have requirement.";
  return (miss.length ? "Missing must-have: " + miss.join("; ") + ". " : "") + (part.length ? "Partly shown: " + part.join("; ") + "." : "");
}
// A section of the card that folds away to one line.
function Fold({ title, count, pill, sub, open, onToggle, children }) {
  return (
    <div className="rounded-xl" style={{ background: "#fff" }}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-2 px-3.5 py-3 text-left flex-wrap">
        <span className="text-sm font-semibold">{title}</span>
        {count && <span className="text-xs" style={{ color: C.ink3 }}>{count}</span>}
        <span className="ml-auto flex items-center gap-2">{pill}<ChevronDown size={16} color={C.ink2} style={{ transform: open ? "rotate(180deg)" : "none" }} /></span>
      </button>
      {open && <div className="px-3.5 pb-3.5 flex flex-col gap-2.5">{sub && <div className="text-xs -mt-1" style={{ color: C.ink2 }}>{sub}</div>}{children}</div>}
    </div>
  );
}

function CompanyScreeningCards({ candidate, S, toast }) {
  const groups = [];
  candidate.jobLinks
    .filter((l) => l.response === "accepted")
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((l) => {
      const job = S.jobs.find((j) => j.id === l.jobId);
      if (!job) return;
      let g = groups.find((x) => x.company === job.client);
      if (!g) { g = { company: job.client, items: [] }; groups.push(g); }
      g.items.push({ link: l, job });
    });
  // A submission belongs to a card when it's the same company, or the same role as a job on
  // that card (so a client renamed after submitting doesn't show up as a second company).
  const onGroup = (g, e) => e.company === g.company || g.items.some((x) => x.job.role === e.role);
  const otherSubs = candidate.endorsed.filter((e) => !groups.some((g) => onGroup(g, e)));
  const [open, setOpen] = useState(() => (groups[0] ? { [groups[0].company]: true } : {}));
  if (!groups.length && !otherSubs.length) return (
    <div className="text-sm py-6 text-center" style={{ color: C.ink3 }}>No companies yet. Add them to a job from the Jobs card, or route them to a role they match. A screening card appears here once they're on it.</div>
  );
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <CompanyCard key={g.company} group={g} endorsed={candidate.endorsed.filter((e) => onGroup(g, e))} open={!!open[g.company]}
          onToggle={() => setOpen((o) => ({ ...o, [g.company]: !o[g.company] }))} candidate={candidate} S={S} toast={toast} />
      ))}
      {otherSubs.length > 0 && (
        <div className="mt-1">
          <div className="text-xs font-semibold mb-1" style={{ color: C.ink3 }}>OTHER SUBMISSIONS</div>
          {otherSubs.slice().reverse().map((e, i) => (
            <div key={i} className="flex items-center gap-3 py-3" style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
              <div className="w-10 h-10 rounded-lg flex items-center justify-center font-semibold shrink-0" style={{ background: C.canvas }}>{e.company[0]}</div>
              <div className="flex-1 min-w-0"><div className="font-medium text-sm">{e.company}</div><div className="text-xs" style={{ color: C.ink2 }}>{e.role}</div></div>
              <div className="text-right shrink-0"><StatusPill status={e.status} /><div className="text-xs mt-1" style={{ color: C.ink3 }}>{e.next}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CompanyCard({ group, endorsed, open, onToggle, candidate, S, toast }) {
  const [idx, setIdx] = useState(0);
  const { link, job } = group.items[Math.min(idx, group.items.length - 1)];
  const ai = link.ai || {};
  const f = ai.followups || null;
  const staff = S.role === "admin" || S.role === "recops";
  const first = candidate.name.split(" ")[0];
  const e = endorsed.find((x) => x.role === job.role) || null;
  const status = e ? e.status : link.stage;
  const [busy, setBusy] = useState("");
  // Editable copy of the drafted follow-up questions; reset whenever a new screening lands.
  const stamp = (ai.updatedAt || "") + (f ? f.state : "");
  const [drafts, setDrafts] = useState(null);
  const [seen, setSeen] = useState(stamp);
  if (stamp !== seen) { setSeen(stamp); setDrafts(null); }
  const qList = drafts !== null ? drafts : f && f.state === "draft" ? f.questions.map((x) => x.q) : [];
  const editing = staff && ((f && f.state === "draft") || (!f && drafts !== null));
  const setQ = (i, v) => setDrafts(qList.map((q, k) => (k === i ? v : q)));
  const run = async (label, fn) => { setBusy(label); try { await fn(); } catch (err) { toast(err.message); } setBusy(""); };
  const screen = () => run("screen", async () => { await S.aiScreen("screen", { linkId: link.id }); toast("Screened for " + job.client); });
  const approve = () => run("approve", async () => {
    const qs = qList.map((q) => q.trim()).filter(Boolean);
    if (!qs.length) throw new Error("Add at least one question");
    await S.aiScreen("approve_questions", { linkId: link.id, questions: qs });
    toast("Sent to " + first + "'s candidate page");
  });
  const appQs = job.screeningQuestions || [];
  const answered = appQs.filter((_, i) => String(link.screeningAnswers[i] || "").trim()).length;
  const box = { background: "#fff" };
  // Question sections start folded; the follow-up opens itself when it needs someone to act.
  const [showApp, setShowApp] = useState(false);
  const [showFollow, setShowFollow] = useState(null);
  const [showReqs, setShowReqs] = useState(false);
  const followOpen = showFollow !== null ? showFollow : editing || (f && f.state === "draft");
  const why = verdictWhy(ai);
  const gapList = (ai.gaps || []).map((x) => ({ text: String(x).replace(NICE_RE, ""), nice: NICE_RE.test(String(x)) }));
  const mustGaps = gapList.filter((g) => !g.nice), niceGaps = gapList.filter((g) => g.nice);
  const reqs = ai.requirements || [];
  const reqGroups = [
    { key: "must", label: "MUST-HAVE", note: "decides the verdict", items: reqs.filter((r) => r.type === "must") },
    { key: "preferred", label: "NICE TO HAVE", note: "never a reason to reject", items: reqs.filter((r) => r.type !== "must") },
  ].filter((g) => g.items.length);
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: C.line, background: "#F6F3EC" }}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-3 px-4 py-3.5 text-left">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center font-semibold shrink-0" style={{ background: "#fff" }}>{group.company[0]}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{group.company}</div>
          <div className="text-xs truncate" style={{ color: C.ink2 }}>{group.items.map((x) => x.job.role).join(", ")} · {f && f.state === "sent" ? "Questions sent, waiting for " + first + "'s answers" : status}</div>
        </div>
        {busy === "screen" ? <InlineDots /> : <div className="text-2xl shrink-0" style={{ ...SERIF }}>{ai.score != null ? ai.score + "%" : "–"}</div>}
        {ai.verdict && <span className="hidden sm:inline"><Pill tone={VERDICT_TONE[ai.verdict] || "neutral"}>{ai.verdict}</Pill></span>}
        <ChevronDown size={18} color={C.ink2} className="shrink-0" style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-3.5">
          {group.items.length > 1 && <Tabs tabs={group.items.map((x, i) => ({ key: i, label: x.job.role }))} active={idx} setActive={setIdx} />}
          {ai.verdict && <span className="sm:hidden w-fit"><Pill tone={VERDICT_TONE[ai.verdict] || "neutral"}>{ai.verdict}</Pill></span>}
          {candidate.ai_locked && (
            <div className="rounded-lg p-2.5 flex items-center gap-2 text-xs" style={{ background: C.warnBg, color: C.warnFg }}>
              <Lock size={13} className="shrink-0" /> Locked — manually reviewed. {S.role === "admin" ? "Unlock from the candidate header to let the AI re-screen." : "An admin can unlock it to let the AI re-screen."}
            </div>
          )}
          {!ai.stage ? (
            <div className="rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center gap-3" style={box}>
              <div className="text-sm flex-1" style={{ color: C.ink2 }}>Not screened yet. The AI reads {candidate.cv ? "their resume" : "their answers (no resume on file)"} and any answers they've given, for this and other jobs.</div>
              <Btn kind="primary" onClick={screen} disabled={!!busy || candidate.ai_locked}>{busy === "screen" ? <>Screening <InlineDots color="#fff" /></> : "Screen now"}</Btn>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs flex-wrap" style={{ color: C.ink2 }}>
                <Sparkles size={14} color={C.em} className="shrink-0" />
                <span>{ai.stage === "final" ? "Final screening" : "First screening"} · {ai.usedResume ? "resume + " : "no resume · "}{ai.answersUsed || 0} {ai.answersUsed === 1 ? "answer" : "answers"} · updated {ai.updatedAt ? fdate(ai.updatedAt) : "–"}</span>
                {!candidate.ai_locked && <button type="button" onClick={screen} disabled={!!busy} className="ml-auto font-medium" style={{ color: C.em }}>{busy === "screen" ? "Screening…" : "Rescreen"}</button>}
              </div>
              {ai.summary && <div className="text-sm leading-relaxed">{ai.summary}</div>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-xs font-semibold mb-1.5" style={{ color: C.ink3 }}>STRENGTHS</div>
                  {(ai.strengths || []).length ? ai.strengths.map((x, i) => <div key={i} className="flex gap-2 text-sm mb-1"><Check size={15} color={C.em} className="shrink-0 mt-0.5" />{x}</div>) : <div className="text-sm" style={{ color: C.ink3 }}>None noted</div>}
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1.5" style={{ color: C.ink3 }}>GAPS</div>
                  {!gapList.length && <div className="text-sm" style={{ color: C.ink3 }}>None noted</div>}
                  {mustGaps.map((g, i) => <div key={i} className="flex gap-2 text-sm mb-1"><AlertTriangle size={15} color={C.warnFg} className="shrink-0 mt-0.5" />{g.text}</div>)}
                  {niceGaps.map((g, i) => (
                    <div key={"n" + i} className="flex gap-2 text-sm mb-1" style={{ color: C.ink2 }}>
                      <Info size={15} color={C.ink3} className="shrink-0 mt-0.5" /><span>{g.text} <span className="text-xs whitespace-nowrap" style={{ color: C.ink3 }}>· nice to have</span></span>
                    </div>
                  ))}
                </div>
              </div>
              {why && ai.verdict && (
                <div className="rounded-lg px-3 py-2.5 text-sm leading-relaxed" style={{ background: (TONE[VERDICT_TONE[ai.verdict]] || TONE.neutral).bg }}>
                  <span className="font-semibold" style={{ color: (TONE[VERDICT_TONE[ai.verdict]] || TONE.neutral).fg }}>Why {ai.verdict === "Reject" ? "rejected" : ai.verdict.toLowerCase()}: </span>{why}
                </div>
              )}
              {reqGroups.length > 0 && (
                <Fold title="Requirements checklist" open={showReqs} onToggle={() => setShowReqs((v) => !v)}
                  count={reqGroups.map((g) => (g.key === "must" ? "Must-have " : "Nice to have ") + g.items.filter((r) => r.status === "met").length + "/" + g.items.length + " met").join(" · ")}>
                  {reqGroups.map((g) => (
                    <div key={g.key}>
                      <div className="text-xs font-semibold mb-1.5" style={{ color: C.ink3 }}>
                        {g.label} · {g.items.filter((r) => r.status === "met").length}/{g.items.length} met <span className="font-normal">· {g.note}</span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {g.items.map((r, i) => (
                          <div key={i} className="flex gap-2 text-sm items-start">
                            <Pill tone={r.status === "met" ? "em" : r.status === "partial" ? "warn" : g.key === "must" ? "danger" : "neutral"}>{r.status || "?"}</Pill>
                            <div className="flex-1">
                              <span className={g.key === "must" ? "font-medium" : ""} style={g.key === "must" ? null : { color: C.ink2 }}>{r.requirement}</span>
                              {r.evidence && <div className="text-xs mt-0.5" style={{ color: C.ink2 }}>{r.evidence}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </Fold>
              )}
            </>
          )}

          <Fold title="Application questions" count={appQs.length ? "(" + answered + "/" + appQs.length + " answered)" : ""} open={showApp} onToggle={() => setShowApp((v) => !v)}
            sub="The job's own screening questions and the candidate's answers.">
            {appQs.length === 0 && <div className="text-sm" style={{ color: C.ink3 }}>This job has no application questions.</div>}
            {appQs.map((q, i) => {
              const a = String(link.screeningAnswers[i] || "").trim();
              return <div key={i} className="text-sm"><div className="font-medium">{i + 1}. {q}</div><div className="whitespace-pre-line mt-0.5" style={{ color: a ? C.ink2 : C.ink3 }}>{a || "Not answered"}</div></div>;
            })}
          </Fold>

          {(f || editing) && (
            <Fold title="AI additional screening follow-up" count={"(" + (editing ? qList.length : (f.questions || []).length) + ")"} open={followOpen} onToggle={() => setShowFollow(!followOpen)}
              pill={<Pill tone={FOLLOW_PILL[f ? f.state : "draft"][1]}>{FOLLOW_PILL[f ? f.state : "draft"][0]}</Pill>}
              sub={!f || f.state === "draft" ? "Extra questions the AI drafted from what's still unclear after the application questions. Never repeats a question already asked for any job."
                  : f.state === "sent" ? "Approved by " + (f.approvedBy || "Rec Ops") + ". Showing on " + first + "'s candidate page; their answers go straight to the AI."
                  : "Approved by " + (f.approvedBy || "Rec Ops") + (f.answeredAt ? " · answered " + fdate(f.answeredAt) : "")}>
              {editing ? (
                <>
                  {qList.map((q, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <textarea value={q} onChange={(ev) => setQ(i, ev.target.value)} rows={2} className="flex-1 text-sm rounded-lg border px-2.5 py-2" style={{ borderColor: C.line, background: "#FAF8F3" }} aria-label={"Question " + (i + 1)} />
                      <button type="button" aria-label="Remove question" onClick={() => setDrafts(qList.filter((_, k) => k !== i))} className="w-7 h-7 rounded-lg border flex items-center justify-center shrink-0" style={{ borderColor: C.line, color: C.ink2, background: "#fff" }}><X size={12} strokeWidth={2.5} /></button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Btn kind="primary" onClick={approve} disabled={!!busy}>{busy === "approve" ? <>Sending <InlineDots color="#fff" /></> : "Approve and send"}</Btn>
                    <Btn onClick={() => setDrafts([...qList, ""])}>Add a question</Btn>
                  </div>
                </>
              ) : f && f.state === "draft" ? (
                <>
                  {f.questions.map((x, i) => <div key={i} className="text-sm">{i + 1}. {x.q}</div>)}
                  <div className="text-xs" style={{ color: C.warnFg }}>Waiting for Rec Ops or an Admin to approve before they're sent.</div>
                </>
              ) : (
                <>
                  {(f.questions || []).map((x, i) => (
                    <div key={i} className="text-sm"><div className="font-medium">{x.q}</div>{f.state === "answered" && x.a && <div className="whitespace-pre-line mt-0.5" style={{ color: C.ink2 }}>{x.a}</div>}</div>
                  ))}
                  {f.reply && <div className="text-sm whitespace-pre-line" style={{ color: C.ink2 }}>{f.reply}</div>}
                </>
              )}
            </Fold>
          )}
          {!f && !editing && staff && ai.stage && ai.verdict !== "Reject" && (
            <button type="button" onClick={() => setDrafts([""])} className="text-xs font-medium w-fit" style={{ color: C.em }}>+ Ask an AI follow-up question</button>
          )}
        </div>
      )}
    </div>
  );
}

/* Industry experience: each employer on the resume, looked up on the web. "Confirmed" shows
   the industry and the page it came from; "Unsure" means the company couldn't be identified,
   so no industry is claimed. Screening uses this for industry alignment. */
function IndustryExperience({ candidate, S, toast }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const items = candidate.industries || [];
  const confirmed = items.filter((x) => x.confidence === "confirmed");
  const labels = [...new Set(confirmed.map((x) => x.industry))];
  const unsure = items.length - confirmed.length;
  const run = async () => {
    setBusy(true);
    try { const r = await S.aiScreen("industries", { candidateId: candidate.id }); toast("Looked up " + (r.industries || []).length + " employers"); }
    catch (e) { toast(e.message); }
    setBusy(false);
  };
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="text-xs" style={{ color: C.ink3 }}>INDUSTRY EXPERIENCE</div>
        {candidate.cv && (
          <button type="button" onClick={run} disabled={busy} className="ml-auto text-xs font-medium" style={{ color: C.em }}>
            {busy ? <span className="inline-flex items-center gap-1.5">Looking up companies <InlineDots /></span> : items.length ? "Refresh" : "Look up companies"}
          </button>
        )}
      </div>
      {!items.length ? (
        <div className="text-sm" style={{ color: C.ink3 }}>{candidate.cv ? "Not looked up yet. It runs on the next screening, or look it up now." : "Upload a resume to look up their employers."}</div>
      ) : (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center gap-1.5 flex-wrap text-left">
            {labels.map((l, i) => <Pill key={i} tone="em">{l}</Pill>)}
            {unsure > 0 && <Pill tone="warn">{unsure} unsure</Pill>}
            <span className="ml-auto flex items-center gap-1 text-xs" style={{ color: C.ink2 }}>{items.length} employers<ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : "none" }} /></span>
          </button>
          {open && (
            <div className="flex flex-col mt-2">
              {items.map((x, i) => (
                <div key={i} className="flex items-start gap-2 py-2 text-sm" style={{ borderTop: `1px solid ${C.line}` }}>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{x.company}{x.title && <span className="font-normal" style={{ color: C.ink2 }}> · {x.title}</span>}</div>
                    <div className="text-xs" style={{ color: C.ink3 }}>{[x.from, x.to].filter(Boolean).join(" – ") || "Dates not given"}{x.big4_practice ? " · Big 4 practice: " + x.big4_practice : ""}</div>
                    {x.note && <div className="text-xs mt-0.5" style={{ color: C.ink2 }}>{x.note}</div>}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {x.confidence === "confirmed" ? <Pill tone="em">{x.industry}</Pill> : <Pill tone="warn">Unsure</Pill>}
                    {x.source && <a href={x.source} target="_blank" rel="noopener noreferrer" className="text-xs" style={{ color: C.em }}>Source</a>}
                  </div>
                </div>
              ))}
              {candidate.industriesAt && <div className="text-xs pt-1" style={{ color: C.ink3 }}>Looked up {fdate(candidate.industriesAt)}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* Everything the candidate has already answered, across every job they're on. */
function pastAnswers(candidate, S) {
  const out = [];
  candidate.jobLinks.forEach((l) => {
    const j = S.jobs.find((x) => x.id === l.jobId);
    const where = j ? j.role + " · " + j.client : "another role";
    ((j && j.screeningQuestions) || []).forEach((q, i) => { const a = String(l.screeningAnswers[i] || "").trim(); if (a) out.push({ q, a, where }); });
    const f = l.ai && l.ai.followups;
    if (f && f.state === "answered") (f.questions || []).forEach((x) => { if (x.q && String(x.a || "").trim()) out.push({ q: x.q, a: String(x.a).trim(), where }); });
  });
  return out;
}
const Q_TOPICS = [/salar|compensation|pay expectation|base pay/, /notice|start date|when .*start|join/, /visa|sponsor|citizen|green card|work auth|right to work/, /interview availab|availability/, /linkedin/, /cpa|licen[cs]e/, /relocat/, /remote|hybrid|on.?site/, /interviewed .*60 days|recent interviews/];
const qWords = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3));
// An earlier answer that already covers this question: same topic, or mostly the same words.
function coveredBy(q, past) {
  const t = Q_TOPICS.findIndex((re) => re.test(String(q).toLowerCase()));
  const w = qWords(q);
  return past.find((p) => {
    if (t >= 0 && Q_TOPICS[t].test(String(p.q).toLowerCase())) return true;
    const pw = qWords(p.q); if (!w.size || !pw.size) return false;
    let n = 0; w.forEach((x) => { if (pw.has(x)) n++; });
    return n / Math.min(w.size, pw.size) >= 0.6;
  }) || null;
}

/* Review one candidate against one job they're not on: checklist vs resume and earlier answers,
   a short summary, and questions to confirm the fit (already-answered ones flagged). Routing
   sends the role and the chosen questions to their candidate page; the job appears under
   Companies once they accept. */
function FitReviewModal({ open, onClose, candidate, job, S, toast }) {
  const saved = (candidate.matches || []).find((m) => m.job_id === job.id && m.reviewedAt) || null;
  const [review, setReview] = useState(saved);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState(null);
  const [extra, setExtra] = useState([]);
  const [draft, setDraft] = useState("");
  const [showPast, setShowPast] = useState(false);
  const [showReqs, setShowReqs] = useState(true);
  const past = pastAnswers(candidate, S);
  const link = candidate.jobLinks.find((l) => l.jobId === job.id) || null;
  const first = candidate.name.split(" ")[0];
  const staff = S.role === "admin" || S.role === "recops";
  const run = async () => {
    setBusy("review"); setErr("");
    try { const r = await S.aiScreen("review_match", { candidateId: candidate.id, jobId: job.id }); setReview(r.review); setPicked(null); }
    catch (e) { setErr(e.message); }
    setBusy("");
  };
  // First open with no saved review: run it straight away.
  useEffect(() => { if (open && !saved) run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const aiQs = ((review && review.questions) || []).map((x) => {
    const hit = x.already_answered ? { a: x.answer } : coveredBy(x.q, past);
    return { q: x.q, answered: !!hit, answer: hit ? hit.a : "", where: hit && hit.where ? hit.where : "" };
  });
  const allQs = [...aiQs, ...extra];
  const on = picked || allQs.map((x) => !x.answered);
  const chosen = allQs.filter((_, i) => on[i]).map((x) => x.q);
  const toggle = (i) => setPicked(allQs.map((_, k) => (k === i ? !on[k] : on[k])));
  const addQ = () => {
    const q = draft.trim(); if (!q) return;
    const hit = coveredBy(q, past);
    setExtra([...extra, { q, manual: true, answered: !!hit, answer: hit ? hit.a : "", where: hit ? hit.where : "" }]);
    setPicked([...on, true]); setDraft("");
  };
  const route = async () => {
    setBusy("route"); setErr("");
    try {
      await S.aiScreen("route_with_questions", { candidateId: candidate.id, jobId: job.id, questions: chosen, review });
      toast("Routed to " + job.client + ". " + first + " will see it" + (chosen.length ? " with " + chosen.length + " question" + (chosen.length > 1 ? "s" : "") : "") + " on their candidate page.");
      onClose();
    } catch (e) { setErr(e.message); }
    setBusy("");
  };
  const reqs = (review && review.requirements) || [];
  const groups = [
    { key: "must", label: "MUST-HAVE", note: "decides the verdict", items: reqs.filter((r) => r.type === "must") },
    { key: "preferred", label: "NICE TO HAVE", note: "never a reason to reject", items: reqs.filter((r) => r.type !== "must") },
  ].filter((g) => g.items.length);
  const why = review ? verdictWhy(review) : "";
  return (
    <Modal open={open} onClose={onClose} title={"Fit review: " + first} wide>
      <div className="flex flex-col gap-3.5">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0 flex-1"><div className="text-sm font-semibold">{job.role}</div><div className="text-xs" style={{ color: C.ink2 }}>{job.client}{job.location ? " · " + job.location : ""}</div></div>
          {review && <div className="text-2xl" style={{ ...SERIF }}>{review.fit}%</div>}
          {review && <Pill tone={VERDICT_TONE[review.verdict] || "neutral"}>{review.verdict}</Pill>}
        </div>
        {err && <div className="text-sm rounded-lg px-3 py-2" style={{ background: C.dangerBg, color: C.dangerFg }}>{err}</div>}
        {busy === "review" && <div className="text-sm flex items-center gap-2" style={{ color: C.ink2 }}><InlineDots /> Checking {first}'s resume and {past.length} earlier answer{past.length === 1 ? "" : "s"} against this job…</div>}
        {review && busy !== "review" && (
          <>
            <div className="flex items-center gap-2 text-xs flex-wrap" style={{ color: C.ink2 }}>
              <Sparkles size={14} color={C.em} className="shrink-0" />
              <span>{review.usedResume ? "Resume + " : "No resume · "}{review.answersUsed || 0} earlier answer{review.answersUsed === 1 ? "" : "s"} · reviewed {fdate(review.reviewedAt)}</span>
              <button type="button" onClick={run} disabled={!!busy} className="ml-auto font-medium" style={{ color: C.em }}>Review again</button>
            </div>
            {review.summary && <div className="text-sm leading-relaxed">{review.summary}</div>}
            {why && (
              <div className="rounded-lg px-3 py-2.5 text-sm leading-relaxed" style={{ background: (TONE[VERDICT_TONE[review.verdict]] || TONE.neutral).bg }}>
                <span className="font-semibold" style={{ color: (TONE[VERDICT_TONE[review.verdict]] || TONE.neutral).fg }}>Why {review.verdict === "Reject" ? "rejected" : String(review.verdict).toLowerCase()}: </span>{why}
              </div>
            )}
            {groups.length > 0 && (
              <Fold title="Requirements checklist" open={showReqs} onToggle={() => setShowReqs((v) => !v)}
                count={groups.map((g) => (g.key === "must" ? "Must-have " : "Nice to have ") + g.items.filter((r) => r.status === "met").length + "/" + g.items.length + " met").join(" · ")}>
                {groups.map((g) => (
                  <div key={g.key}>
                    <div className="text-xs font-semibold mb-1.5" style={{ color: C.ink3 }}>{g.label} <span className="font-normal">· {g.note}</span></div>
                    <div className="flex flex-col gap-1.5">
                      {g.items.map((r, i) => (
                        <div key={i} className="flex gap-2 text-sm items-start">
                          <Pill tone={r.status === "met" ? "em" : r.status === "partial" ? "warn" : g.key === "must" ? "danger" : "neutral"}>{r.status}</Pill>
                          <div className="flex-1"><span className={g.key === "must" ? "font-medium" : ""} style={g.key === "must" ? null : { color: C.ink2 }}>{r.requirement}</span>{r.evidence && <div className="text-xs mt-0.5" style={{ color: C.ink2 }}>{r.evidence}</div>}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </Fold>
            )}
          </>
        )}
        <div className="rounded-xl" style={{ background: C.canvas }}>
          <Fold title="Their earlier answers" count={"(" + past.length + ")"} open={showPast} onToggle={() => setShowPast((v) => !v)} sub="Everything they've answered for other roles. Used in the review and to flag repeat questions.">
            {!past.length && <div className="text-sm" style={{ color: C.ink3 }}>Nothing answered yet.</div>}
            {past.map((x, i) => <div key={i} className="text-sm"><div className="font-medium">{x.q}</div><div className="whitespace-pre-line mt-0.5" style={{ color: C.ink2 }}>{x.a}</div><div className="text-xs mt-0.5" style={{ color: C.ink3 }}>{x.where}</div></div>)}
          </Fold>
        </div>
        {(review || extra.length > 0) && (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold" style={{ color: C.ink3 }}>QUESTIONS TO CONFIRM THE FIT · {chosen.length} selected</div>
            {allQs.map((x, i) => (
              <label key={i} className="flex gap-2.5 items-start rounded-lg border px-3 py-2.5 cursor-pointer" style={{ borderColor: C.line, background: on[i] ? "#fff" : "#FAF8F3" }}>
                <input type="checkbox" checked={!!on[i]} onChange={() => toggle(i)} className="mt-1" />
                <div className="flex-1 text-sm">
                  <div className="flex items-start gap-2 flex-wrap">
                    <span className="flex-1" style={{ color: on[i] ? C.ink : C.ink2 }}>{x.q}</span>
                    {x.manual && <Pill tone="info">Added by you</Pill>}
                    {x.answered && <Pill tone="warn">Already answered</Pill>}
                  </div>
                  {x.answered && x.answer && <div className="text-xs mt-1" style={{ color: C.ink2 }}>They said: {x.answer}{x.where ? " (" + x.where + ")" : ""}</div>}
                </div>
              </label>
            ))}
            <div className="flex gap-2 items-start">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="Add your own question" aria-label="Add your own question" className="flex-1 text-sm rounded-lg border px-2.5 py-2" style={{ borderColor: C.line, background: "#FAF8F3" }} />
              <Btn onClick={addQ} disabled={!draft.trim()}>Add</Btn>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap pt-1">
          {link ? (
            <span className="text-sm" style={{ color: C.ink2 }}>{link.response === "pending" ? "Already routed, waiting for " + first + " to accept." : link.response === "declined" ? first + " declined this role." : "Already under Companies."}</span>
          ) : (
            <>
              <Btn kind="primary" onClick={route} disabled={!!busy || job.status === "Closed"}>{busy === "route" ? <>Routing <InlineDots color="#fff" /></> : chosen.length ? "Route with " + chosen.length + " question" + (chosen.length > 1 ? "s" : "") : "Route without questions"}</Btn>
              <span className="text-xs flex-1" style={{ color: C.ink2 }}>Goes to {first}'s candidate page{chosen.length ? (staff ? " with the questions" : "; questions wait for Rec Ops approval") : ""}. The job shows under Companies once they accept.</span>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* Roles the candidate could fit that they're not on yet. Review fit opens the fit review;
   routing from there sends the role to their candidate page and the company card appears
   once they accept. Names and scores come from the live job and the latest review. */
function MatchesCard({ candidate, S, toast }) {
  const [reviewJob, setReviewJob] = useState(null);
  const onJob = (id) => candidate.jobLinks.some((l) => l.jobId === id && l.response === "accepted");
  const rows = (candidate.matches || [])
    .map((m) => ({ m, job: S.jobs.find((j) => j.id === m.job_id) }))
    .filter((x) => x.job && x.job.status !== "Closed" && !onJob(x.job.id))
    .sort((a, b) => (b.m.fit || 0) - (a.m.fit || 0));
  const listed = new Set(rows.map((x) => x.job.id));
  const others = S.jobs.filter((j) => j.status !== "Closed" && !listed.has(j.id) && !candidate.jobLinks.some((l) => l.jobId === j.id));
  if (!rows.length && !others.length) return null;
  return (
    <Card>
      <SectionTitle title="Other roles they could fit" sub="Review their fit before routing. A company card appears once you route them and they accept." size="text-xl" />
      {rows.map(({ m, job }) => {
        const link = candidate.jobLinks.find((l) => l.jobId === job.id) || null;
        return (
          <div key={job.id} className="flex items-center justify-between py-2.5 gap-2" style={{ borderTop: `1px solid ${C.line}` }}>
            <div className="min-w-0"><div className="text-sm font-medium truncate">{job.role}</div><div className="text-xs" style={{ color: C.ink2 }}>{job.client}{m.reviewedAt ? " · reviewed " + fdate(m.reviewedAt) : " · not reviewed yet"}</div></div>
            <div className="flex items-center gap-2 shrink-0">
              {m.fit != null && <span className="text-sm font-medium">{m.fit}%</span>}
              {m.verdict && <Pill tone={VERDICT_TONE[m.verdict] || "neutral"}>{m.verdict}</Pill>}
              {link && <span className="text-xs font-medium" style={{ color: link.response === "declined" ? C.dangerFg : C.warnFg }}>{link.response === "declined" ? "Declined" : "Waiting to accept"}</span>}
              <Btn onClick={() => setReviewJob(job)} className="text-xs px-3 py-1.5">{m.reviewedAt ? "Open review" : "Review fit"}</Btn>
            </div>
          </div>
        );
      })}
      {others.length > 0 && (
        <div className="pt-2.5" style={{ borderTop: rows.length ? `1px solid ${C.line}` : "none" }}>
          <select value="" onChange={(e) => { const j = S.jobs.find((x) => x.id === e.target.value); if (j) setReviewJob(j); }} aria-label="Review fit for another open job"
            className="w-full text-sm rounded-lg border px-2.5 py-2" style={{ borderColor: C.line, background: "#FAF8F3" }}>
            <option value="">Review fit for another open job…</option>
            {others.map((j) => <option key={j.id} value={j.id}>{j.role} – {j.client}</option>)}
          </select>
        </div>
      )}
      {reviewJob && <FitReviewModal open onClose={() => setReviewJob(null)} candidate={candidate} job={reviewJob} S={S} toast={toast} />}
    </Card>
  );
}

/* Expandable per-link screening answers editor, shown under a candidate-job link when
   that job has screening questions attached. */
function ScreeningAnswerRow({ link, job, S, toast }) {
  const [open, setOpen] = useState(false);
  const qs = (job && job.screeningQuestions) || [];
  const [answers, setAnswers] = useState(() => qs.map((_, i) => (link.screeningAnswers && link.screeningAnswers[i]) || ""));
  const [saving, setSaving] = useState(false);
  const [scoring, setScoring] = useState(false);
  if (!qs.length) return null;
  const answered = (link.screeningAnswers || []).filter((a) => a && a.trim()).length;
  const setA = (i, v) => setAnswers((arr) => arr.map((a, idx) => (idx === i ? v : a)));
  const save = () => {
    setSaving(true);
    S.setScreeningAnswers(link.id, answers).then(() => toast("Screening answers saved")).catch(() => {}).finally(() => setSaving(false));
  };
  /* Save, then rescreen this company card with the new answers. */
  const saveAndScore = async () => {
    setScoring(true);
    try {
      await S.setScreeningAnswers(link.id, answers);
      if (link.response === "accepted") { await S.aiScreen("screen", { linkId: link.id }); toast("Answers saved and rescreened"); }
      else toast("Answers saved");
    } catch (e) { toast(e.message || "AI screening failed"); }
    setScoring(false);
  };
  return (
    <div className="mt-1.5">
      <button className="text-xs font-medium" style={{ color: C.em }} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Show"} screening answers ({answered}/{qs.length})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {qs.map((q, i) => (
            <div key={i}>
              <div className="text-xs font-medium mb-1" style={{ color: C.ink2 }}>{q}</div>
              <textarea
                className="w-full text-sm rounded-lg border px-2 py-1.5 bg-white"
                style={{ borderColor: C.line, color: C.ink }}
                rows={2}
                value={answers[i] || ""}
                onChange={(e) => setA(i, e.target.value)}
                placeholder="Candidate's answer…"
              />
            </div>
          ))}
          <div className="flex gap-2 flex-wrap">
            <Btn onClick={save} disabled={saving || scoring}>{saving ? "Saving…" : "Save answers"}</Btn>
            <Btn kind="primary" onClick={saveAndScore} disabled={saving || scoring}>{scoring ? <>Screening <InlineDots color="#fff" /></> : "Save and rescreen"}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/* The roles a candidate is attached to (candidate_jobs), with a stage per role. */
function CandidateJobsCard({ candidate, S, toast }) {
  const [pick, setPick] = useState("");
  const available = S.jobs.filter((j) => j.status !== "Closed" && !candidate.jobLinks.some((l) => l.jobId === j.id));
  const sel = "text-sm rounded-lg border px-2 py-1.5 bg-white";
  const pickedJob = pick ? S.jobs.find((j) => j.id === pick) : null;
  const pickedQs = (pickedJob && pickedJob.screeningQuestions) || [];
  const [pendingAnswers, setPendingAnswers] = useState([]);
  const setPickedAnswer = (i, v) => setPendingAnswers((arr) => { const next = arr.slice(); next[i] = v; return next; });
  return (
    <Card>
      <SectionTitle title="Jobs" sub={candidate.jobLinks.length ? "Roles this candidate is attached to." : "Not attached to any job yet."} size="text-xl" />
      {candidate.jobLinks.map((l) => { const j = S.jobs.find((x) => x.id === l.jobId); return (
        <div key={l.id} className="py-2.5" style={{ borderTop: `1px solid ${C.line}` }}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0"><div className="text-sm font-medium truncate">{j ? j.role : "Job removed"}</div><div className="text-xs truncate" style={{ color: l.response === "accepted" ? C.ink2 : C.warnFg }}>{(j ? j.client : "") + (l.response === "pending" ? " · routed, waiting for them to accept" : l.response === "declined" ? " · declined" : l.fit != null ? " · fit " + l.fit + "%" : "")}</div></div>
            <div className="flex items-center gap-2 shrink-0">
              <select className={sel} style={{ borderColor: C.line, color: C.ink }} value={l.stage} onChange={(e) => { const v = e.target.value; S.setStage(l.id, v).then(() => toast("Stage set to " + v)).catch(() => {}); }}>{PIPELINE_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              {S.role !== "recruiter" && <button title="Remove from job" className="px-1" style={{ color: C.ink3 }} onClick={() => S.unlinkJob(l.id).then(() => toast("Removed from job")).catch(() => {})}><X size={14} /></button>}
            </div>
          </div>
          {j && <ScreeningAnswerRow link={l} job={j} S={S} toast={toast} />}
        </div>
      ); })}
      {available.length > 0 && (
        <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${C.line}` }}>
          <div className="flex gap-2">
            <select className={sel + " flex-1 min-w-0"} style={{ borderColor: C.line, color: C.ink }} value={pick} onChange={(e) => { setPick(e.target.value); setPendingAnswers([]); }}>
              <option value="">Add to a job…</option>
              {available.map((j) => <option key={j.id} value={j.id}>{j.role} – {j.client}</option>)}
            </select>
            <Btn kind="primary" onClick={() => { if (!pick) { toast("Pick a job first"); return; } S.linkJob(candidate.id, pick, candidate.ai || null, pendingAnswers).then(() => { setPick(""); setPendingAnswers([]); toast("Added to job"); }).catch(() => {}); }}>Add</Btn>
          </div>
          {pickedQs.length > 0 && (
            <div className="mt-2 space-y-2">
              <div className="text-xs font-medium" style={{ color: C.ink2 }}>This job has screening questions — fill in the candidate's answers now if you have them:</div>
              {pickedQs.map((q, i) => (
                <div key={i}>
                  <div className="text-xs font-medium mb-1" style={{ color: C.ink2 }}>{q}</div>
                  <textarea
                    className="w-full text-sm rounded-lg border px-2 py-1.5 bg-white"
                    style={{ borderColor: C.line, color: C.ink }}
                    rows={2}
                    value={pendingAnswers[i] || ""}
                    onChange={(e) => setPickedAnswer(i, e.target.value)}
                    placeholder="Candidate's answer…"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function InboxPage({ toast, S }) {
  const items = S.inbox;
  const assign = (id, init) => {
    const x = items.find((i) => i.id === id);
    const r = S.team.find((y) => y.init === init);
    if (!r) { toast("That recruiter is not available"); return; }
    S.setInbox((l) => l.map((i) => (i.id === id ? { ...i, assigned: init, assignedId: r.id } : i)));
    S.setCands((l) => [newCandidate({ name: x.name, role: x.role, recruiter: r.name, recruiterId: r.id, recruiterInit: init, ai: x.ai, timeline: [{ t: "Applied via " + x.source + ", assigned to " + r.name, d: fdate(new Date()), done: true }] }), ...l]);
    toast("Assigned to " + r.name);
  };
  const open = items.filter((x) => !x.assigned).length;
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <SectionTitle size="text-3xl md:text-4xl" title="Inbox" sub={open ? `${open} applications need a recruiter.` : "Every application has a recruiter."} />
      <Card>
        <DataTable
          rows={items}
          empty="No applications yet."
          columns={[
            { key: "name", label: "APPLICANT", render: (x) => <div><div className="font-medium">{x.name}</div><div className="text-xs" style={{ color: C.ink2 }}>{x.role}</div></div> },
            { key: "source", label: "SOURCE", render: (x) => <span className="text-xs" style={{ color: C.ink2 }}>{x.source}</span> },
            { key: "ai", label: "AI", render: (x) => <Pill tone={!x.ai ? "neutral" : x.ai >= 80 ? "em" : x.ai >= 70 ? "warn" : "danger"}>{x.ai || "-"}</Pill> },
            { key: "when", label: "RECEIVED", render: (x) => <span className="text-xs" style={{ color: C.ink2 }}>{x.when}</span> },
            { key: "assign", label: "RECRUITER", render: (x) => x.assigned
              ? <div className="flex items-center gap-2"><Avatar init={x.assigned} tone={PEOPLE_TONE[x.assigned] || "em"} size={24} /><span className="text-xs">Assigned</span></div>
              : (S.team.length === 0 ? <span className="text-xs" style={{ color: C.ink3 }}>No recruiters yet</span> : <div className="flex gap-1.5 flex-wrap">{S.team.map((r) => <button key={r.id} onClick={(e) => { e.stopPropagation(); assign(x.id, r.init); }} className="rounded-full" title={r.name}><Avatar init={r.init} tone={PEOPLE_TONE[r.init] || "em"} size={28} /></button>)}</div>) },
          ]}
        />
      </Card>
    </div>
  );
}

function JobDetail({ job, S, toast, onBack, onPromote, onEdit, onDeleted, onAddCandidate }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [fitFor, setFitFor] = useState(null);
  if (!job) return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Jobs</button>
      <div className="text-sm" style={{ color: C.ink3 }}>This job could not be found.</div>
    </div>
  );
  const candidates = S.cands
    .filter((c) => c.jobLinks.some((l) => l.jobId === job.id) || c.endorsed.some((e) => e.company === job.client && e.role === job.role))
    .map((c) => ({ ...c, link: c.jobLinks.find((l) => l.jobId === job.id) || null }))
    .sort((a, b) => ((b.link && b.link.fit) || b.ai || 0) - ((a.link && a.link.fit) || a.ai || 0));
  const activeCount = candidates.filter((c) => !c.link || !["Rejected", "Withdrawn"].includes(c.link.stage)).length;
  const setStatus = (v) => S.setJobStatus(job.id, v);
  const copyLink = () => { try { navigator.clipboard.writeText("https://" + job.link); toast("Link copied"); } catch (e) { toast("Copy failed. Select the link and copy it."); } };
  const fits = suggestFits(job, S.cands).filter((c) => !c.jobLinks.some((l) => l.jobId === job.id));

  // Engage/disengage: job_recruiters is "who's on it now"; job_engagements is the permanent
  // history admins review (per job: who, how long, and why they stepped back).
  const jobEngLog = (S.jobEngagements || []).filter((e) => e.jobId === job.id);
  const myOpenEngagement = jobEngLog.find((e) => e.recruiterId === S.me.id && !e.disengagedAt);
  const engage = () => { setBusy(true); S.engageJob(job.id).then(() => toast("You're engaged on this role")).catch(() => {}).finally(() => setBusy(false)); };
  const confirmDisengage = () => { setBusy(true); S.disengageJob(job.id, reason.trim()).then(() => { setReasonOpen(false); setReason(""); toast("Disengaged from this role"); }).catch(() => {}).finally(() => setBusy(false)); };
  const copyQuestions = () => {
    const text = (job.screeningQuestions || []).map((q, i) => (i + 1) + ". " + q).join("\n");
    try { navigator.clipboard.writeText(text); toast("Screening questions copied"); } catch (e) { toast("Copy failed. Select and copy manually."); }
  };
  const reroute = (c) => {
    S.routeToJob(c.id, job.id).then(() => toast("Routed. " + c.name.split(" ")[0] + " will see it on their candidate page to accept.")).catch(() => {});
  };
  const confirmDelete = () => {
    setDelBusy(true);
    S.deleteJob(job.id).then(() => { toast("Job deleted"); onDeleted && onDeleted(); }).catch(() => {}).finally(() => setDelBusy(false));
  };
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Jobs</button>
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-4">
          <div>
            <div className="text-2xl md:text-3xl" style={{ ...SERIF }}>{job.role}</div>
            <div className="text-sm" style={{ color: C.ink2 }}>{job.client}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn icon={Copy} onClick={copyLink}>Copy link</Btn>
            <Btn icon={Upload} kind="dark" onClick={onAddCandidate}>Add candidate</Btn>
            <Btn onClick={() => onPromote(job.role)}>Promote</Btn>
            {S.role === "recruiter" && (myOpenEngagement
              ? <Btn onClick={() => setReasonOpen(true)} disabled={busy}>Disengage</Btn>
              : <Btn kind="primary" onClick={engage} disabled={busy}>Engage</Btn>)}
            {S.role !== "recruiter" && <Btn icon={Pencil} onClick={onEdit}>Edit</Btn>}
            {S.role === "admin" && <Btn icon={X} onClick={() => setDelOpen(true)}>Delete</Btn>}
            {S.role !== "recruiter" && (
              <div className="relative">
                <Btn kind="primary" onClick={() => setMenuOpen((m) => !m)}>Change status</Btn>
                {menuOpen && (
                  <div className="absolute right-0 top-11 rounded-xl border shadow-lg z-10 w-48 py-1" style={{ background: "#fff", borderColor: C.line }}>
                    {["Open", "Engaged", "Closing", "Closed"].map((o) => (
                      <button key={o} onClick={() => { setStatus(o); setMenuOpen(false); }} className="w-full text-left px-3.5 py-2.5 text-sm" style={{ color: C.ink }}>{o}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mb-4">
          <StatusPill status={job.status} />
          {job.recruiters.length > 0 && <Pill tone="neutral">{job.recruiters.length} recruiter{job.recruiters.length > 1 ? "s" : ""} on this role</Pill>}
          {S.role === "recruiter" && (myOpenEngagement ? <Pill tone="em">You're engaged · since {ago(myOpenEngagement.engagedAt)}</Pill> : <Pill tone="neutral">Not engaged</Pill>)}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
          <div><div className="text-xs" style={{ color: C.ink3 }}>Submitted</div><div className="text-sm font-medium mt-0.5">{job.submitted}</div></div>
          <div><div className="text-xs" style={{ color: C.ink3 }}>Interview</div><div className="text-sm font-medium mt-0.5">{job.interview}</div></div>
          <div><div className="text-xs" style={{ color: C.ink3 }}>Open</div><div className="text-sm font-medium mt-0.5">{job.days}d</div></div>
        </div>
        {(job.location || job.country || job.minPay || job.maxPay || job.commissionOnly || job.employmentType) && (
          <div className="flex flex-wrap gap-4 mb-4 text-sm" style={{ color: C.ink2 }}>
            {job.location && <span>{job.location}</span>}
            {job.workSetup && <span>{job.workSetup}</span>}
            {job.employmentType && <span>{job.employmentType}</span>}
            {job.headcount > 1 && <span>{job.headcount} openings</span>}
            {job.country && <span>Hiring in {job.country}</span>}
            {job.commissionOnly ? <span>Commission-only</span> : (job.minPay || job.maxPay) && <span>{job.minPay ? money(job.minPay, job.currency) : "?"} – {job.maxPay ? money(job.maxPay, job.currency) : "?"} / {(job.salaryPeriod || "Yearly").toLowerCase()}</span>}
          </div>
        )}
        {job.description && (
          <div className="mb-4 pt-4 text-sm whitespace-pre-wrap" style={{ borderTop: `1px solid ${C.line}`, color: C.ink2 }}>{job.description}</div>
        )}
        {job.seo && (job.seo.keywords || []).length > 0 && (
          <div className="mb-4"><div className="text-xs mb-1.5" style={{ color: C.ink3 }}>Search keywords</div><div className="flex flex-wrap gap-1.5">{job.seo.keywords.map((k) => <Pill key={k} tone="neutral">{k}</Pill>)}</div></div>
        )}
        {(job.billingAmount || job.incentiveAmount) && (
          <div className="grid grid-cols-2 gap-4 mb-4 pt-4 text-sm" style={{ borderTop: `1px solid ${C.line}` }}>
            {S.role !== "recruiter" && (
              <div>
                <div className="text-xs" style={{ color: C.ink3 }}>Client billing</div>
                <div className="font-medium mt-0.5">{job.billingAmount ? (job.billingType === "flat" ? money(job.billingAmount, job.billingCurrency) : job.billingAmount + "% of salary") : "Not set"}</div>
                {job.billingAmount && <div className="text-xs mt-0.5" style={{ color: C.ink3 }}>{job.billingFrequency === "Monthly" ? "Monthly" + (job.billingMonths ? ", for " + job.billingMonths + " month" + (job.billingMonths === 1 ? "" : "s") : "") : "One-off, on placement"}</div>}
              </div>
            )}
            <div>
              <div className="text-xs" style={{ color: C.ink3 }}>{S.role === "recruiter" ? "Your incentive" : "Recruiter incentive"}</div>
              <div className="font-medium mt-0.5">{job.incentiveAmount ? (job.incentiveType === "flat" ? money(job.incentiveAmount, job.incentiveCurrency) : job.incentiveAmount + "% of the client fee") : "Not set"}</div>
              {job.incentiveAmount && <div className="text-xs mt-0.5" style={{ color: C.ink3 }}>{job.incentiveFrequency === "Monthly" ? "Monthly" + (job.incentiveMonths ? ", for " + job.incentiveMonths + " month" + (job.incentiveMonths === 1 ? "" : "s") : "") : "One-off, on placement"}</div>}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm" style={{ background: C.canvas }}><Lock size={14} color={C.ink2} className="shrink-0" /><span style={{ color: C.ink2 }} className="truncate">{job.link}</span></div>
      </Card>
      {(job.screeningQuestions || []).length > 0 && (
        <Card>
          <div className="flex items-start justify-between gap-3">
            <SectionTitle title="Screening questions" sub="Ask every applicant these before recording their answers on the candidate's profile." size="text-xl" />
            <Btn icon={Copy} onClick={copyQuestions} className="shrink-0">Copy all</Btn>
          </div>
          <div className="flex flex-col gap-2 mt-3">
            {job.screeningQuestions.map((q, i) => <div key={i} className="text-sm rounded-lg px-3 py-2.5" style={{ background: C.canvas, color: C.ink }}>{i + 1}. {q}</div>)}
          </div>
        </Card>
      )}
      {S.role !== "recruiter" && jobEngLog.length > 0 && (
        <Card>
          <SectionTitle title="Engagement log" sub="Who has worked this role, how long, and why they stepped back." size="text-xl" />
          <div className="mt-3">
            <DataTable
              rows={jobEngLog}
              keyField="id"
              empty="No recruiter has engaged on this role yet."
              columns={[
                { key: "recruiter", label: "RECRUITER", render: (e) => <div className="font-medium">{e.recruiter}</div> },
                { key: "engagedAt", label: "ENGAGED", render: (e) => <span className="text-xs" style={{ color: C.ink2 }}>{fdate(e.engagedAt)}</span> },
                { key: "status", label: "STATUS", render: (e) => e.disengagedAt ? <Pill tone="neutral">Disengaged {fdate(e.disengagedAt)}</Pill> : <Pill tone="em">Still engaged</Pill> },
                { key: "duration", label: "DURATION", render: (e) => formatDuration((e.disengagedAt || Date.now()) - e.engagedAt) },
                { key: "reason", label: "REASON", render: (e) => <span className="text-xs" style={{ color: C.ink2 }}>{e.reason || "-"}</span> },
              ]}
            />
          </div>
        </Card>
      )}
      {fitFor && <FitReviewModal open onClose={() => setFitFor(null)} candidate={S.cands.find((x) => x.id === fitFor.id) || fitFor} job={job} S={S} toast={toast} />}
      {S.role !== "recruiter" && fits.length > 0 && (
        <Card>
          <SectionTitle title="Candidates who might fit this role" sub="From your existing bench, matched on skills and role. Route sends the role to their candidate page to accept." size="text-xl" />
          <div className="flex flex-col gap-2 mt-3">
            {fits.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl border p-3" style={{ borderColor: C.line }}>
                <div className="flex items-center gap-3 min-w-0 cursor-pointer" onClick={() => S.openCandidate(c.id)}>
                  <Avatar init={c.name.split(" ").map((x) => x[0]).join("")} tone="em" />
                  <div className="min-w-0"><div className="font-medium text-sm truncate">{c.name}</div><div className="text-xs truncate" style={{ color: C.ink2 }}>{c.role}{c.recruiter ? " · " + c.recruiter : ""}</div></div>
                </div>
                <div className="flex gap-2 shrink-0"><Btn onClick={() => setFitFor(c)}>Review fit</Btn><Btn kind="primary" onClick={() => reroute(c)}>Route</Btn></div>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <SectionTitle title="Candidates on this role" sub={activeCount + " active \u00b7 " + candidates.length + " total"} size="text-xl" />
        <div className="mt-3">
          <DataTable
            rows={candidates}
            onRowClick={(c) => S.openCandidate(c.id)}
            empty="No candidates submitted to this role yet."
            columns={[
              { key: "name", label: "CANDIDATE", render: (c) => (
                <div className="flex items-center gap-3">
                  <Avatar init={c.name.split(" ").map((x) => x[0]).join("")} tone="em" />
                  <div><div className="font-medium">{c.name}</div><div className="text-xs" style={{ color: C.ink2 }}>{c.recruiter || "Unassigned"}</div></div>
                </div>
              ) },
              { key: "stage", label: "STAGE", render: (c) => c.link && c.link.response !== "accepted" ? (
                <Pill tone={c.link.response === "declined" ? "danger" : "warn"}>{c.link.response === "declined" ? "Declined the role" : "Routed · waiting to accept"}</Pill>
              ) : c.link ? (
                <div className="flex items-center gap-1.5">
                  <select className="text-sm rounded-lg border px-2 py-1.5 bg-white" style={{ borderColor: C.line, color: C.ink }} value={c.link.stage} onClick={(e) => e.stopPropagation()}
                    onChange={(e) => { e.stopPropagation(); const v = e.target.value; S.setStage(c.link.id, v).then(() => toast(c.name.split(" ")[0] + " moved to " + v)).catch(() => {}); }}>
                    {PIPELINE_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  {c.link.stage === "Interview" && S.settings.integrations && S.settings.integrations.googleCalendar && (
                    <a href={gcalUrl(job, c.name)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Add interview to Google Calendar" className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: C.canvas }}>
                      <Clock size={14} color={C.ink2} />
                    </a>
                  )}
                </div>
              ) : <StatusPill status={c.status} /> },
              { key: "cv", label: "RESUME", render: (c) => c.cv ? <button className="text-sm underline" style={{ color: C.em }} onClick={(e) => { e.stopPropagation(); S.openResume(c.cv); }}>View</button> : <span className="text-xs" style={{ color: C.ink3 }}>None</span> },
              { key: "ai", label: "FIT", render: (c) => { const v = c.link && c.link.fit != null ? c.link.fit : c.ai; return <Pill tone={!v ? "neutral" : v >= 80 ? "em" : v >= 60 ? "warn" : "danger"}>{v ? v + "%" : "-"}</Pill>; } },
            ]}
          />
        </div>
      </Card>
      <Modal open={reasonOpen} onClose={() => setReasonOpen(false)} title="Disengage from this role">
        <div className="flex flex-col gap-3">
          <div className="text-sm" style={{ color: C.ink2 }}>A short reason helps admin see why recruiters step back from a role.</div>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="e.g. Client paused the search, or reassigned to another role" className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
          <Btn kind="primary" full onClick={confirmDisengage} disabled={busy}>{busy ? <>Disengaging <InlineDots color="#fff" /></> : "Disengage"}</Btn>
        </div>
      </Modal>
      <ConfirmModal
        open={delOpen}
        onClose={() => setDelOpen(false)}
        title="Delete this job?"
        body={"This permanently removes " + job.role + " at " + job.client + ", along with its screening questions and engagement log. Candidates already attached to it keep their history but lose the link to this role. This can't be undone."}
        onConfirm={confirmDelete}
        busy={delBusy}
      />
    </div>
  );
}

/* Jobs + Post a job + Promote */
function JobsPage({ setPage, onPromote, S, onOpenJob }) {
  const [q, setQ] = useState("");
  const gq = (S.query || "").toLowerCase();
  const hit = (j, t) => j.role.toLowerCase().includes(t) || j.client.toLowerCase().includes(t);
  const filtered = S.jobs.filter((j) => hit(j, q.toLowerCase()) && hit(j, gq));
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="All roles" sub="Every role has its own unique link." />
        <Btn kind="primary" icon={Plus} onClick={() => setPage("postJob")}>Post a job</Btn>
      </div>
      <Card>
        <div className="mb-3"><SearchInput value={q} onChange={setQ} placeholder="Search roles or clients" /></div>
        <DataTable
          rows={filtered}
          onRowClick={(j) => onOpenJob(j.id)}
          columns={[
            { key: "role", label: "ROLE", render: (j) => <div><div className="font-medium">{j.role}</div><div className="text-xs" style={{ color: C.ink2 }}>{j.client}</div></div> },
            { key: "recruiters", label: "RECRUITERS", render: (j) => j.recruiters.length ? <div className="flex -space-x-2">{j.recruiters.map((r, i) => <Avatar key={i} init={r} tone={PEOPLE_TONE[r]} size={26} />)}</div> : <span className="text-xs" style={{ color: C.ink3 }}>None yet</span> },
            { key: "submitted", label: "SUBMITTED", render: (j) => j.submitted },
            { key: "interview", label: "INTERVIEW", render: (j) => j.interview },
            { key: "days", label: "DAYS", render: (j) => `${j.days}d` },
            { key: "status", label: "STATUS", render: (j) => (
              <div className="flex items-center gap-2">
                <StatusPill status={j.status} />
                <button onClick={(e) => { e.stopPropagation(); onPromote(j.role); }} className="text-xs" style={{ color: C.em }}>Promote</button>
              </div>
            ) },
          ]}
        />
      </Card>
    </div>
  );
}

function PostJobForm({ setPage, toast, onPromote, S, onOpenJob, editJob }) {
  const isEdit = !!editJob;
  const [title, setTitle] = useState(editJob ? editJob.role : "");
  const [client, setClient] = useState(editJob ? editJob.client : "");
  const [location, setLocation] = useState(editJob ? (editJob.location || "Lagos, Nigeria") : (S.settings.defaultCountry === "Nigeria" ? "Lagos, Nigeria" : S.settings.defaultCountry || "Lagos, Nigeria"));
  const [workSetup, setWorkSetup] = useState(editJob ? (editJob.workSetup || "") : "");
  const [employmentType, setEmploymentType] = useState(editJob ? (editJob.employmentType || "") : "");
  const [headcount, setHeadcount] = useState(editJob && editJob.headcount != null ? String(editJob.headcount) : "1");
  const [importBusy, setImportBusy] = useState(false);
  const [salaryPeriod, setSalaryPeriod] = useState(editJob ? (editJob.salaryPeriod || "Yearly") : "Yearly");
  const [commissionOnly, setCommissionOnly] = useState(editJob ? !!editJob.commissionOnly : false);
  const [minPay, setMinPay] = useState(editJob && editJob.minPay != null ? String(editJob.minPay) : "");
  const [maxPay, setMaxPay] = useState(editJob && editJob.maxPay != null ? String(editJob.maxPay) : "");
  const [description, setDescription] = useState(editJob ? (editJob.description || "") : "");
  const [currency, setCurrency] = useState(editJob ? (editJob.currency || "NGN") : (S.settings.defaultCurrency || "NGN"));
  const [country, setCountry] = useState(editJob ? (editJob.country || "Nigeria") : (S.settings.defaultCountry || "Nigeria"));
  const [seo, setSeo] = useState(editJob ? (editJob.seo || null) : null);       // applied AI redraft: { meta_description, keywords, original_* }
  const [draftAi, setDraftAi] = useState(null); // AI suggestion awaiting review
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { link, id, status, title, client }
  // What the agency bills the client, and how the recruiter is incentivized on this role.
  const [billingType, setBillingType] = useState(editJob ? (editJob.billingType || "percent") : "percent"); // "percent" of salary, or "flat" fee
  const [billingAmount, setBillingAmount] = useState(editJob && editJob.billingAmount != null ? String(editJob.billingAmount) : "");
  const [billingCurrency, setBillingCurrency] = useState(editJob ? (editJob.billingCurrency || "NGN") : (S.settings.defaultCurrency || "NGN"));
  const [billingFrequency, setBillingFrequency] = useState(editJob ? (editJob.billingFrequency || "One-off") : "One-off"); // "One-off" on placement, or "Monthly" for a period
  const [billingMonths, setBillingMonths] = useState(editJob && editJob.billingMonths != null ? String(editJob.billingMonths) : "");
  const [incentiveType, setIncentiveType] = useState(editJob ? (editJob.incentiveType || "percent") : "percent"); // "percent" of the client fee, or "flat" bonus
  const [incentiveAmount, setIncentiveAmount] = useState(editJob && editJob.incentiveAmount != null ? String(editJob.incentiveAmount) : "");
  const [incentiveCurrency, setIncentiveCurrency] = useState(editJob ? (editJob.incentiveCurrency || "NGN") : (S.settings.defaultCurrency || "NGN"));
  const [incentiveFrequency, setIncentiveFrequency] = useState(editJob ? (editJob.incentiveFrequency || "One-off") : "One-off");
  const [incentiveMonths, setIncentiveMonths] = useState(editJob && editJob.incentiveMonths != null ? String(editJob.incentiveMonths) : "");
  // Questions every applicant must be asked before their answers get recorded on their profile.
  const [questions, setQuestions] = useState(editJob && editJob.screeningQuestions && editJob.screeningQuestions.length ? editJob.screeningQuestions : [""]);
  const setQ = (i, v) => setQuestions((qs) => qs.map((q, idx) => (idx === i ? v : q)));
  const addQ = () => setQuestions((qs) => [...qs, ""]);
  const removeQ = (i) => setQuestions((qs) => qs.filter((_, idx) => idx !== i));
  const runRedraft = async () => {
    if (!title.trim() || description.trim().length < 40) { toast("Add a job title and a few sentences of description first"); return; }
    setAiBusy(true); setDraftAi(null);
    try { setDraftAi(await S.aiRedraft({ title, client, location, country, currency, minPay: num(minPay) || null, maxPay: num(maxPay) || null, description, workSetup, employmentType, salaryPeriod, commissionOnly, headcount: num(headcount) || null })); }
    catch (e) { toast(e.message); }
    setAiBusy(false);
  };
  const useRedraft = () => {
    setSeo({ meta_description: draftAi.meta_description || "", keywords: draftAi.keywords || [], original_title: title, original_description: description });
    setTitle(draftAi.title || title); setDescription(draftAi.description || description); setDraftAi(null);
    toast("AI version applied. You can still edit it.");
  };
  // Upload a job spec / brief file (PDF, Word, text, image) and have AI read it to fill in
  // the form below — title, client, location, salary, work setup and description — so the
  // person doesn't have to retype a brief they already have. Nothing is saved until they
  // review the fields and publish or save as usual.
  const importFromFile = async (file) => {
    if (!file) return;
    setImportBusy(true);
    try {
      const r = await S.parseJobDoc(file);
      if (r.title) setTitle(r.title);
      if (r.client) setClient(r.client);
      if (r.location) setLocation(r.location);
      if (r.workSetup && ["Hybrid", "Remote", "Onsite"].includes(r.workSetup)) setWorkSetup(r.workSetup);
      if (r.employmentType && ["Full-time", "Part-time", "Contract"].includes(r.employmentType)) setEmploymentType(r.employmentType);
      if (r.headcount) setHeadcount(String(r.headcount));
      if (r.country) setCountry(r.country);
      if (r.currency) setCurrency(r.currency);
      if (r.commissionOnly) setCommissionOnly(true);
      if (r.salaryPeriod && ["Yearly", "Monthly", "Weekly", "Daily", "Hourly"].includes(r.salaryPeriod)) setSalaryPeriod(r.salaryPeriod);
      if (r.minPay) setMinPay(String(r.minPay));
      if (r.maxPay) setMaxPay(String(r.maxPay));
      if (r.description) setDescription(r.description);
      if (Array.isArray(r.screeningQuestions) && r.screeningQuestions.length) setQuestions(r.screeningQuestions);
      toast("Filled in from the file — check it over before publishing.");
    } catch (e) { toast(e.message || "Couldn't read that file"); }
    setImportBusy(false);
  };
  const inp = "w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none";
  const inpStyle = { borderColor: C.line, background: "#FAF8F3" };
  const publish = (status) => {
    if (!title.trim() || !client.trim()) { toast("Add a job title and client"); return; }
    const id = uid();
    const slug = (client[0] + title.split(" ").map((w) => w[0]).join("")).toLowerCase() + "-" + String(S.jobs.length + 1).padStart(2, "0");
    const link = "harbor.link/j/" + slug;
    S.setJobs((l) => [{ id, role: title, client, location, workSetup, employmentType, headcount: num(headcount) || 1,
      salaryPeriod, commissionOnly, minPay: commissionOnly ? null : (num(minPay) || null), maxPay: commissionOnly ? null : (num(maxPay) || null), description, currency, country, seo,
      billingType, billingAmount: num(billingAmount) || null, billingCurrency, billingFrequency, billingMonths: billingFrequency === "Monthly" ? (num(billingMonths) || null) : null,
      incentiveType, incentiveAmount: num(incentiveAmount) || null, incentiveCurrency, incentiveFrequency, incentiveMonths: incentiveFrequency === "Monthly" ? (num(incentiveMonths) || null) : null,
      screeningQuestions: questions.map((q) => q.trim()).filter(Boolean),
      recruiters: [], submitted: 0, interview: 0, days: 0, status, link }, ...l]);
    setDone({ link, id, status, title, client });
    toast(status === "Draft" ? "Saved as draft" : "Job published");
  };
  const reset = () => { setDone(null); setTitle(""); setClient(""); setWorkSetup(""); setEmploymentType(""); setHeadcount("1"); setSalaryPeriod("Yearly"); setCommissionOnly(false); setMinPay(""); setMaxPay(""); setDescription(""); setSeo(null); setDraftAi(null); setBillingAmount(""); setBillingFrequency("One-off"); setBillingMonths(""); setIncentiveAmount(""); setIncentiveFrequency("One-off"); setIncentiveMonths(""); setQuestions([""]); };
  const copyLink = () => { try { navigator.clipboard.writeText("https://" + done.link); toast("Link copied"); } catch (e) { toast("Copy failed. Select the link and copy it."); } };
  const saveEdit = () => {
    if (!title.trim() || !client.trim()) { toast("Add a job title and client"); return; }
    setBusy(true);
    S.updateJob(editJob.id, {
      role: title, client, location, workSetup, employmentType, headcount: num(headcount) || 1,
      salaryPeriod, commissionOnly, minPay: commissionOnly ? null : (num(minPay) || null), maxPay: commissionOnly ? null : (num(maxPay) || null), description, currency, country, seo,
      billingType, billingAmount: num(billingAmount) || null, billingCurrency, billingFrequency, billingMonths: billingFrequency === "Monthly" ? (num(billingMonths) || null) : null,
      incentiveType, incentiveAmount: num(incentiveAmount) || null, incentiveCurrency, incentiveFrequency, incentiveMonths: incentiveFrequency === "Monthly" ? (num(incentiveMonths) || null) : null,
      screeningQuestions: questions.map((q) => q.trim()).filter(Boolean),
    }).then(() => { toast("Job updated"); setPage("jobDetail"); }).catch(() => {}).finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <button onClick={() => setPage(isEdit ? "jobDetail" : "jobs")} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> {isEdit ? "Job" : "Jobs"}</button>
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title={isEdit ? "Edit job" : "Post a new job"} sub={isEdit ? "Changes save straight to this listing." : "Publishing creates a unique link for candidates and recruiters."} />
        <div className="flex gap-2">
          {isEdit ? (
            <Btn kind="primary" className="flex-1 md:flex-none justify-center" disabled={busy} onClick={saveEdit}>{busy ? <>Saving <InlineDots color="#fff" /></> : "Save changes"}</Btn>
          ) : (
            <>
              <Btn onClick={() => publish("Draft")} className="flex-1 md:flex-none justify-center">Save as draft</Btn>
              <Btn kind="primary" className="flex-1 md:flex-none justify-center" onClick={() => publish("Open")}>Publish job</Btn>
            </>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <Card className="md:col-span-2 flex flex-col gap-4">
          <div>
            <label className="flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed py-5 cursor-pointer text-center" style={{ borderColor: "#D5D2C7", background: "#FAF8F3" }}>
              <Upload size={18} color={C.ink2} />
              <div className="text-sm font-medium">{importBusy ? <>Reading file <InlineDots /></> : "Upload a job brief (optional)"}</div>
              <div className="text-xs" style={{ color: C.ink3 }}>PDF, Word, text or photo — AI fills in the fields below for you to check</div>
              <input type="file" accept={RESUME_ACCEPT} className="hidden" disabled={importBusy} onChange={(e) => { const f = e.target.files[0]; if (f) importFromFile(f); e.target.value = ""; }} />
            </label>
          </div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Job title</label><input value={title} onChange={(e) => setTitle(e.target.value)} className={inp} style={inpStyle} /></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Client</label><input value={client} onChange={(e) => setClient(e.target.value)} className={inp} style={inpStyle} /></div>
            <div>
              <label className="text-xs font-medium" style={{ color: C.ink2 }}>Employment type</label>
              <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} className={inp} style={inpStyle}>
                <option value="">Not specified</option>
                <option value="Full-time">Full-time</option>
                <option value="Part-time">Part-time</option>
                <option value="Contract">Contract</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium" style={{ color: C.ink2 }}>Work setup</label>
              <select value={workSetup} onChange={(e) => setWorkSetup(e.target.value)} className={inp} style={inpStyle}>
                <option value="">Not specified</option>
                <option value="Onsite">Onsite</option>
                <option value="Hybrid">Hybrid</option>
                <option value="Remote">Remote</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium" style={{ color: C.ink2 }}>Head count</label>
              <input type="number" min="1" value={headcount} onChange={(e) => setHeadcount(e.target.value)} placeholder="1" className={inp} style={inpStyle} />
            </div>
          </div>
          <div className="pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
            <SectionTitle title="Location" sub="Country, then the city or state within it." size="text-base" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
              <div>
                <label className="text-xs font-medium" style={{ color: C.ink2 }}>Country</label>
                <select value={country} onChange={(e) => { const v = e.target.value; setCountry(v); if (COUNTRY_CURRENCY[v]) setCurrency(COUNTRY_CURRENCY[v]); }} className={inp} style={inpStyle}>
                  <option value="">Select a country…</option>
                  {Object.keys(COUNTRY_CURRENCY).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium" style={{ color: C.ink2 }}>City / state</label>
                <input list="harbor-city-states" value={location} placeholder="e.g. Lagos, Lagos State" onChange={(e) => setLocation(e.target.value)} className={inp} style={inpStyle} />
                <datalist id="harbor-city-states">{(CITY_STATE_OPTIONS[country] || []).map((c) => <option key={c} value={c} />)}</datalist>
              </div>
            </div>
          </div>
          <div className="pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
            <SectionTitle title="Salary" sub="What this role pays, and how it's quoted." size="text-base" />
            <label className="flex items-center gap-2 mt-2 text-sm cursor-pointer" style={{ color: C.ink }}>
              <input type="checkbox" checked={commissionOnly} onChange={(e) => setCommissionOnly(e.target.checked)} className="w-4 h-4" />
              Commission-only role (no base salary)
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Salary currency</label><select value={currency} onChange={(e) => setCurrency(e.target.value)} className={inp} style={inpStyle}>{CURRENCIES.map((c) => <option key={c} value={c}>{c} ({curSymbol(c)})</option>)}</select></div>
              {!commissionOnly && (
                <div>
                  <label className="text-xs font-medium" style={{ color: C.ink2 }}>Paid</label>
                  <select value={salaryPeriod} onChange={(e) => setSalaryPeriod(e.target.value)} className={inp} style={inpStyle}>
                    <option value="Yearly">Yearly</option>
                    <option value="Monthly">Monthly</option>
                    <option value="Weekly">Weekly</option>
                    <option value="Daily">Daily</option>
                    <option value="Hourly">Hourly</option>
                  </select>
                </div>
              )}
            </div>
            {!commissionOnly && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Minimum ({curSymbol(currency)} {salaryPeriod.toLowerCase()})</label><input value={minPay} onChange={(e) => setMinPay(e.target.value)} className={inp} style={inpStyle} /></div>
                <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Maximum ({curSymbol(currency)} {salaryPeriod.toLowerCase()})</label><input value={maxPay} onChange={(e) => setMaxPay(e.target.value)} className={inp} style={inpStyle} /></div>
              </div>
            )}
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium" style={{ color: C.ink2 }}>Job description</label>
              <button type="button" onClick={runRedraft} disabled={aiBusy} className="inline-flex items-center gap-1 text-xs font-medium rounded-lg px-2.5 py-1.5 border" style={{ borderColor: C.em, color: C.em, background: "#fff", opacity: aiBusy ? 0.6 : 1 }}><Sparkles size={13} />{aiBusy ? <>Redrafting <InlineDots /></> : "AI redraft for SEO"}</button>
            </div>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Describe the role, responsibilities, and what success looks like..." className={inp} style={inpStyle} />
            {seo && !draftAi && <div className="text-xs mt-1.5" style={{ color: C.em }}>SEO version applied · {(seo.keywords || []).length} search keywords will be saved with this job.</div>}
            {draftAi && (
              <div className="mt-3 rounded-xl border p-4 flex flex-col gap-3" style={{ borderColor: C.em, background: "#F4FAF6" }}>
                <div className="flex items-center justify-between gap-2"><div className="text-sm font-medium">AI redraft</div><Pill tone="em">Review before using</Pill></div>
                <div><div className="text-xs" style={{ color: C.ink3 }}>Title</div><div className="text-sm font-medium">{draftAi.title}</div></div>
                <div><div className="text-xs" style={{ color: C.ink3 }}>Description</div><div className="text-sm whitespace-pre-wrap overflow-y-auto mt-1 rounded-lg p-3" style={{ maxHeight: 320, background: "#fff", border: `1px solid ${C.line}`, color: C.ink2 }}>{draftAi.description}</div></div>
                {draftAi.meta_description && <div><div className="text-xs" style={{ color: C.ink3 }}>Search result snippet</div><div className="text-sm" style={{ color: C.ink2 }}>{draftAi.meta_description}</div></div>}
                {(draftAi.keywords || []).length > 0 && <div className="flex flex-wrap gap-1.5">{draftAi.keywords.map((k) => <Pill key={k} tone="neutral">{k}</Pill>)}</div>}
                <div className="flex flex-wrap gap-2"><Btn kind="primary" onClick={useRedraft}>Use this version</Btn><Btn onClick={runRedraft}>Try again</Btn><Btn onClick={() => setDraftAi(null)}>Discard</Btn></div>
              </div>
            )}
          </div>
          <div className="pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
            <SectionTitle title="Client billing" sub="What the agency charges the client when this role is filled." size="text-base" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
              <div>
                <label className="text-xs font-medium" style={{ color: C.ink2 }}>Type</label>
                <select value={billingType} onChange={(e) => setBillingType(e.target.value)} className={inp} style={inpStyle}>
                  <option value="percent">% of salary</option>
                  <option value="flat">Flat fee</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium" style={{ color: C.ink2 }}>{billingType === "percent" ? "Percentage" : "Amount"}</label>
                <input value={billingAmount} onChange={(e) => setBillingAmount(e.target.value)} placeholder={billingType === "percent" ? "e.g. 15" : "e.g. 3000000"} className={inp} style={inpStyle} />
              </div>
              {billingType === "flat" && (
                <div>
                  <label className="text-xs font-medium" style={{ color: C.ink2 }}>Currency</label>
                  <select value={billingCurrency} onChange={(e) => setBillingCurrency(e.target.value)} className={inp} style={inpStyle}>{CURRENCIES.map((c) => <option key={c} value={c}>{c} ({curSymbol(c)})</option>)}</select>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
              <div>
                <label className="text-xs font-medium" style={{ color: C.ink2 }}>Billed</label>
                <select value={billingFrequency} onChange={(e) => setBillingFrequency(e.target.value)} className={inp} style={inpStyle}>
                  <option value="One-off">One-off, on placement</option>
                  <option value="Monthly">Monthly</option>
                </select>
              </div>
              {billingFrequency === "Monthly" && (
                <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>For how many months</label><input value={billingMonths} onChange={(e) => setBillingMonths(e.target.value)} placeholder="e.g. 12" className={inp} style={inpStyle} /></div>
              )}
            </div>
          </div>
          <div className="pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
            <SectionTitle title="Recruiter incentive" sub="What the recruiter earns for placing a candidate on this role." size="text-base" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
              <div>
                <label className="text-xs font-medium" style={{ color: C.ink2 }}>Type</label>
                <select value={incentiveType} onChange={(e) => setIncentiveType(e.target.value)} className={inp} style={inpStyle}>
                  <option value="percent">% of the client fee</option>
                  <option value="flat">Flat bonus</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium" style={{ color: C.ink2 }}>{incentiveType === "percent" ? "Percentage" : "Amount"}</label>
                <input value={incentiveAmount} onChange={(e) => setIncentiveAmount(e.target.value)} placeholder={incentiveType === "percent" ? "e.g. 10" : "e.g. 200000"} className={inp} style={inpStyle} />
              </div>
              {incentiveType === "flat" && (
                <div>
                  <label className="text-xs font-medium" style={{ color: C.ink2 }}>Currency</label>
                  <select value={incentiveCurrency} onChange={(e) => setIncentiveCurrency(e.target.value)} className={inp} style={inpStyle}>{CURRENCIES.map((c) => <option key={c} value={c}>{c} ({curSymbol(c)})</option>)}</select>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
              <div>
                <label className="text-xs font-medium" style={{ color: C.ink2 }}>Paid</label>
                <select value={incentiveFrequency} onChange={(e) => setIncentiveFrequency(e.target.value)} className={inp} style={inpStyle}>
                  <option value="One-off">One-off, on placement</option>
                  <option value="Monthly">Monthly</option>
                </select>
              </div>
              {incentiveFrequency === "Monthly" && (
                <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>For how many months</label><input value={incentiveMonths} onChange={(e) => setIncentiveMonths(e.target.value)} placeholder="e.g. 12" className={inp} style={inpStyle} /></div>
              )}
            </div>
          </div>
          <div className="pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
            <SectionTitle title="Screening questions" sub="Every recruiter on this role asks applicants these before recording their answers." size="text-base" />
            <div className="flex flex-col gap-2 mt-2">
              {questions.map((q, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={q} onChange={(e) => setQ(i, e.target.value)} placeholder={"Question " + (i + 1)} className={inp + " mt-0"} style={inpStyle} />
                  {questions.length > 1 && <button type="button" onClick={() => removeQ(i)} className="shrink-0 p-1" style={{ color: C.ink3 }}><X size={15} /></button>}
                </div>
              ))}
              <button type="button" onClick={addQ} className="text-xs font-medium w-fit" style={{ color: C.em }}>+ Add another question</button>
            </div>
          </div>
          <div className="pt-3 flex items-center justify-between gap-3" style={{ borderTop: `1px solid ${C.line}` }}>
            <div><div className="text-sm font-medium">Auto-rate candidates</div><div className="text-xs" style={{ color: C.ink2 }}>AI reviews and rates every applicant.</div></div>
            <div className="w-10 h-6 rounded-full flex items-center px-0.5 shrink-0" style={{ background: C.em }}><div className="w-5 h-5 rounded-full bg-white ml-auto" /></div>
          </div>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <SectionTitle title="Job link" sub={isEdit ? "This job's public link." : "Generated when you publish."} size="text-xl" />
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 mt-3 text-sm" style={{ background: C.canvas }}><Lock size={14} color={C.ink2} className="shrink-0" /><span style={{ color: C.ink2 }} className="truncate">{isEdit ? editJob.link : "harbor.link/j/••••••"}</span></div>
            <div className="mt-2">{isEdit ? <StatusPill status={editJob.status} /> : <Pill tone="neutral">Draft until published</Pill>}</div>
          </Card>
        </div>
      </div>
      <Modal open={!!done} onClose={() => onOpenJob(done.id)} title={done ? (done.status === "Draft" ? "Saved as draft" : "Job published") : ""}>
        {done && (
          <div className="flex flex-col items-center text-center gap-4">
            <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: C.emTint }}><Check size={26} color={C.em} strokeWidth={3} /></div>
            <div className="text-sm" style={{ color: C.ink2 }}>{done.title}, {done.client}</div>
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm w-full" style={{ background: C.canvas }}>
              <Lock size={14} color={C.ink2} className="shrink-0" /><span style={{ color: C.ink2 }} className="truncate flex-1 text-left">{done.link}</span>
              <Copy size={15} color={C.ink2} className="cursor-pointer shrink-0" onClick={copyLink} />
            </div>
            <div className="flex flex-wrap gap-2 justify-center w-full">
              <Btn onClick={reset}>Post another job</Btn>
              {done.status !== "Draft" && <Btn onClick={() => onPromote(done.title)}>Promote this job</Btn>}
              <Btn kind="primary" onClick={() => onOpenJob(done.id)}>View job</Btn>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const AD_CHANNELS = [
  { key: "GJ", name: "Google for Jobs", free: true, desc: "Free listing in Google job search results." },
  { key: "LI", name: "LinkedIn", free: false, desc: "Reach active and passive job seekers." },
  { key: "FB", name: "Facebook", free: false, desc: "Broad reach, strong for local roles." },
  { key: "GA", name: "Google Ads", free: false, desc: "Search ads for people actively looking." },
];

function PromoteModal({ open, onClose, jobTitle, toast, S }) {
  const integrations = S.settings.integrations || {};
  const CHANNEL_INTEGRATION = { GJ: "googleJobs", LI: "linkedin" }; // FB/GA have no integration toggle yet
  const channelAvailable = (k) => !CHANNEL_INTEGRATION[k] || integrations[CHANNEL_INTEGRATION[k]];
  const [channels, setChannels] = useState({ GJ: channelAvailable("GJ"), LI: channelAvailable("LI"), FB: false, GA: false });
  const [budget, setBudget] = useState("300,000");
  const [payer, setPayer] = useState("agency");
  const [copy, setCopy] = useState(`We're hiring: ${jobTitle}. Competitive pay, remote-friendly, fast interview process. Apply through Harbor today.`);

  React.useEffect(() => {
    setCopy(`We're hiring: ${jobTitle}. Competitive pay, remote-friendly, fast interview process. Apply through Harbor today.`);
  }, [jobTitle, open]);

  const toggle = (k) => { if (!channelAvailable(k)) { toast(AD_CHANNELS.find((c) => c.key === k).name + " isn't connected — turn it on in Agency settings → Integrations."); return; } setChannels((c) => ({ ...c, [k]: !c[k] })); };
  const paidSelected = channels.LI || channels.FB || channels.GA;

  const submit = () => {
    const keys = Object.keys(channels).filter((k) => channels[k]);
    if (!keys.length) { toast("Pick at least one channel"); return; }
    const amt = Number(String(budget).replace(/,/g, ""));
    if (paidSelected && (!amt || amt <= 0)) { toast("Enter a budget"); return; }
    const j = S.jobs.find((x) => x.role === jobTitle);
    const live = !paidSelected || payer === "mine";
    /* DEMO: in production this calls the LinkedIn, Facebook and Google ad APIs from your backend */
    S.setAds((l) => [{ id: uid(), payerType: payer === "mine" || !paidSelected ? "recruiter" : "agency", job: jobTitle, client: j ? j.client : "New role", channels: keys, payer: payer === "agency" ? "Agency" : S.me.first + " (" + S.me.label.toLowerCase() + ")", budget: paidSelected ? "₦" + amt.toLocaleString("en-NG") : "₦0", spent: "₦0", apps: 0, status: live ? "Live" : "Pending approval" }, ...l]);
    onClose(); toast(live ? "Campaign is live" : "Sent to Rec Ops for approval");
  };

  return (
    <Modal open={open} onClose={onClose} title="Promote this job">
      <div className="text-sm mb-4" style={{ color: C.ink2 }}>{jobTitle}</div>
      <div className="text-xs font-semibold mb-2" style={{ color: C.ink3 }}>CHANNELS</div>
      <div className="flex flex-col gap-2 mb-4">
        {AD_CHANNELS.map((ch) => { const available = channelAvailable(ch.key); return (
          <button key={ch.key} onClick={() => toggle(ch.key)} className="flex items-center gap-3 rounded-xl border p-3 text-left" style={{ borderColor: channels[ch.key] ? C.em : C.line, background: channels[ch.key] ? C.emTint : "#fff", opacity: available ? 1 : 0.55 }}>
            <div className="w-9 h-9 rounded-lg flex items-center justify-center font-semibold shrink-0" style={{ fontSize: 11, background: CHANNEL_TONE[ch.key].bg, color: CHANNEL_TONE[ch.key].fg }}>{ch.key}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium flex items-center gap-2">{ch.name}{ch.free && <Pill tone="em">Free</Pill>}</div>
              <div className="text-xs" style={{ color: C.ink2 }}>{available ? ch.desc : "Not connected — turn on in Agency settings"}</div>
            </div>
            <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: channels[ch.key] ? C.em : "#fff", border: channels[ch.key] ? "none" : `1.5px solid #D5D2C7` }}>
              {channels[ch.key] && <Check size={13} color="#fff" strokeWidth={3} />}
            </div>
          </button>
        ); })}
      </div>
      {paidSelected && (
        <div className="mb-4">
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Budget (₦)</label>
          <input value={budget} onChange={(e) => setBudget(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        </div>
      )}
      {paidSelected && (
        <div className="mb-4">
          <div className="text-xs font-semibold mb-2" style={{ color: C.ink3 }}>WHO PAYS</div>
          <div className="grid grid-cols-2 gap-2">
            {[["agency", "Agency budget"], ["mine", "My budget"]].map(([v, l]) => (
              <button key={v} onClick={() => setPayer(v)} className="rounded-xl border p-3 text-sm font-medium text-left" style={{ borderColor: payer === v ? C.em : C.line, background: payer === v ? C.emTint : "#fff", color: payer === v ? C.em : C.ink }}>{l}</button>
            ))}
          </div>
          {payer === "agency" && <div className="text-xs mt-1.5" style={{ color: C.ink3 }}>Agency-funded campaigns need Rec Ops approval before they launch.</div>}
        </div>
      )}
      <div className="mb-5">
        <label className="text-xs font-medium flex items-center gap-1.5" style={{ color: C.ink2 }}><Sparkles size={13} /> AI-drafted ad copy</label>
        <textarea value={copy} onChange={(e) => setCopy(e.target.value)} rows={3} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
      </div>
      <Btn kind="primary" full onClick={submit}>{!paidSelected ? "List on Google for Jobs" : payer === "agency" ? "Send for approval" : "Launch campaign"}</Btn>
    </Modal>
  );
}

/* ======================================================================
   HARBOR, PART 2. Paste this directly BELOW the code you already have.
   It uses the same imports, tokens and components, so nothing to add above.
   Contains: Inbox, Campaigns, Billing, Ads, Users, Settings,
   AddCandidate, CandidatePortal and the App root (default export).
   ====================================================================== */

function CampaignsPage({ toast, S }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [aud, setAud] = useState("");
  const [delTarget, setDelTarget] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const create = () => {
    if (!name.trim()) { toast("Name the campaign"); return; }
    S.setCampaigns((l) => [{ id: uid(), name, meta: S.me.first + " \u00b7 Not scheduled", audience: aud || "-", delivered: "-", opened: 0, status: "Draft" }, ...l]);
    setName(""); setAud(""); setOpen(false); toast("Draft created");
  };
  /* DEMO: in production this hands the send to your email provider */
  const send = (n) => { S.setCampaigns((l) => l.map((c) => (c.name === n ? { ...c, status: "Sent", delivered: c.audience, meta: c.meta.split(" \u00b7 ")[0] + " \u00b7 " + todayStr() } : c))); toast("Campaign sent"); };
  const confirmDelete = () => {
    setDelBusy(true);
    S.deleteCampaign(delTarget.id).then(() => { toast("Campaign deleted"); setDelTarget(null); }).catch(() => {}).finally(() => setDelBusy(false));
  };
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="Email campaigns" sub="Reach past candidates about new roles." />
        <Btn kind="primary" icon={Plus} onClick={() => setOpen(true)}>New campaign</Btn>
      </div>
      <Card>
        <DataTable
          keyField="name"
          rows={S.campaigns}
          columns={[
            { key: "name", label: "CAMPAIGN", render: (c) => <div><div className="font-medium">{c.name}</div><div className="text-xs" style={{ color: C.ink2 }}>{c.meta}</div></div> },
            { key: "audience", label: "AUDIENCE", render: (c) => c.audience },
            { key: "delivered", label: "DELIVERED", render: (c) => c.delivered },
            { key: "opened", label: "OPENED", render: (c) => c.opened ? <div className="flex items-center gap-2"><ProgressBar pct={c.opened} /><span className="text-xs">{c.opened}%</span></div> : "-" },
            { key: "status", label: "STATUS", render: (c) => <div className="flex items-center gap-2"><StatusPill status={c.status} />{c.status !== "Sent" && <button onClick={() => send(c.name)} className="text-xs" style={{ color: C.em }}>Send now</button>}</div> },
            { key: "act", label: "", render: (c) => S.role === "admin" ? <button title="Delete campaign" onClick={(e) => { e.stopPropagation(); setDelTarget(c); }} className="p-1" style={{ color: C.ink3 }}><X size={15} /></button> : null },
          ]}
        />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New campaign">
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Campaign name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Audience size</label>
        <input value={aud} onChange={(e) => setAud(e.target.value)} placeholder="e.g. 1,200" className="w-full mt-1.5 mb-4 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <Btn kind="primary" full onClick={create}>Create draft</Btn>
      </Modal>
      <ConfirmModal
        open={!!delTarget}
        onClose={() => setDelTarget(null)}
        title="Delete this campaign?"
        body={delTarget ? "This permanently removes \"" + delTarget.name + "\". This can't be undone." : ""}
        onConfirm={confirmDelete}
        busy={delBusy}
      />
    </div>
  );
}

function NewBillingModal({ open, onClose, toast, S, presetId }) {
  const [candId, setCandId] = useState("");
  const [jobId, setJobId] = useState("");
  const [fee, setFee] = useState("");
  const [feeCur, setFeeCur] = useState("NGN");
  const [incentive, setIncentive] = useState("");
  const [incentiveCur, setIncentiveCur] = useState("NGN");
  const [startDate, setStartDate] = useState(() => ymdToday());
  const [gDays, setGDays] = useState(String(S.settings.guaranteeDays != null ? S.settings.guaranteeDays : 60));
  const [busy, setBusy] = useState(false);
  const cand = S.cands.find((c) => c.id === candId) || null;
  const job = S.jobs.find((j) => j.id === jobId) || null;
  // A candidate has to still be in play to be billed — billing someone who was
  // rejected or withdrew is exactly the kind of status/billing mismatch that's
  // confusing to audit later, so they're not offered here at all.
  const billableCands = awaitingBilling(S);
  // Opened from "Waiting to be billed": pick that candidate straight away.
  const [presetDone, setPresetDone] = useState(null);
  if (open && presetId && presetDone !== presetId && billableCands.some((c) => c.id === presetId)) { setPresetDone(presetId); setTimeout(() => pickCand(presetId), 0); }
  const pickCand = (id) => {
    setCandId(id);
    const c = S.cands.find((x) => x.id === id);
    const j = c ? S.jobs.find((x) => c.jobLinks.some((l) => l.jobId === x.id)) : null;
    setJobId(j ? j.id : "");
    const s = suggestBilling(j, c ? c.pay : null);
    setFee(String(s.fee)); setFeeCur(s.feeCurrency); setIncentive(String(s.incentive)); setIncentiveCur(s.incentiveCurrency);
  };
  const pickJob = (id) => {
    setJobId(id);
    const j = S.jobs.find((x) => x.id === id);
    const s = suggestBilling(j, cand ? cand.pay : null);
    setFee(String(s.fee)); setFeeCur(s.feeCurrency); setIncentive(String(s.incentive)); setIncentiveCur(s.incentiveCurrency);
  };
  const submit = async () => {
    if (!cand) { toast("Pick a candidate"); return; }
    if (!num(fee)) { toast("Enter the client fee"); return; }
    setBusy(true);
    try {
      await S.insertPlacement({ name: cand.name, role: job ? job.role + ", " + job.client : cand.role, candidateId: cand.id, jobId: job ? job.id : null, recruiterId: cand.recruiterId, recruiterInit: cand.recruiterInit, fee: num(fee), feeCurrency: feeCur, incentive: incentive ? num(incentive) : null, incentiveCurrency: incentiveCur , startDate, guaranteeDays: gDays === "" ? null : Math.max(0, Number(gDays) || 0)});
      toast("Billing entry created"); setCandId(""); setJobId(""); setFee(""); setIncentive(""); onClose();
    } catch (e) { toast(e.message || "Could not create billing entry"); }
    setBusy(false);
  };
  const sel = "w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none";
  const selStyle = { borderColor: C.line, background: "#FAF8F3" };
  return (
    <Modal open={open} onClose={onClose} title="New billing entry">
      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Candidate</label>
          <select value={candId} onChange={(e) => pickCand(e.target.value)} className={sel} style={selStyle}>
            <option value="">Choose a candidate…</option>
            {billableCands.map((c) => <option key={c.id} value={c.id}>{c.name} – {c.role}</option>)}
          </select>
          <div className="text-xs mt-1" style={{ color: C.ink3 }}>{billableCands.length ? "Only candidates marked Placed or Hired who haven't been billed yet are listed." : "No one is waiting to be billed. Mark a candidate Placed or Hired first."}</div>
        </div>
        <div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Job (for billing terms)</label>
          <select value={jobId} onChange={(e) => pickJob(e.target.value)} className={sel} style={selStyle}>
            <option value="">No specific job</option>
            {S.jobs.map((j) => <option key={j.id} value={j.id}>{j.role} – {j.client}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Client fee</label><input value={fee} onChange={(e) => setFee(e.target.value)} placeholder="e.g. 1500000" className={sel} style={selStyle} /></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Currency</label><select value={feeCur} onChange={(e) => setFeeCur(e.target.value)} className={sel} style={selStyle}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Recruiter incentive</label><input value={incentive} onChange={(e) => setIncentive(e.target.value)} placeholder="optional" className={sel} style={selStyle} /></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Currency</label><select value={incentiveCur} onChange={(e) => setIncentiveCur(e.target.value)} className={sel} style={selStyle}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Start date</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={sel} style={selStyle} /></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Guarantee (days)</label><input type="number" min="0" value={gDays} onChange={(e) => setGDays(e.target.value)} className={sel} style={selStyle} /></div>
        </div>
        <div className="text-xs" style={{ color: C.ink3 }}>0 days means no guarantee: the entry is ready to invoice straight away.</div>
        {job && <div className="text-xs" style={{ color: C.ink3 }}>Prefilled from {job.role}'s billing settings — edit as needed.</div>}
        <Btn kind="primary" full disabled={busy} onClick={submit}>{busy ? <>Creating <InlineDots color="#fff" /></> : "Create billing entry"}</Btn>
      </div>
    </Modal>
  );
}

/* Placed or hired candidates with no billing entry yet (a fallout entry doesn't count). */
const awaitingBilling = (S) => S.cands.filter((c) => ["Placed", "Hired"].includes(c.status) && !S.placements.some((p) => p.candidateId === c.id && p.status !== "Fallout"));

/* Date helpers for billing (dates stored as YYYY-MM-DD). */
const ymdOf = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const ymdToday = () => ymdOf(new Date());
const addDays = (ymd, n) => { const d = new Date((ymd || ymdToday()) + "T00:00:00"); d.setDate(d.getDate() + (Number(n) || 0)); return ymdOf(d); };
const longDate = (ymd) => ymd ? new Date(ymd + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
const money2 = (n, cur) => { try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur || "NGN", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2 }).format(Number(n || 0)); } catch (e) { return (cur || "") + " " + Number(n || 0).toFixed(2); } };
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const BILLING_STATUSES = [["Guarantee", "In guarantee"], ["Ready", "Ready to invoice"], ["Invoiced", "Invoiced"], ["Paid", "Paid"], ["Fallout", "Fallout"]];
const COMPANY_FIELDS = [["name", "Company name"], ["address", "Address"], ["email", "Email"], ["phone", "Phone"], ["taxId", "Tax ID / RC number"], ["bankName", "Bank name"], ["accountName", "Account name"], ["accountNumber", "Account number"], ["swift", "SWIFT / BIC"], ["sortCode", "Sort code / routing"]];

/* The invoice as a printable page. Opens in a print window; "Save as PDF" there downloads it. */
function invoiceHtml(inv) {
  const f = inv.from || {}, t = inv.to || {}, cur = inv.currency;
  const lines = (inv.items || []).filter((x) => x.description || Number(x.amount));
  const sub = lines.reduce((a, x) => a + (Number(x.amount) || 0), 0), tax = sub * (Number(inv.taxRate) || 0) / 100;
  const row = (label, v) => v ? `<div>${label ? `<span class="k">${esc(label)}:</span> ` : ""}${esc(v)}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number || "Invoice")}${t.company ? " - " + esc(t.company) : ""}</title>
<style>@page{size:A4;margin:18mm}*{box-sizing:border-box}body{font-family:Helvetica,Arial,sans-serif;color:#1b1b1b;font-size:12px;line-height:1.5;margin:0}
.top{display:flex;justify-content:space-between;gap:24px}.h{font-size:28px;letter-spacing:2px;font-weight:700;margin:0 0 6px}.co{font-size:16px;font-weight:700}
.k{color:#777}.cols{display:flex;gap:24px;margin:28px 0 20px}.cols>div{flex:1}.lab{font-size:10px;letter-spacing:1px;color:#777;margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin-top:6px}th{text-align:left;font-size:10px;letter-spacing:1px;color:#777;border-bottom:1px solid #ccc;padding:6px 0}
td{padding:8px 0;border-bottom:1px solid #eee;vertical-align:top;font-size:12px}.r{text-align:right}.tot{margin-left:auto;width:45%;margin-top:12px}.tot div{display:flex;justify-content:space-between;padding:3px 0}
.grand{font-weight:700;font-size:14px;border-top:1px solid #ccc;margin-top:4px;padding-top:6px!important}.pay{margin-top:28px;padding-top:12px;border-top:1px solid #eee}</style></head>
<body><div class="top"><div><div class="co">${esc(f.name)}</div>${row("", f.address)}${row("", [f.email, f.phone].filter(Boolean).join(" · "))}${row("Tax ID", f.taxId)}</div>
<div style="text-align:right"><div class="h">INVOICE</div>${row("Invoice no.", inv.number)}${row("Invoice date", longDate(inv.date))}${row("Due date", longDate(inv.dueDate))}</div></div>
<div class="cols"><div><div class="lab">BILL TO</div><div style="font-weight:700">${esc(t.company)}</div>${row("", t.contact && "Attn: " + t.contact)}${row("", t.address)}${row("", t.email)}</div>
<div><div class="lab">BILL FROM</div><div style="font-weight:700">${esc(f.name)}</div>${row("", inv.preparedBy)}${row("", f.email)}</div></div>
<table><thead><tr><th>DESCRIPTION</th><th class="r">AMOUNT</th></tr></thead><tbody>${lines.map((x) => `<tr><td>${esc(x.description)}</td><td class="r">${esc(money2(x.amount, cur))}</td></tr>`).join("")}</tbody></table>
<div class="tot"><div><span>Subtotal</span><span>${esc(money2(sub, cur))}</span></div><div><span>Tax (${esc(Number(inv.taxRate) || 0)}%)</span><span>${esc(money2(tax, cur))}</span></div><div class="grand"><span>Total due</span><span>${esc(money2(sub + tax, cur))}</span></div></div>
<div class="pay"><div class="lab">PAYMENT DETAILS</div>${row("Bank", f.bankName)}${row("Account name", f.accountName)}${row("Account number", f.accountNumber)}${row("SWIFT / BIC", f.swift)}${row("Sort code / routing", f.sortCode)}${row("Terms", inv.terms)}${inv.notes ? `<div style="margin-top:8px">${esc(inv.notes)}</div>` : ""}</div>
</body></html>`;
}
function printInvoice(inv) {
  const fr = document.createElement("iframe");
  fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(fr);
  const d = fr.contentWindow.document; d.open(); d.write(invoiceHtml(inv)); d.close();
  setTimeout(() => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) { /* ignore */ } setTimeout(() => fr.remove(), 60000); }, 250);
}

/* Billing entry: details, guarantee progress, status, and the invoice to the client. */
function BillingDetailModal({ p, role, onClose, toast, S }) {
  const staff = role !== "recruiter";
  const job = p.jobId ? S.jobs.find((j) => j.id === p.jobId) : null;
  const rec = (S.users || []).find((u) => u.id === p.recruiterId);
  const [startDate, setStartDate] = useState(p.startDate || (p.createdAt ? ymdOf(new Date(p.createdAt)) : ymdToday()));
  const [gDays, setGDays] = useState(String(p.guaranteeDays != null ? p.guaranteeDays : S.settings.guaranteeDays != null ? S.settings.guaranteeDays : 60));
  const [status, setStatus] = useState(p.status);
  const [busy, setBusy] = useState("");
  const days = Math.max(0, Number(gDays) || 0);
  const ends = addDays(startDate, days);
  const t0 = new Date(startDate + "T00:00:00").getTime(), t1 = new Date(ends + "T00:00:00").getTime(), now = Date.now();
  const pct = days === 0 ? 100 : Math.max(0, Math.min(100, ((now - t0) / (t1 - t0)) * 100));
  const dayN = Math.max(0, Math.min(days, Math.floor((now - t0) / 864e5)));
  const left = Math.max(0, Math.ceil((t1 - now) / 864e5));
  const started = now >= t0;
  const barColor = status === "Fallout" ? C.dangerFg : pct >= 100 ? C.em : "#1D9E75";

  // Invoice: saved on the entry; company details come from Settings when empty.
  const co = S.settings.company || {};
  const saved = p.invoice || {};
  const [inv, setInv] = useState(() => ({
    number: saved.number || "", date: saved.date || ymdToday(), termsDays: saved.termsDays != null ? saved.termsDays : (co.termsDays != null ? co.termsDays : 30),
    to: { company: (job && job.client) || "", contact: "", address: "", email: "", ...(saved.to || {}) },
    from: { ...COMPANY_FIELDS.reduce((o, [k]) => ({ ...o, [k]: co[k] || "" }), {}), ...(saved.from || {}) },
    items: saved.items && saved.items.length ? saved.items : [{ description: "Placement fee: " + p.name + (p.role ? ", " + p.role : "") + (startDate ? ". Start date " + longDate(startDate) + "." : ""), amount: p.feeNum || 0 }],
    taxRate: saved.taxRate != null ? saved.taxRate : 0, notes: saved.notes || "", preparedBy: saved.preparedBy || S.me.name || "",
  }));
  const [showInv, setShowInv] = useState(!!saved.number || p.status === "Ready");
  const setTo = (k, v) => setInv((x) => ({ ...x, to: { ...x.to, [k]: v } }));
  const setFrom = (k, v) => setInv((x) => ({ ...x, from: { ...x.from, [k]: v } }));
  const setItem = (i, k, v) => setInv((x) => ({ ...x, items: x.items.map((it, n) => (n === i ? { ...it, [k]: v } : it)) }));
  const subtotal = inv.items.reduce((a, x) => a + (Number(x.amount) || 0), 0), tax = subtotal * (Number(inv.taxRate) || 0) / 100;
  const dueDate = addDays(inv.date, inv.termsDays);
  const full = () => ({ ...inv, dueDate, currency: p.feeCurrency, terms: "Payment within " + (Number(inv.termsDays) || 0) + " days", subtotal, tax, total: subtotal + tax });

  const saveDetails = async () => {
    setBusy("details");
    try {
      const patch = { start_date: startDate, guarantee_days: days, guarantee_ends: ends };
      let st = status;
      if (days === 0 && st === "Guarantee") st = "Ready";
      if (st !== p.status) patch.status = st;
      await S.updatePlacement(p.id, patch);
      setStatus(st); toast("Billing entry updated"); S.reload && S.reload();
    } catch (e) { toast(e.message); }
    setBusy("");
  };
  const saveInvoice = async (andPrint) => {
    setBusy(andPrint ? "print" : "invoice");
    try {
      let number = (inv.number || "").trim();
      if (!number) { number = await S.claimInvoiceNumber(); setInv((x) => ({ ...x, number })); }
      const data = { ...full(), number };
      const patch = { invoice: data };
      if (!["Invoiced", "Paid"].includes(p.status)) { patch.status = "Invoiced"; setStatus("Invoiced"); }
      if (!p.billedAt) patch.billed_at = new Date().toISOString();
      await S.updatePlacement(p.id, patch);
      toast("Invoice " + number + " saved"); S.reload && S.reload();
      if (andPrint) printInvoice(data);
    } catch (e) { toast(e.message); }
    setBusy("");
  };
  const inp = "w-full mt-1 rounded-lg border px-2.5 py-2 text-sm outline-none";
  const inpS = { borderColor: C.line, background: "#FAF8F3" };
  const L = ({ children }) => <div className="text-xs" style={{ color: C.ink3 }}>{children}</div>;
  return (
    <Modal open onClose={onClose} title={p.name} wide>
      <div className="flex flex-col gap-4">
        <div className="text-sm -mt-3" style={{ color: C.ink2 }}>{p.role}</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
          <div><L>START DATE</L>{staff ? <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inp} style={inpS} /> : <div className="text-sm">{longDate(startDate)}</div>}</div>
          <div><L>GUARANTEE (DAYS)</L>{staff ? <input type="number" min="0" value={gDays} onChange={(e) => setGDays(e.target.value)} className={inp} style={inpS} /> : <div className="text-sm">{days} days</div>}</div>
          <div><L>GUARANTEE ENDS</L><div className="text-sm mt-1">{days === 0 ? "No guarantee" : longDate(ends)}</div></div>
          <div><L>DATE BILLED</L><div className="text-sm mt-1">{p.billedAt ? new Date(p.billedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "Not billed yet"}</div></div>
          <div><L>CLIENT FEE</L><div className="text-sm mt-1 font-medium">{p.fee}</div></div>
          <div><L>RECRUITER DUE</L><div className="text-sm mt-1">{p.incentive || "–"}{rec ? " · " + rec.name : ""}</div></div>
        </div>
        <div>
          <div className="flex justify-between text-xs mb-1.5" style={{ color: C.ink3 }}>
            <span>{days === 0 ? "NO GUARANTEE PERIOD" : !started ? "GUARANTEE STARTS " + longDate(startDate).toUpperCase() : pct >= 100 ? "GUARANTEE CLEARED" : "GUARANTEE · DAY " + dayN + " OF " + days}</span>
            <span>{days > 0 && started && pct < 100 ? left + " day" + (left === 1 ? "" : "s") + " left" : ""}</span>
          </div>
          <div className="h-2.5 rounded-full overflow-hidden" style={{ background: C.line }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Guarantee progress">
            <div className="h-full rounded-full" style={{ width: pct + "%", background: barColor, transition: "width .3s" }} />
          </div>
          <div className="flex justify-between text-xs mt-1" style={{ color: C.ink2 }}><span>{longDate(startDate)}</span><span>{days === 0 ? "" : longDate(ends)}</span></div>
        </div>
        {staff && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm" style={{ color: C.ink2 }}>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border px-2.5 py-2 text-sm outline-none" style={inpS} aria-label="Billing status">
              {BILLING_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <Btn kind="primary" onClick={saveDetails} disabled={!!busy}>{busy === "details" ? <>Saving <InlineDots color="#fff" /></> : "Save changes"}</Btn>
            {p.candidateId && <button type="button" onClick={() => { onClose(); S.openCandidate(p.candidateId); }} className="text-sm ml-auto" style={{ color: C.em }}>View candidate</button>}
          </div>
        )}

        {staff && (
          <div className="rounded-xl border" style={{ borderColor: C.line }}>
            <button type="button" onClick={() => setShowInv((v) => !v)} aria-expanded={showInv} className="w-full flex items-center gap-2 px-3.5 py-3 text-left">
              <span className="text-sm font-semibold">{saved.number ? "Invoice " + saved.number : "Raise invoice"}</span>
              {saved.number && <Pill tone="em">Saved</Pill>}
              <ChevronDown size={16} color={C.ink2} className="ml-auto" style={{ transform: showInv ? "rotate(180deg)" : "none" }} />
            </button>
            {showInv && (
              <div className="px-3.5 pb-3.5 flex flex-col gap-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div><L>INVOICE NUMBER</L><input value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} placeholder="Assigned when saved" className={inp} style={inpS} /></div>
                  <div><L>INVOICE DATE</L><input type="date" value={inv.date} onChange={(e) => setInv({ ...inv, date: e.target.value })} className={inp} style={inpS} /></div>
                  <div><L>PAYMENT TERMS (DAYS)</L><input type="number" min="0" value={inv.termsDays} onChange={(e) => setInv({ ...inv, termsDays: e.target.value })} className={inp} style={inpS} /><div className="text-xs mt-1" style={{ color: C.ink3 }}>Due {longDate(dueDate)}</div></div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <div className="text-xs font-semibold" style={{ color: C.ink3 }}>BILL TO</div>
                    {[["company", "Company"], ["contact", "Contact person"], ["address", "Address"], ["email", "Email"]].map(([k, l]) => (
                      <input key={k} value={inv.to[k]} onChange={(e) => setTo(k, e.target.value)} placeholder={l} aria-label={"Bill to " + l} className={inp} style={inpS} />
                    ))}
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="text-xs font-semibold" style={{ color: C.ink3 }}>BILL FROM <span className="font-normal">· from Settings, edit for this invoice</span></div>
                    {COMPANY_FIELDS.map(([k, l]) => (
                      <input key={k} value={inv.from[k]} onChange={(e) => setFrom(k, e.target.value)} placeholder={l} aria-label={"Bill from " + l} className={inp} style={inpS} />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-semibold" style={{ color: C.ink3 }}>DESCRIPTION AND AMOUNT ({p.feeCurrency})</div>
                  {inv.items.map((it, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <textarea value={it.description} onChange={(e) => setItem(i, "description", e.target.value)} rows={2} aria-label={"Line " + (i + 1) + " description"} className={inp + " flex-1"} style={inpS} />
                      <input type="number" value={it.amount} onChange={(e) => setItem(i, "amount", e.target.value)} aria-label={"Line " + (i + 1) + " amount"} className={inp} style={{ ...inpS, width: 140 }} />
                      {inv.items.length > 1 && <button type="button" aria-label="Remove line" onClick={() => setInv((x) => ({ ...x, items: x.items.filter((_, n) => n !== i) }))} className="mt-2" style={{ color: C.ink3 }}><X size={15} /></button>}
                    </div>
                  ))}
                  <button type="button" onClick={() => setInv((x) => ({ ...x, items: [...x.items, { description: "", amount: 0 }] }))} className="text-xs font-medium w-fit" style={{ color: C.em }}>+ Add a line</button>
                </div>
                <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                  <div className="flex-1"><L>NOTES (OPTIONAL)</L><input value={inv.notes} onChange={(e) => setInv({ ...inv, notes: e.target.value })} placeholder="e.g. Please quote the invoice number with payment" className={inp} style={inpS} /></div>
                  <div style={{ width: 110 }}><L>TAX %</L><input type="number" min="0" value={inv.taxRate} onChange={(e) => setInv({ ...inv, taxRate: e.target.value })} className={inp} style={inpS} /></div>
                </div>
                <div className="self-end text-sm flex flex-col gap-1" style={{ minWidth: 240 }}>
                  <div className="flex justify-between"><span style={{ color: C.ink2 }}>Subtotal</span><span>{money2(subtotal, p.feeCurrency)}</span></div>
                  <div className="flex justify-between"><span style={{ color: C.ink2 }}>Tax ({Number(inv.taxRate) || 0}%)</span><span>{money2(tax, p.feeCurrency)}</span></div>
                  <div className="flex justify-between font-semibold pt-1" style={{ borderTop: `1px solid ${C.line}` }}><span>Total due</span><span>{money2(subtotal + tax, p.feeCurrency)}</span></div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Btn kind="primary" onClick={() => saveInvoice(false)} disabled={!!busy}>{busy === "invoice" ? <>Saving <InlineDots color="#fff" /></> : "Save invoice"}</Btn>
                  <Btn icon={Download} onClick={() => saveInvoice(true)} disabled={!!busy}>{busy === "print" ? "Preparing…" : "Save and download PDF"}</Btn>
                </div>
                <div className="text-xs" style={{ color: C.ink3 }}>Saving sets the entry to Invoiced and records the date billed. Download opens the print view: choose "Save as PDF".</div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function BillingPage({ role, toast, S }) {
  const [open, setOpen] = useState(false);
  const [delTarget, setDelTarget] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const list = role === "recruiter" ? S.placements.filter((p) => p.recruiterId === S.me.id) : S.placements;
  const setSt = (id, st, msg) => { S.setPlacementStatus(id, st); toast(msg); };
  const count = (s) => list.filter((p) => p.status === s).length;
  const [detailId, setDetailId] = useState(null);
  const [presetId, setPresetId] = useState(null);
  const waiting = awaitingBilling(S);
  // Arrived from "Waiting to be billed": open the new entry form for that candidate.
  useEffect(() => { if (S.billFor && role !== "recruiter") { setPresetId(S.billFor); setOpen(true); S.clearBillFor(); } }, [S.billFor]); // eslint-disable-line react-hooks/exhaustive-deps
  const startFor = (id) => { setPresetId(id); setOpen(true); };
  const openRow = (p) => setDetailId(p.id);
  const detail = detailId ? S.placements.find((p) => p.id === detailId) : null;
  const confirmDelete = () => {
    setDelBusy(true);
    S.deletePlacement(delTarget.id).then(() => { toast("Billing entry deleted"); setDelTarget(null); }).catch((e) => toast(e.message || "Could not delete")).finally(() => setDelBusy(false));
  };
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="Billing" sub="Fees are invoiced once the guarantee period clears." />
        {role !== "recruiter" && <Btn kind="primary" icon={Plus} onClick={() => setOpen(true)}>New billing entry</Btn>}
      </div>
      <KPIGrid>
        <KPI dark label="Ready to invoice" value={count("Ready")} foot="Guarantee cleared" />
        <KPI label="In guarantee" value={count("Guarantee")} foot="Not billable yet" />
        <KPI label="Paid" value={count("Paid") + count("Invoiced")} foot="Invoiced or paid" />
        <KPI label="Fallout" value={count("Fallout")} foot="Left in guarantee" />
      </KPIGrid>
      {role !== "recruiter" && waiting.length > 0 && (
        <Card>
          <SectionTitle title="Waiting to be billed" sub={plural(waiting.length, "candidate") + " marked Placed or Hired without a billing entry"} size="text-xl" />
          <div className="mt-2 flex flex-col">
            {waiting.map((c, i) => (
              <div key={c.id} className="flex items-center gap-3 py-2.5" style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => S.openCandidate(c.id)}><div className="text-sm font-medium truncate">{c.name}</div><div className="text-xs" style={{ color: C.ink2 }}>{c.status} · {c.role}</div></div>
                <Btn kind="primary" onClick={() => startFor(c.id)}>Create billing entry</Btn>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <DataTable
          keyField="id"
          rows={list}
          empty="No billing entries yet."
          onRowClick={openRow}
          columns={[
            { key: "name", label: "PLACEMENT", render: (p) => <div><div className="font-medium">{p.name}</div><div className="text-xs" style={{ color: C.ink2 }}>{p.role}</div></div> },
            { key: "recruiter", label: "RECRUITER", render: (p) => p.recruiter ? <Avatar init={p.recruiter} tone={PEOPLE_TONE[p.recruiter]} size={26} /> : <span className="text-xs" style={{ color: C.ink3 }}>–</span> },
            { key: "fee", label: "CLIENT FEE", render: (p) => <span className="font-medium">{p.fee}</span> },
            { key: "incentive", label: "RECRUITER INCENTIVE", render: (p) => p.incentive ? <span className="text-sm">{p.incentive}</span> : <span className="text-xs" style={{ color: C.ink3 }}>–</span> },
            { key: "guarantee", label: "GUARANTEE", render: (p) => <span className="text-xs" style={{ color: C.ink2 }}>{p.guarantee}</span> },
            { key: "status", label: "STATUS", render: (p) => (
              <div className="flex items-center gap-2 flex-wrap">
                <StatusPill status={p.status} />
                {p.status === "Guarantee" && p.guarantee.startsWith("Cleared") && role !== "recruiter" && <button onClick={(e) => { e.stopPropagation(); setSt(p.id, "Ready", "Guarantee cleared — ready to invoice for " + p.name); }} className="text-xs" style={{ color: C.em }}>Mark ready</button>}
                {p.status === "Ready" && role !== "recruiter" && <button onClick={(e) => { e.stopPropagation(); setSt(p.id, "Invoiced", "Invoice created for " + p.name); }} className="text-xs" style={{ color: C.em }}>Invoice</button>}
                {p.status === "Invoiced" && role !== "recruiter" && <button onClick={(e) => { e.stopPropagation(); setSt(p.id, "Paid", "Marked paid: " + p.name); }} className="text-xs" style={{ color: C.em }}>Mark paid</button>}
                {["Guarantee", "Ready"].includes(p.status) && role !== "recruiter" && <button onClick={(e) => { e.stopPropagation(); setSt(p.id, "Fallout", "Marked as fallout: " + p.name); }} className="text-xs" style={{ color: C.dangerFg }}>Mark fallout</button>}
              </div>
            ) },
            { key: "act", label: "", render: (p) => role === "admin" ? <button title="Delete billing entry" onClick={(e) => { e.stopPropagation(); setDelTarget(p); }} className="p-1" style={{ color: C.ink3 }}><X size={15} /></button> : null },
          ]}
        />
      </Card>
      <NewBillingModal open={open} onClose={() => { setOpen(false); setPresetId(null); }} toast={toast} S={S} presetId={presetId} />
      {detail && <BillingDetailModal key={detail.id} p={detail} role={role} onClose={() => setDetailId(null)} toast={toast} S={S} />}
      <ConfirmModal
        open={!!delTarget}
        onClose={() => setDelTarget(null)}
        title="Delete this billing entry?"
        body={delTarget ? "This permanently removes the billing entry for \"" + delTarget.name + "\" (" + delTarget.fee + "). It doesn't change the candidate's own status — check that separately if this placement didn't actually happen. This can't be undone." : ""}
        onConfirm={confirmDelete}
        busy={delBusy}
      />
    </div>
  );
}

function AdsPage({ role, toast, onPromote, S }) {
  const ads = S.ads;
  const setAdStatus = (id, st, msg) => { S.setAds((l) => l.map((a) => (a.id === id ? { ...a, status: st } : a))); toast(msg); };
  const [delTarget, setDelTarget] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const confirmDelete = () => {
    setDelBusy(true);
    S.deleteAd(delTarget.id).then(() => { toast("Ad campaign deleted"); setDelTarget(null); }).catch(() => {}).finally(() => setDelBusy(false));
  };
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="Ad campaigns" sub="Promote roles across job boards and social channels." />
        <Btn kind="primary" icon={Megaphone} onClick={() => onPromote("New role")}>Promote a job</Btn>
      </div>
      <Card>
        <DataTable
          keyField="id"
          rows={ads}
          columns={[
            { key: "job", label: "ROLE", render: (a) => <div><div className="font-medium">{a.job}</div><div className="text-xs" style={{ color: C.ink2 }}>{a.client}</div></div> },
            { key: "channels", label: "CHANNELS", render: (a) => <div className="flex gap-1">{a.channels.map((k) => <span key={k} title={CHANNEL_NAME[k]} className="rounded-md px-1.5 py-0.5 font-semibold" style={{ fontSize: 11, background: CHANNEL_TONE[k].bg, color: CHANNEL_TONE[k].fg }}>{k}</span>)}</div> },
            { key: "payer", label: "PAID BY", render: (a) => <span className="text-xs">{a.payer}</span> },
            { key: "spend", label: "SPENT", render: (a) => <span className="text-xs">{a.spent} of {a.budget}</span> },
            { key: "apps", label: "APPLICANTS", render: (a) => a.apps },
            { key: "status", label: "STATUS", render: (a) => (
              <div className="flex items-center gap-2">
                <StatusPill status={a.status} />
                {a.status === "Pending approval" && role !== "recruiter" && <button onClick={() => setAdStatus(a.id, "Live", "Campaign approved")} className="text-xs" style={{ color: C.em }}>Approve</button>}
                {a.status === "Live" && role !== "recruiter" && <button onClick={() => setAdStatus(a.id, "Ended", "Campaign ended")} className="text-xs" style={{ color: C.dangerFg }}>End</button>}
              </div>
            ) },
            { key: "act", label: "", render: (a) => role === "admin" ? <button title="Delete ad campaign" onClick={() => setDelTarget(a)} className="p-1" style={{ color: C.ink3 }}><X size={15} /></button> : null },
          ]}
        />
      </Card>
      <ConfirmModal
        open={!!delTarget}
        onClose={() => setDelTarget(null)}
        title="Delete this ad campaign?"
        body={delTarget ? "This permanently removes the ad campaign for \"" + delTarget.job + "\". This can't be undone." : ""}
        onConfirm={confirmDelete}
        busy={delBusy}
      />
    </div>
  );
}

function UsersPage({ toast, S }) {
  const users = S.users;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [roleKey, setRoleKey] = useState("recruiter");
  const [busy, setBusy] = useState(false);
  const [roleBusyId, setRoleBusyId] = useState(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [pwUser, setPwUser] = useState(null);
  const [pwValue, setPwValue] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [delUser, setDelUser] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const ROLE_OPTIONS = [["recruiter", "Recruiter"], ["recops", "Rec Ops manager"], ["admin", "Admin"]];
  const adminCount = users.filter((u) => u.roleKey === "admin" && u.status === "Active").length;
  const transferCandidates = users.filter((u) => !u.isOwner && u.status === "Active");
  const openEdit = (u) => { setEditUser(u); setEditName(u.name); setEditPhone(u.phone || ""); };
  const saveEdit = () => {
    if (!editName.trim()) { toast("Enter their name"); return; }
    setEditBusy(true);
    S.editUser(editUser.id, { name: editName.trim(), phone: editPhone.trim() })
      .then(() => { toast("Details updated"); setEditUser(null); }).catch((e) => toast(e.message)).finally(() => setEditBusy(false));
  };
  const savePassword = () => {
    if (pwValue.length < 8) { toast("Password must be at least 8 characters"); return; }
    setPwBusy(true);
    S.setUserPassword(pwUser.id, pwValue)
      .then(() => { toast("Password set for " + pwUser.name); setPwUser(null); setPwValue(""); }).catch((e) => toast(e.message)).finally(() => setPwBusy(false));
  };
  const confirmDeleteUser = () => {
    setDelBusy(true);
    S.deleteUser(delUser.id)
      .then(() => { toast(delUser.name + " deleted"); setDelUser(null); }).catch((e) => toast(e.message)).finally(() => setDelBusy(false));
  };
  const invite = async () => {
    if (!name.trim()) { toast("Enter their name"); return; }
    if (!email.includes("@")) { toast("Enter a valid email"); return; }
    if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) { toast("That email already has an account"); return; }
    if (pass.length < 8) { toast("Password must be at least 8 characters"); return; }
    setBusy(true);
    try { await S.createAccount({ email, password: pass, full_name: name, role: roleKey }); setName(""); setEmail(""); setPass(""); setOpen(false); toast("Account created for " + name + " — activate it so they can sign in"); }
    catch (e) { toast(e.message || "Could not create account"); }
    setBusy(false);
  };
  const changeRole = (u, newRoleKey) => {
    if (newRoleKey === u.roleKey) return;
    if (u.roleKey === "admin" && newRoleKey !== "admin" && adminCount <= 1) { toast("You're the only admin — make someone else admin first"); return; }
    setRoleBusyId(u.id);
    S.updateUserRole(u.id, newRoleKey).then(() => toast(u.name + " is now " + ROLE_KEY_LABEL[newRoleKey])).catch(() => {}).finally(() => setRoleBusyId(null));
  };
  const confirmTransfer = () => {
    if (!transferTarget) return;
    setTransferBusy(true);
    S.transferOwnership(transferTarget).then(() => { toast("Ownership transferred"); setTransferOpen(false); setTransferTarget(null); })
      .catch((e) => toast(e.message || "Could not transfer ownership")).finally(() => setTransferBusy(false));
  };
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="Users and permissions" sub="Control who can see and do what." />
        <div className="flex gap-2">
          {S.me.isOwner && <Btn onClick={() => setTransferOpen(true)}>Transfer ownership</Btn>}
          <Btn kind="primary" icon={UserPlus} onClick={() => setOpen(true)}>Invite user</Btn>
        </div>
      </div>
      <Card>
        <DataTable
          keyField="email"
          rows={users}
          columns={[
            { key: "name", label: "USER", render: (u) => <div><div className="font-medium flex items-center gap-1.5">{u.name}{u.isOwner && <Pill tone="em">Owner</Pill>}</div><div className="text-xs" style={{ color: C.ink2 }}>{u.email}</div></div> },
            { key: "role", label: "ROLE", render: (u) => {
              const editable = !u.isOwner || u.id === S.me.id;
              if (!editable) return <span className="text-sm" style={{ color: C.ink2 }}>{u.role}</span>;
              return (
                <select className="text-sm rounded-lg border px-2 py-1.5 bg-white" style={{ borderColor: C.line, color: C.ink }} value={u.roleKey} disabled={roleBusyId === u.id}
                  onChange={(e) => changeRole(u, e.target.value)}>
                  {ROLE_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              );
            } },
            { key: "status", label: "STATUS", render: (u) => <StatusPill status={u.status} /> },
            { key: "act", label: "", render: (u) => {
              if (u.isOwner) return <button onClick={() => openEdit(u)} className="text-xs" style={{ color: C.em }}>Edit</button>;
              const lastAdmin = u.roleKey === "admin" && u.status === "Active" && adminCount <= 1;
              return (
                <div className="flex items-center gap-2.5 flex-wrap justify-end">
                  <button onClick={() => openEdit(u)} className="text-xs" style={{ color: C.em }}>Edit</button>
                  <button onClick={() => { setPwUser(u); setPwValue(""); }} className="text-xs" style={{ color: C.em }}>Set password</button>
                  {u.status === "Disabled" || u.status === "Invited"
                    ? <button onClick={() => S.enableUser(u.id).then(() => toast(u.status === "Invited" ? "Account activated" : "Account re-enabled"))} className="text-xs" style={{ color: C.em }}>{u.status === "Invited" ? "Activate" : "Enable"}</button>
                    : !lastAdmin && u.roleKey !== "admin" && <button onClick={() => S.disableUser(u.id).then(() => toast("Account disabled"))} className="text-xs" style={{ color: C.dangerFg }}>Disable</button>}
                  {!lastAdmin && <button onClick={() => setDelUser(u)} className="text-xs" style={{ color: C.dangerFg }}>Delete</button>}
                </div>
              );
            } },
          ]}
        />
      </Card>
      <Modal open={!!editUser} onClose={() => setEditUser(null)} title={editUser ? "Edit " + editUser.name : "Edit user"}>
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Full name</label>
        <input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Phone</label>
        <input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="optional" className="w-full mt-1.5 mb-4 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <Btn kind="primary" full onClick={saveEdit} disabled={editBusy}>{editBusy ? "Saving…" : "Save changes"}</Btn>
      </Modal>
      <Modal open={!!pwUser} onClose={() => setPwUser(null)} title={pwUser ? "Set a password for " + pwUser.name : "Set password"}>
        <div className="text-sm mb-3" style={{ color: C.ink2 }}>This sets their password directly — no reset email is sent. Share it with them yourself.</div>
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>New password (8+ characters)</label>
        <input type="text" value={pwValue} onChange={(e) => setPwValue(e.target.value)} className="w-full mt-1.5 mb-4 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <Btn kind="primary" full onClick={savePassword} disabled={pwBusy}>{pwBusy ? "Setting…" : "Set password"}</Btn>
      </Modal>
      <ConfirmModal
        open={!!delUser}
        onClose={() => setDelUser(null)}
        title={delUser ? "Delete " + delUser.name + "?" : "Delete user?"}
        body="This permanently removes their login. If they still have jobs, placements or other records tied to their account, this will be blocked — disable them instead in that case."
        onConfirm={confirmDeleteUser}
        busy={delBusy}
      />
      <Modal open={open} onClose={() => setOpen(false)} title="Create an account">
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Full name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Work email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Temporary password (8+ characters)</label>
        <input type="text" value={pass} onChange={(e) => setPass(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <div className="text-xs font-medium mb-2" style={{ color: C.ink2 }}>Role</div>
        <div className="grid grid-cols-3 gap-2 mb-5">
          {ROLE_OPTIONS.map(([k, l]) => (
            <button key={k} onClick={() => setRoleKey(k)} className="rounded-xl border p-3 text-sm text-left" style={{ borderColor: roleKey === k ? C.em : C.line, background: roleKey === k ? C.emTint : "#fff", color: roleKey === k ? C.em : C.ink }}>{l}</button>
          ))}
        </div>
        <Btn kind="primary" full onClick={invite}>{busy ? "Creating\u2026" : "Create account"}</Btn>
        <div className="text-xs mt-2" style={{ color: C.ink3 }}>Share this email and password with them directly. The account starts as "Invited" — use Activate on their row here before they can sign in and use their profile.</div>
      </Modal>
      <Modal open={transferOpen} onClose={() => setTransferOpen(false)} title="Transfer ownership">
        <div className="text-sm mb-3" style={{ color: C.ink2 }}>The new owner becomes an admin who can't be demoted or disabled by anyone but themselves. You'll lose that protection.</div>
        <div className="flex flex-col gap-1.5 mb-5">
          {transferCandidates.length === 0 && <div className="text-sm" style={{ color: C.ink3 }}>No other active accounts to transfer to.</div>}
          {transferCandidates.map((u) => (
            <button key={u.id} onClick={() => setTransferTarget(u.id)} className="rounded-xl border p-3 text-sm text-left flex items-center justify-between" style={{ borderColor: transferTarget === u.id ? C.em : C.line, background: transferTarget === u.id ? C.emTint : "#fff" }}>
              <span><span className="font-medium">{u.name}</span><span className="text-xs ml-2" style={{ color: C.ink2 }}>{u.email}</span></span>
              <span className="text-xs" style={{ color: C.ink3 }}>{u.role}</span>
            </button>
          ))}
        </div>
        <Btn kind="danger" full disabled={!transferTarget || transferBusy} onClick={confirmTransfer}>{transferBusy ? "Transferring\u2026" : "Transfer ownership"}</Btn>
      </Modal>
    </div>
  );
}

function AgencyTab({ toast, S }) {
  const [name, setName] = useState(S.settings.name);
  const [guarantee, setGuarantee] = useState(String(S.settings.guaranteeDays));
  const [auto, setAuto] = useState(S.settings.ai);
  const [defaultCurrency, setDefaultCurrency] = useState(S.settings.defaultCurrency);
  const [defaultCountry, setDefaultCountry] = useState(S.settings.defaultCountry);
  const [busy, setBusy] = useState(false);
  const [company, setCompany] = useState(() => ({ ...(S.settings.company || {}) }));
  const [invoicePrefix, setInvoicePrefix] = useState(S.settings.invoicePrefix || "INV");
  const save = () => {
    setBusy(true);
    S.saveSettings({ ...S.settings, name, guaranteeDays: guarantee === "" ? 60 : Math.max(0, Number(guarantee) || 0), ai: auto, defaultCurrency, defaultCountry, company, invoicePrefix })
      .then(() => toast("Settings saved")).catch(() => {}).finally(() => setBusy(false));
  };
  return (
    <Card className="flex flex-col gap-4 md:max-w-xl">
      <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Agency name</label><input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
      <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Guarantee period (days)</label><input value={guarantee} onChange={(e) => setGuarantee(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Default currency</label>
          <select value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Default hiring country</label>
          <input list="harbor-default-countries" value={defaultCountry} onChange={(e) => { const v = e.target.value; setDefaultCountry(v); if (COUNTRY_CURRENCY[v]) setDefaultCurrency(COUNTRY_CURRENCY[v]); }} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
          <datalist id="harbor-default-countries">{Object.keys(COUNTRY_CURRENCY).map((c) => <option key={c} value={c} />)}</datalist>
        </div>
      </div>
      <div className="text-xs" style={{ color: C.ink3 }}>New jobs default to this currency and country unless changed when posting.</div>
      <button onClick={() => setAuto(!auto)} className="pt-3 flex items-center justify-between gap-3 text-left" style={{ borderTop: `1px solid ${C.line}` }}>
        <div><div className="text-sm font-medium">AI screening questions</div><div className="text-xs" style={{ color: C.ink2 }}>Draft questions for every new candidate. You approve before they send.</div></div>
        <div className="w-10 h-6 rounded-full flex items-center px-0.5 shrink-0" style={{ background: auto ? C.em : "#D5D2C7" }}><div className={`w-5 h-5 rounded-full bg-white ${auto ? "ml-auto" : ""}`} /></div>
      </button>
      <div className="pt-3 flex flex-col gap-3" style={{ borderTop: `1px solid ${C.line}` }}>
        <div><div className="text-sm font-medium">Invoice details</div><div className="text-xs" style={{ color: C.ink2 }}>Printed on invoices as "Bill from" and payment details. Anything left blank stays blank on the invoice.</div></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {COMPANY_FIELDS.map(([k, l]) => (
            <div key={k} className={k === "address" ? "sm:col-span-2" : ""}><label className="text-xs font-medium" style={{ color: C.ink2 }}>{l}</label><input value={company[k] || ""} onChange={(e) => setCompany({ ...company, [k]: e.target.value })} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
          ))}
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Default payment terms (days)</label><input type="number" min="0" value={company.termsDays != null ? company.termsDays : 30} onChange={(e) => setCompany({ ...company, termsDays: e.target.value === "" ? null : Number(e.target.value) })} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Invoice number prefix</label><input value={invoicePrefix} onChange={(e) => setInvoicePrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /><div className="text-xs mt-1" style={{ color: C.ink3 }}>Numbers look like {invoicePrefix || "INV"}-{new Date().getFullYear()}-0001</div></div>
        </div>
      </div>
      <Btn kind="primary" disabled={busy} onClick={save}>{busy ? <>Saving <InlineDots color="#fff" /></> : "Save changes"}</Btn>
    </Card>
  );
}

function DataPrivacyTab({ toast, S }) {
  const [retention, setRetention] = useState(S.settings.retentionDays ? String(S.settings.retentionDays) : "");
  const [busy, setBusy] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const days = num(retention);
  const eligible = days ? S.cands.filter((c) => c.status === "Rejected" && c.updatedAt < Date.now() - days * 864e5) : [];
  const saveRetention = () => {
    setBusy(true);
    S.saveSettings({ ...S.settings, retentionDays: days || null }).then(() => toast("Retention setting saved")).catch(() => {}).finally(() => setBusy(false));
  };
  const exportCandidates = () => downloadCsv("harbor-candidates.csv",
    ["Name", "Role", "Location", "Status", "Recruiter", "Email", "Phone", "AI score", "Added"],
    S.cands.map((c) => [c.name, c.role, c.location, c.status, c.recruiter || "", c.emailAddr, c.phone, c.ai, new Date(c.createdAt).toISOString().slice(0, 10)]));
  const exportPlacements = () => downloadCsv("harbor-placements.csv",
    ["Candidate", "Role", "Fee", "Recruiter incentive", "Status", "Recorded"],
    S.placements.map((p) => [p.name, p.role, p.fee, p.incentive || "", p.status, new Date(p.createdAt).toISOString().slice(0, 10)]));
  const confirmPurge = () => {
    setPurgeBusy(true);
    S.purgeCandidates(eligible.map((c) => c.id)).then(() => { toast(eligible.length + " candidate(s) removed"); setPurgeOpen(false); }).catch(() => {}).finally(() => setPurgeBusy(false));
  };
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle title="Export data" sub="Download a CSV for your own records or another system." size="text-lg" />
        <div className="flex flex-wrap gap-2 mt-4"><Btn icon={Download} onClick={exportCandidates}>Export candidates</Btn><Btn icon={Download} onClick={exportPlacements}>Export placements</Btn></div>
      </Card>
      <Card>
        <SectionTitle title="Data retention" sub="Automatically clean up candidates who've been rejected for a while." size="text-lg" />
        <div className="flex flex-col gap-3 mt-4 md:max-w-sm">
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Delete rejected candidates after (days)</label><input value={retention} onChange={(e) => setRetention(e.target.value)} placeholder="Never" className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
          <Btn kind="primary" disabled={busy} onClick={saveRetention}>{busy ? <>Saving <InlineDots color="#fff" /></> : "Save"}</Btn>
        </div>
        {days > 0 && (
          <div className="mt-4 pt-4 flex flex-wrap items-center justify-between gap-3" style={{ borderTop: `1px solid ${C.line}` }}>
            <div className="text-sm" style={{ color: C.ink2 }}>{eligible.length} rejected candidate{eligible.length === 1 ? "" : "s"} past {days} days right now.</div>
            <Btn kind="danger" disabled={!eligible.length} onClick={() => setPurgeOpen(true)}>Purge now</Btn>
          </div>
        )}
      </Card>
      <ConfirmModal open={purgeOpen} onClose={() => setPurgeOpen(false)} title="Delete these candidates?" body={"This permanently deletes " + eligible.length + " rejected candidate(s) past your retention window. This can't be undone."} onConfirm={confirmPurge} busy={purgeBusy} />
    </div>
  );
}

const INTEGRATIONS_LIST = [
  { key: "linkedin", label: "LinkedIn", sub: "Lets you pick LinkedIn as a channel when promoting a job." },
  { key: "googleJobs", label: "Google for Jobs", sub: "Lets you pick Google for Jobs as a channel when promoting a job." },
  { key: "googleCalendar", label: "Google Calendar", sub: "Adds an ‘Add to calendar’ link once a candidate reaches the Interview stage." },
];
function IntegrationsTab({ toast, S }) {
  const base = { linkedin: false, googleJobs: false, googleCalendar: false, ...S.settings.integrations };
  const [enabled, setEnabled] = useState(base);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(enabled) !== JSON.stringify(base);
  const toggle = (k) => setEnabled((e) => ({ ...e, [k]: !e[k] }));
  const save = () => { setBusy(true); S.saveSettings({ ...S.settings, integrations: enabled }).then(() => toast("Integrations saved")).catch(() => {}).finally(() => setBusy(false)); };
  return (
    <Card>
      <SectionTitle title="Integrations" sub="Turn on the channels and tools your team can use elsewhere in Harbor." size="text-lg" />
      <div className="flex flex-col gap-1 mt-4">
        {INTEGRATIONS_LIST.map((i) => (
          <button key={i.key} onClick={() => toggle(i.key)} className="py-3 flex items-center justify-between gap-3 text-left" style={{ borderTop: `1px solid ${C.line}` }}>
            <div><div className="text-sm font-medium">{i.label}</div><div className="text-xs" style={{ color: C.ink2 }}>{i.sub}</div></div>
            <div className="w-10 h-6 rounded-full flex items-center px-0.5 shrink-0" style={{ background: enabled[i.key] ? C.em : "#D5D2C7" }}><div className={`w-5 h-5 rounded-full bg-white ${enabled[i.key] ? "ml-auto" : ""}`} /></div>
          </button>
        ))}
      </div>
      <div className="text-xs mt-3" style={{ color: C.ink3 }}>LinkedIn and Google for Jobs post through your ad campaigns, tracked here in Harbor — a real posting connection to either platform isn't wired up yet.</div>
      <Btn kind="primary" className="mt-4" disabled={!dirty || busy} onClick={save}>{busy ? <>Saving <InlineDots color="#fff" /></> : "Save changes"}</Btn>
    </Card>
  );
}

function AuditLogTab({ S }) {
  return (
    <Card>
      <SectionTitle title="Audit log" sub="Sensitive actions across the agency: deletes, account changes, settings updates." size="text-lg" />
      <div className="mt-4">
        {S.auditLog.length === 0 ? <div className="text-sm" style={{ color: C.ink3 }}>Nothing logged yet.</div> : (
          <DataTable
            keyField="id"
            rows={S.auditLog}
            columns={[
              { key: "when", label: "WHEN", render: (a) => <span className="text-xs whitespace-nowrap" style={{ color: C.ink2 }}>{a.when}</span> },
              { key: "actor", label: "WHO", render: (a) => a.actor },
              { key: "action", label: "ACTION", render: (a) => <Pill tone={a.action === "deleted" || a.action === "purged" ? "danger" : "neutral"}>{a.action}</Pill> },
              { key: "entityType", label: "ON", render: (a) => a.entityType },
              { key: "detail", label: "DETAIL", render: (a) => <span className="text-xs" style={{ color: C.ink2 }}>{a.detail}</span> },
            ]}
          />
        )}
      </div>
    </Card>
  );
}

function SettingsPage({ toast, S }) {
  const [tab, setTab] = useState("agency");
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <SectionTitle size="text-3xl md:text-4xl" title="Agency settings" sub="Defaults that apply across the whole agency." />
      <div className="overflow-x-auto"><Tabs tabs={[{ key: "agency", label: "Agency" }, { key: "privacy", label: "Data & privacy" }, { key: "integrations", label: "Integrations" }, { key: "audit", label: "Audit log" }]} active={tab} setActive={setTab} /></div>
      {tab === "agency" && <AgencyTab toast={toast} S={S} />}
      {tab === "privacy" && <DataPrivacyTab toast={toast} S={S} />}
      {tab === "integrations" && <IntegrationsTab toast={toast} S={S} />}
      {tab === "audit" && <AuditLogTab S={S} />}
    </div>
  );
}

const fileToBase64 = (f) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = reject;
  r.readAsDataURL(f);
});

/* Add a candidate against a specific job. The screening questions for that job show up
   front, before anything is submitted. "Check fit" runs a resume-only AI read to help a
   recruiter decide whether it's worth going further — that draft stays invisible to
   everyone but them (enforced by RLS on candidates.is_draft), though it's still saved on
   the backend and logged to the audit log. Nothing shows up for Admin/Rec Ops until
   Submit, which needs the resume AND the job's screening questions answered. */
function AddCandidate({ setPage, toast, S, initialJobId }) {
  const openJobs = S.jobs.filter((j) => j.status !== "Closed");
  // Coming from a specific job's page pre-selects it here; opened from the Candidates
  // page directly (initialJobId null), the recruiter picks the job themselves below.
  const [jobId, setJobId] = useState(initialJobId && S.jobs.some((j) => j.id === initialJobId) ? initialJobId : "");
  const job = jobId ? S.jobs.find((j) => j.id === jobId) : null;
  const qs = (job && job.screeningQuestions) || [];
  const [answers, setAnswers] = useState([]);
  const [name, setName] = useState("");
  const [emailAddr, setEmailAddr] = useState("");
  const [phone, setPhone] = useState("");
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState(null);
  const [candId, setCandId] = useState(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fit, setFit] = useState(null);

  const setA = (i, v) => setAnswers((arr) => { const next = arr.slice(); next[i] = v; return next; });

  // Creates the draft candidate row the first time it's needed (Check fit or Submit),
  // then reuses the same row for the rest of this flow.
  const ensureDraft = async () => {
    if (candId) return candId;
    if (!name.trim()) { toast("Enter the candidate's name"); return null; }
    const c = newCandidate({ name: name.trim(), role: job ? job.role : "Unspecified", location: "Lagos, Nigeria", recruiter: S.me.name, recruiterId: S.me.id, recruiterInit: S.me.init, ai: 0, emailAddr, phone, isDraft: true, timeline: [{ t: "Added by " + S.me.first, d: todayStr(), done: true }] });
    await S.insertCandidateAwait(c);
    setCandId(c.id);
    return c.id;
  };

  const checkFit = async () => {
    if (!jobId) { toast("Pick a job first"); return; }
    if (!file && !candId) { toast("Upload a resume first"); return; }
    setChecking(true);
    try {
      const id = await ensureDraft();
      if (!id) { setChecking(false); return; }
      if (file) { await S.uploadResume(id, file); setFile(null); }
      const r = await S.checkFit(id, jobId, job);
      setFit(r);
    } catch (e) { toast(e.message || "Could not check fit"); }
    setChecking(false);
  };

  const submit = async () => {
    if (!jobId) { toast("Pick a job first"); return; }
    if (!file && !candId) { toast("Upload a resume first"); return; }
    if (qs.length && qs.some((_, i) => !(answers[i] || "").trim())) { toast("Answer every screening question first"); return; }
    setSubmitting(true);
    try {
      const id = await ensureDraft();
      if (!id) { setSubmitting(false); return; }
      if (file) { await S.uploadResume(id, file); setFile(null); }
      await S.submitDraftCandidate(id, jobId, qs.map((_, i) => answers[i] || ""), job);
      toast("Candidate added");
      setPage("candidates");
    } catch (e) { toast(e.message || "Could not add candidate"); }
    setSubmitting(false);
  };

  const startOver = () => { setJobId(""); setAnswers([]); setName(""); setEmailAddr(""); setPhone(""); setFileName(""); setFile(null); setCandId(null); setFit(null); };

  const FIT_TONE = { "Perfect fit": "em", "Possible fit": "warn", "Not a fit": "danger" };

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <button onClick={() => setPage("candidates")} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Candidates</button>
      <SectionTitle size="text-3xl md:text-4xl" title="Add candidate" sub="Pick the job, then their resume and (if you're ready) the screening answers." />
      <Card className="md:max-w-xl flex flex-col gap-4">
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: C.ink2 }}>Job</div>
          <select className="w-full text-sm rounded-lg border px-3 py-2 bg-white" style={{ borderColor: C.line, color: C.ink }} value={jobId} onChange={(e) => { setJobId(e.target.value); setAnswers([]); setFit(null); }}>
            <option value="">Choose a job…</option>
            {openJobs.map((j) => <option key={j.id} value={j.id}>{j.role} – {j.client}</option>)}
          </select>
        </div>
        {job && qs.length > 0 && (
          <div className="rounded-xl p-3" style={{ background: C.canvas }}>
            <div className="text-xs font-medium mb-2" style={{ color: C.ink2 }}>Screening questions for {job.role}</div>
            <div className="space-y-2.5">
              {qs.map((q, i) => (
                <div key={i}>
                  <div className="text-xs mb-1" style={{ color: C.ink2 }}>{i + 1}. {q}</div>
                  <textarea className="w-full text-sm rounded-lg border px-2 py-1.5 bg-white" style={{ borderColor: C.line, color: C.ink }} rows={2} value={answers[i] || ""} onChange={(e) => setA(i, e.target.value)} placeholder="Their answer…" />
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-medium mb-1.5" style={{ color: C.ink2 }}>Name</div>
            <input className="w-full text-sm rounded-lg border px-3 py-2 bg-white" style={{ borderColor: C.line, color: C.ink }} value={name} onChange={(e) => setName(e.target.value)} disabled={!!candId} placeholder="Candidate's name" />
          </div>
          <div>
            <div className="text-xs font-medium mb-1.5" style={{ color: C.ink2 }}>Email (optional)</div>
            <input className="w-full text-sm rounded-lg border px-3 py-2 bg-white" style={{ borderColor: C.line, color: C.ink }} value={emailAddr} onChange={(e) => setEmailAddr(e.target.value)} disabled={!!candId} placeholder="name@example.com" />
          </div>
        </div>
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: C.ink2 }}>Resume</div>
          <label className="flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed py-6 cursor-pointer text-center" style={{ borderColor: "#D5D2C7", background: "#FAF8F3" }}>
            <Upload size={20} color={C.ink2} />
            <div className="text-sm font-medium">{fileName || (candId ? "Resume on file — choose to replace" : "Choose a file")}</div>
            <div className="text-xs" style={{ color: C.ink3 }}>PDF, Word, text or photo</div>
            <input type="file" accept={RESUME_ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files[0]; if (f) { setFile(f); setFileName(f.name); setFit(null); } }} />
          </label>
        </div>
        {fit && (
          <div className="rounded-xl p-3 border" style={{ borderColor: C.line, background: C.canvas }}>
            <div className="flex items-center gap-2 mb-1"><Pill tone={FIT_TONE[fit.verdict] || "neutral"}>{fit.verdict}</Pill><span className="text-xs" style={{ color: C.ink2 }}>Fit {fit.score}% · resume only</span></div>
            <div className="text-sm" style={{ color: C.ink }}>{fit.reasoning}</div>
            <div className="text-xs mt-1.5" style={{ color: C.ink3 }}>Only you can see this check — it won't show up for anyone else unless you submit below.</div>
          </div>
        )}
        <div className="flex gap-2.5 flex-wrap">
          <Btn onClick={checkFit} disabled={checking || submitting}>{checking ? <>Checking <InlineDots /></> : "Check fit (resume only)"}</Btn>
          <Btn kind="primary" onClick={submit} disabled={checking || submitting}>{submitting ? <>Adding <InlineDots color="#fff" /></> : "Submit candidate"}</Btn>
          {(candId || jobId) && <button onClick={startOver} className="text-xs px-2" style={{ color: C.ink3 }}>Start over</button>}
        </div>
      </Card>
    </div>
  );
}

/* Candidate page (secure link, no login). Shows roles they've been routed to (accept or decline),
   approved follow-up questions to answer, their applications and roles that fit them.
   Accepting and answering go straight to the ai-screen function, which rescreens them. */
function CandidatePortal({ onBack, data, token, onChanged }) {
  const c = { name: "", endorsements: [], matches: [], routed: [], questions: [], answered: [], ...(data || {}) };
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const act = async (key, body, done) => {
    setBusy(key); setErr(""); setNote("");
    try {
      const r = await fetch(SB_URL + "/functions/v1/ai-screen", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
      setNote(done); if (onChanged) await onChanged();
    } catch (e) { setErr(e.message); }
    setBusy("");
  };
  const setA = (linkId, i, v) => setAnswers((m) => { const arr = (m[linkId] || []).slice(); arr[i] = v; return { ...m, [linkId]: arr }; });
  const inputStyle = { borderColor: C.line, background: "#FAF8F3" };
  return (
    <div className="min-h-screen" style={{ background: C.canvas }}>
      <div className="max-w-2xl mx-auto p-4 md:p-8 flex flex-col gap-4">
        {onBack && <button onClick={onBack} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Back to dashboard</button>}
        <div className="text-3xl md:text-4xl" style={{ ...SERIF }}>Hi {(c.name || "there").split(" ")[0]}</div>
        <div className="text-sm" style={{ color: C.ink2 }}>{c.routed.length || c.questions.length ? "Your recruiter has something for you below. Your answers go straight into your application." : "Here is where your applications stand."}</div>
        {note && <div className="text-sm rounded-xl px-3.5 py-2.5" style={{ background: C.emTint, color: C.em }}>{note}</div>}
        {err && <div className="text-sm rounded-xl px-3.5 py-2.5" style={{ background: C.dangerBg, color: C.dangerFg }}>{err}</div>}

        {c.routed.map((r) => (
          <Card key={r.linkId}>
            <div className="text-xs font-semibold mb-2" style={{ color: C.warnFg }}>A NEW ROLE FOR YOU</div>
            <div className="text-base font-semibold">{r.role}</div>
            <div className="text-sm" style={{ color: C.ink2 }}>{r.company}{r.location ? " · " + r.location : ""}</div>
            <div className="text-sm mt-2 mb-3" style={{ color: C.ink2 }}>Your recruiter thinks you'd be a strong fit. Would you like to be put forward?</div>
            <div className="flex gap-2">
              <Btn kind="primary" className="flex-1" disabled={!!busy} onClick={() => act("accept" + r.linkId, { action: "portal_respond", linkId: r.linkId, accept: true }, "Thanks! You've been put forward for " + r.role + ".")}>{busy === "accept" + r.linkId ? <>Sending <InlineDots color="#fff" /></> : "Yes, put me forward"}</Btn>
              <Btn disabled={!!busy} onClick={() => act("decline" + r.linkId, { action: "portal_respond", linkId: r.linkId, accept: false }, "Got it. We won't put you forward for " + r.role + ".")}>No thanks</Btn>
            </div>
          </Card>
        ))}

        {c.questions.map((q) => {
          const a = answers[q.linkId] || [];
          const complete = q.questions.every((_, i) => (a[i] || "").trim());
          return (
            <Card key={q.linkId}>
              <div className="text-base font-semibold">{q.role}</div>
              <div className="text-sm mb-3" style={{ color: C.ink2 }}>{q.company}</div>
              <div className="flex flex-col gap-3">
                {q.questions.map((text, i) => (
                  <div key={i} className="flex flex-col gap-1.5">
                    <label htmlFor={"q-" + q.linkId + "-" + i} className="text-sm font-medium">{text}</label>
                    <textarea id={"q-" + q.linkId + "-" + i} rows={3} value={a[i] || ""} onChange={(e) => setA(q.linkId, i, e.target.value)} placeholder="Your answer" className="rounded-lg border px-3 py-2.5 text-sm outline-none" style={inputStyle} />
                  </div>
                ))}
                <Btn kind="primary" full disabled={!!busy || !complete} onClick={() => act("answer" + q.linkId, { action: "portal_answer", linkId: q.linkId, answers: q.questions.map((_, i) => a[i] || "") }, "Answers sent. Thank you!")}>
                  {busy === "answer" + q.linkId ? <>Sending <InlineDots color="#fff" /></> : complete ? "Send answers" : "Answer every question to send"}
                </Btn>
              </div>
            </Card>
          );
        })}

        <Card>
          <SectionTitle title="Your applications" size="text-xl" />
          {c.endorsements.length === 0 && <div className="text-sm py-4" style={{ color: C.ink3 }}>No applications yet.</div>}
          {c.endorsements.map((e, i) => (
            <div key={i} className="flex items-center gap-3 py-3" style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
              <div className="flex-1 min-w-0"><div className="text-sm font-medium">{e.role}</div><div className="text-xs" style={{ color: C.ink2 }}>{e.company}</div></div>
              <StatusPill status={e.status} />
            </div>
          ))}
        </Card>
        {c.matches.length > 0 && (
          <Card>
            <SectionTitle title="Roles that fit you" sub="Shown at 70% match or higher." size="text-xl" />
            {c.matches.map((m, i) => (
              <div key={i} className="flex items-center justify-between py-3 gap-2" style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
                <div><div className="text-sm font-medium">{m.role}</div><div className="text-xs" style={{ color: C.ink2 }}>{m.company}</div></div>
                <Pill tone="em">{m.fit}%</Pill>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* App root                                                                 */
/* ---------------------------------------------------------------------- */
function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    if (!email || !password) { setErr("Enter your email and password"); return; }
    setBusy(true); setErr("");
    try { const s = await signIn(email.trim(), password); store.set(s); onSignedIn(s); }
    catch (e) { setErr(e.message === "Invalid login credentials" ? "Wrong email or password" : e.message); }
    setBusy(false);
  };
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: C.canvas }}>
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border p-6" style={{ background: "#fff", borderColor: C.line }}>
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: C.side }}><span style={{ ...SERIF, color: C.lime, fontSize: 18 }}>H</span></div>
          <span className="text-2xl" style={{ ...SERIF }}>Harbor</span>
        </div>
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full mt-1.5 mb-2 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        {err && <div className="text-xs mb-3" style={{ color: C.dangerFg }}>{err}</div>}
        <Btn type="submit" kind="primary" full className="mt-3" onClick={submit}>{busy ? <>Signing in <InlineDots color="#fff" /></> : "Sign in"}</Btn>
        <div className="text-xs mt-4 text-center" style={{ color: C.ink3 }}>Accounts are created by your agency's admin. There is no self sign-up.</div>
      </form>
    </div>
  );
}

function AwaitingAccess({ onSignOut }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 text-center" style={{ background: C.canvas }}>
      <div className="max-w-sm">
        <div className="text-2xl mb-2" style={{ ...SERIF }}>Almost there</div>
        <div className="text-sm mb-5" style={{ color: C.ink2 }}>Your account is signed in but not active yet. Ask your Harbor admin to activate it.</div>
        <Btn onClick={onSignOut}>Sign out</Btn>
      </div>
    </div>
  );
}

const FETCH_PATH = "/rest/v1/candidates?select=*,candidate_endorsements(*),candidate_comments(*),candidate_timeline(*),candidate_jobs(*)&order=created_at.desc";
async function loadAll(token) {
  const [profiles, candidates, jobs, applications, placements, campaigns, ads, settingsRows, jobEngagements, auditLog] = await Promise.all([
    sbFetch("/rest/v1/profiles?select=*", { token }),
    sbFetch(FETCH_PATH, { token }),
    sbFetch("/rest/v1/jobs?select=*,job_recruiters(*),candidate_jobs(*)&order=created_at.desc", { token }),
    sbFetch("/rest/v1/applications?select=*&order=created_at.desc", { token }),
    sbFetch("/rest/v1/placements?select=*&order=created_at.desc", { token }),
    sbFetch("/rest/v1/campaigns?select=*&order=created_at.desc", { token }),
    sbFetch("/rest/v1/ad_campaigns?select=*&order=created_at.desc", { token }),
    sbFetch("/rest/v1/agency_settings?select=*", { token }),
    sbFetch("/rest/v1/job_engagements?select=*&order=engaged_at.desc", { token }),
    sbFetch("/rest/v1/audit_log?select=*&order=created_at.desc&limit=200", { token }).catch(() => []), // empty for non-admins (RLS), never fatal
  ]);
  return mapAll({ profiles, candidates, jobs, applications, placements, campaigns, ads, settings: settingsRows[0], jobEngagements, auditLog });
}

export default function App() {
  const [session, setSession] = useState(() => store.get());
  const [me, setMe] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | signedout | pending | ready | error
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);
  const [errMsg, setErrMsg] = useState("");
  const [page, setPageRaw] = useState("overview");
  const [query, setQueryRaw] = useState("");
  const [candId, setCandId] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [addCandidateJobId, setAddCandidateJobId] = useState(null);
  const [billFor, setBillFor] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toastText, setToastText] = useState("");
  const [promote, setPromote] = useState({ open: false, job: "" });
  const [portal, setPortal] = useState(false);
  const [portalToken] = useState(() => new URLSearchParams(window.location.search).get("c"));
  const [portalData, setPortalData] = useState(null);

  const toast = (t) => { setToastText(t); setTimeout(() => setToastText(""), 2600); };
  const signOut = () => { store.set(null); setSession(null); setMe(null); setData(null); setStatus("signedout"); };

  const loadPortal = () => sbFetch("/rest/v1/rpc/candidate_portal", { method: "POST", body: { p_token: portalToken } }).then(setPortalData).catch(() => setPortalData({ error: true }));
  React.useEffect(() => { if (portalToken) loadPortal(); }, [portalToken]); // eslint-disable-line

  const boot = async (s) => {
    try {
      let sess = s;
      if (sess.exp < Date.now() + 30000) { sess = await refreshSession(sess); store.set(sess); }
      const profile = (await sbFetch("/rest/v1/profiles?select=*&id=eq." + sess.uid, { token: sess.token }))[0];
      if (!profile || profile.status !== "Active") { setSession(sess); setMe(profile ? mapUser(profile) : null); setStatus("pending"); return; }
      setSession(sess); setMe(mapUser(profile));
      const d = await loadAll(sess.token);
      setData(d); setStatus("ready");
    } catch (e) { setErrMsg(e.message); setStatus("error"); }
  };

  React.useEffect(() => { if (session) boot(session); else setStatus("signedout"); }, []); // eslint-disable-line

  React.useEffect(() => {
    const f = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); const el = document.getElementById("harbor-search"); if (el) el.focus(); } };
    window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f);
  }, []);

  if (portalToken) {
    if (!portalData) return <div className="min-h-screen flex items-center justify-center" style={{ background: C.canvas }}><div style={{ color: C.ink2 }}>Loading&hellip;</div></div>;
    if (portalData.error || !portalData.name) return <div className="min-h-screen flex items-center justify-center p-4 text-center" style={{ background: C.canvas }}><div style={{ color: C.ink2 }}>This link is not valid.</div></div>;
    return <CandidatePortal data={portalData} token={portalToken} onChanged={loadPortal} onBack={() => { window.history.replaceState({}, "", window.location.pathname); window.location.reload(); }} />;
  }

  if (status === "loading") return <Loader label="Loading your workspace…" />;
  if (status === "signedout") return <SignIn onSignedIn={(s) => { setSession(s); setStatus("loading"); boot(s); }} />;
  if (status === "pending") return <AwaitingAccess onSignOut={signOut} />;
  if (status === "error") return (
    <div className="min-h-screen flex items-center justify-center p-4 text-center" style={{ background: C.canvas }}>
      <div className="max-w-sm"><div className="text-sm mb-4" style={{ color: C.dangerFg }}>Could not load Harbor: {errMsg}</div><Btn onClick={signOut}>Sign out and try again</Btn></div>
    </div>
  );

  const role = me.roleKey;
  const setPage = (p) => { setCandId(null); setPageRaw(p); };
  const setQuery = (v) => { setQueryRaw(v); if (v && page !== "candidates" && page !== "jobs") setPage("candidates"); };
  const myMe = { name: me.name, label: me.role, init: initialsOf(me.name), first: me.name.split(" ")[0], id: me.id, email: me.email, phone: me.phone, avatarUrl: me.avatarUrl, roleKey: me.roleKey, notificationPrefs: me.notificationPrefs, isOwner: me.isOwner };
  const reload = () => { setRefreshing(true); return loadAll(session.token).then(setData).catch((e) => toast(e.message)).finally(() => setRefreshing(false)); };
  const call = async (path, opts) => { try { await sbFetch(path, { ...opts, token: session.token }); reload(); } catch (e) { toast(e.message); throw e; } };
  const aiCall = async (action, payload) => {
    const r = await fetch(SB_URL + "/functions/v1/ai-screen", { method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "AI request failed"); reload(); return j;
  };
  // Fire-and-forget entry in the admin-only audit log. Never blocks or fails the action it's logging.
  const logAudit = (action, entityType, entityId, detail) => {
    sbFetch("/rest/v1/audit_log", { method: "POST", token: session.token, body: { actor_id: session.uid, action, entity_type: entityType, entity_id: entityId != null ? String(entityId) : null, detail: detail || null } }).catch(() => {});
  };

  // Local candidate field -> candidates table column, for the fields a person can actually edit.
  const CAND_FIELD_MAP = { status: "status", name: "name", role: "role_title", location: "location", emailAddr: "email", phone: "phone", experience: "experience", notice: "notice", pay: "pay", skills: "skills", strengths: "strengths", gaps: "gaps", ai: "ai_score", recruiterId: "recruiter_id", ai_locked: "ai_locked" };
  const updateCand = (id, patch) => {
    const c = data.cands.find((x) => x.id === id); const p = typeof patch === "function" ? patch(c) : patch;
    const body = {}; Object.entries(CAND_FIELD_MAP).forEach(([k, col]) => { if (k in p) body[col] = p[k]; });
    setData((d) => ({ ...d, cands: d.cands.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
    (async () => {
      try {
        if (Object.keys(body).length) await sbFetch("/rest/v1/candidates?id=eq." + id, { method: "PATCH", token: session.token, body });
        if (p.comments) await sbFetch("/rest/v1/candidate_comments", { method: "POST", token: session.token, body: { candidate_id: id, author_id: session.uid, body: p.comments[0].text } });
        if (p.timeline) await sbFetch("/rest/v1/candidate_timeline", { method: "POST", token: session.token, body: { candidate_id: id, title: p.timeline[p.timeline.length - 1].t } });
        if (p.endorsed) { const e = p.endorsed[p.endorsed.length - 1]; await sbFetch("/rest/v1/candidate_endorsements", { method: "POST", token: session.token, body: { candidate_id: id, company: e.company, role_title: e.role, status: e.status, next_step: e.next, endorsed_by: session.uid } }); }
        if (p.screening) await sbFetch("/rest/v1/candidates?id=eq." + id, { method: "PATCH", token: session.token, body: { screening: p.screening } });
        // Ripple this into the audit log so status moves (and other edits) stay traceable
        // from wherever they were triggered — the candidate page, Billing, a bulk action, etc.
        if ("status" in body) logAudit("status changed", "candidate", id, (c ? c.name : "") + ": " + (c ? c.status : "?") + " → " + p.status);
        if ("ai_locked" in body && body.ai_locked === false) logAudit("unlocked", "candidate", id, (c ? c.name : "") + ": review unlocked, AI can re-screen");
        const otherFields = Object.keys(body).filter((k) => k !== "status" && k !== "ai_score" && k !== "ai_locked");
        if (otherFields.length) logAudit("edited", "candidate", id, c ? c.name : "");
        reload();
      } catch (e) { toast(e.message); reload(); }
    })();
  };

  // Local job field -> jobs table column, for the fields a person can edit after posting.
  const JOB_FIELD_MAP = { role: "role_title", client: "client", location: "location", workSetup: "work_setup", minPay: "min_pay", maxPay: "max_pay", description: "description", currency: "currency", country: "country", seo: "seo",
    salaryPeriod: "salary_period", commissionOnly: "commission_only", employmentType: "employment_type", headcount: "headcount",
    billingType: "billing_type", billingAmount: "billing_amount", billingCurrency: "billing_currency", billingFrequency: "billing_frequency", billingMonths: "billing_months",
    incentiveType: "incentive_type", incentiveAmount: "incentive_amount", incentiveCurrency: "incentive_currency", incentiveFrequency: "incentive_frequency", incentiveMonths: "incentive_months",
    screeningQuestions: "screening_questions", status: "status" };
  const updateJob = (id, patch) => {
    const j = data.jobs.find((x) => x.id === id); const p = typeof patch === "function" ? patch(j) : patch;
    const body = {}; Object.entries(JOB_FIELD_MAP).forEach(([k, col]) => { if (k in p) body[col] = p[k]; });
    setData((d) => ({ ...d, jobs: d.jobs.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
    return sbFetch("/rest/v1/jobs?id=eq." + id, { method: "PATCH", token: session.token, body })
      .then(() => {
        const label = j ? j.role + ", " + j.client : "";
        if ("status" in body) logAudit("status changed", "job", id, label + ": " + (j ? j.status : "?") + " → " + p.status);
        const otherFields = Object.keys(body).filter((k) => k !== "status");
        if (otherFields.length) logAudit("edited", "job", id, label);
        reload();
      })
      .catch((e) => { toast(e.message); reload(); throw e; });
  };

  const S = {
    role, me: myMe, query, toast, go: setPage,
    cands: data.cands, updateCand,
    deleteCandidate: (id) => { const c = data.cands.find((x) => x.id === id); return call("/rest/v1/candidates?id=eq." + id, { method: "DELETE" }).then(() => logAudit("deleted", "candidate", id, c ? c.name : "")); },
    setCands: (fn) => { const list = typeof fn === "function" ? fn(data.cands) : fn; const added = list.filter((c) => !data.cands.some((x) => x.id === c.id));
      setData((d) => ({ ...d, cands: list })); added.forEach((c) => call("/rest/v1/candidates", { method: "POST", body: { id: c.id, name: c.name, role_title: c.role, location: c.location, recruiter_id: c.recruiterId, status: c.status, ai_score: c.ai || null, email: c.emailAddr || null, phone: c.phone || null } })); },
    jobs: data.jobs, updateJob,
    deleteJob: (id) => { const j = data.jobs.find((x) => x.id === id); return call("/rest/v1/jobs?id=eq." + id, { method: "DELETE" }).then(() => logAudit("deleted", "job", id, j ? j.role + ", " + j.client : "")); },
    setJobs: (fn) => { const list = typeof fn === "function" ? fn(data.jobs) : fn; const j = list[0];
      setData((d) => ({ ...d, jobs: list })); call("/rest/v1/jobs", { method: "POST", body: { id: j.id, role_title: j.role, client: j.client, location: j.location || null, work_setup: j.workSetup || null, min_pay: j.minPay || null, max_pay: j.maxPay || null, description: j.description || null, currency: j.currency || "NGN", country: j.country || null, seo: j.seo || null,
        salary_period: j.commissionOnly ? null : (j.salaryPeriod || "Yearly"), commission_only: !!j.commissionOnly, employment_type: j.employmentType || null, headcount: j.headcount || 1,
        billing_type: j.billingType || "percent", billing_amount: j.billingAmount || null, billing_currency: j.billingCurrency || j.currency || "NGN",
        billing_frequency: j.billingFrequency || "One-off", billing_months: j.billingFrequency === "Monthly" ? (j.billingMonths || null) : null,
        incentive_type: j.incentiveType || "percent", incentive_amount: j.incentiveAmount || null, incentive_currency: j.incentiveCurrency || j.currency || "NGN",
        incentive_frequency: j.incentiveFrequency || "One-off", incentive_months: j.incentiveFrequency === "Monthly" ? (j.incentiveMonths || null) : null,
        screening_questions: j.screeningQuestions || [],
        status: j.status, created_by: session.uid } }); },
    inbox: data.inbox,
    setInbox: (fn) => { const list = typeof fn === "function" ? fn(data.inbox) : fn;
      setData((d) => ({ ...d, inbox: list })); const x = list.find((i) => i.assignedId); if (x) call("/rest/v1/applications?id=eq." + x.id, { method: "PATCH", body: { assigned_to: x.assignedId } }); },
    placements: data.placements,
    /* p: { name, role, candidateId, jobId, recruiterId, recruiterInit, fee, feeCurrency, incentive, incentiveCurrency } */
    insertPlacement: async (p) => {
      const gDays = p.guaranteeDays != null && p.guaranteeDays !== "" ? Math.max(0, Number(p.guaranteeDays)) : (data.settings.guaranteeDays != null ? data.settings.guaranteeDays : 60);
      const startDate = p.startDate || ymdToday();
      const guaranteeEnds = addDays(startDate, gDays);
      const row = { id: uid(), name: p.name, role: p.role, candidateId: p.candidateId || null, jobId: p.jobId || null, recruiterId: p.recruiterId || null, recruiter: p.recruiterInit || "", fee: money(p.fee, p.feeCurrency), feeNum: Number(p.fee) || 0, feeCurrency: p.feeCurrency || "NGN", incentive: p.incentive != null && p.incentive !== "" ? money(p.incentive, p.incentiveCurrency) : null, incentiveNum: p.incentive != null && p.incentive !== "" ? Number(p.incentive) : null, guarantee: "Ends " + fdate(guaranteeEnds), status: gDays === 0 ? "Ready" : "Guarantee", createdAt: Date.now(), startDate, guaranteeDays: gDays, guaranteeEnds, billedAt: null, invoice: {} };
      setData((d) => ({ ...d, placements: [row, ...d.placements] }));
      try {
        await call("/rest/v1/placements", { method: "POST", body: { id: row.id, candidate_name: p.name, role_desc: p.role, candidate_id: p.candidateId || null, job_id: p.jobId || null, recruiter_id: p.recruiterId || null, fee: Number(p.fee) || 0, fee_currency: p.feeCurrency || "NGN", recruiter_incentive: p.incentive != null && p.incentive !== "" ? Number(p.incentive) : null, recruiter_incentive_currency: p.incentiveCurrency || null, guarantee_ends: guaranteeEnds, start_date: startDate, guarantee_days: gDays, status: gDays === 0 ? "Ready" : "Guarantee" } });
        logAudit("created", "placement", row.id, p.name + (p.role ? " — " + p.role : "") + " (" + row.fee + ")");
        // Being billed IS being placed — a candidate can't sit at "Rejected"/anything
        // else while a placement exists for them, or Billing and their own status
        // tell two different stories. This is the single place that creates a
        // placement (both "Mark placed" and "New billing entry" call it), so fixing
        // the candidate's status here keeps the two in sync no matter which door was used.
        const c = data.cands.find((x) => x.id === p.candidateId);
        if (c && c.status !== "Placed") {
          updateCand(c.id, (cc) => ({ status: "Placed", timeline: [...cc.timeline, { t: "Status set to Placed", d: todayStr(), done: true }] }));
        }
        reload();
      } catch (e) { toast(e.message); setData((d) => ({ ...d, placements: d.placements.filter((x) => x.id !== row.id) })); throw e; }
    },
    setPlacementStatus: (id, status) => { const pl = data.placements.find((x) => x.id === id);
      return call("/rest/v1/placements?id=eq." + id, { method: "PATCH", body: { status } })
        .then(() => {
          setData((d) => ({ ...d, placements: d.placements.map((p) => (p.id === id ? { ...p, status } : p)) }));
          logAudit("status changed", "placement", id, (pl ? pl.name : "") + ": " + (pl ? pl.status : "?") + " → " + status);
        })
        .catch((e) => toast(e.message)); },
    updatePlacement: (id, patch) => { const pl = data.placements.find((x) => x.id === id);
      return call("/rest/v1/placements?id=eq." + id, { method: "PATCH", body: patch })
        .then(() => logAudit("updated", "placement", id, (pl ? pl.name : "") + ": " + Object.keys(patch).join(", "))); },
    claimInvoiceNumber: () => sbFetch("/rest/v1/rpc/claim_invoice_number", { method: "POST", token: session.token, body: {} }),
    deletePlacement: (id) => { const pl = data.placements.find((x) => x.id === id);
      return call("/rest/v1/placements?id=eq." + id, { method: "DELETE" }).then(() => logAudit("deleted", "placement", id, pl ? pl.name + " (" + pl.fee + ")" : "")); },
    campaigns: data.campaigns,
    setCampaigns: (fn) => { const list = typeof fn === "function" ? fn(data.campaigns) : fn;
      const changed = list.find((c, i) => !data.campaigns[i] || data.campaigns[i].status !== c.status);
      setData((d) => ({ ...d, campaigns: list }));
      const existing = changed && data.campaigns.find((c) => c.id === changed.id);
      if (existing) call("/rest/v1/campaigns?id=eq." + changed.id, { method: "PATCH", body: { status: changed.status } }).then(() => logAudit("status changed", "campaign", changed.id, changed.name + ": " + existing.status + " → " + changed.status));
      else if (changed) call("/rest/v1/campaigns", { method: "POST", body: { id: changed.id, name: changed.name, created_by: session.uid } }).then(() => logAudit("created", "campaign", changed.id, changed.name));
    },
    deleteCampaign: (id) => { const c = data.campaigns.find((x) => x.id === id); return call("/rest/v1/campaigns?id=eq." + id, { method: "DELETE" }).then(() => logAudit("deleted", "campaign", id, c ? c.name : "")); },
    ads: data.ads,
    setAds: (fn) => { const list = typeof fn === "function" ? fn(data.ads) : fn;
      const existingIds = new Set(data.ads.map((a) => a.id)); const added = list.filter((a) => !existingIds.has(a.id));
      const changed = list.find((a) => { const o = data.ads.find((x) => x.id === a.id); return o && o.status !== a.status; });
      setData((d) => ({ ...d, ads: list }));
      added.forEach((a) => call("/rest/v1/ad_campaigns", { method: "POST", body: { id: a.id, job_title: a.job, client: a.client, channels: a.channels, payer_type: a.payerType, budget: num(a.budget), status: a.status, created_by: session.uid } }).then(() => logAudit("created", "ad_campaign", a.id, a.job)));
      if (changed) { const prevStatus = (data.ads.find((x) => x.id === changed.id) || {}).status;
        call("/rest/v1/ad_campaigns?id=eq." + changed.id, { method: "PATCH", body: { status: changed.status } }).then(() => logAudit("status changed", "ad_campaign", changed.id, changed.job + ": " + prevStatus + " → " + changed.status)); }
    },
    deleteAd: (id) => { const a = data.ads.find((x) => x.id === id); return call("/rest/v1/ad_campaigns?id=eq." + id, { method: "DELETE" }).then(() => logAudit("deleted", "ad_campaign", id, a ? a.job : "")); },
    users: data.users,
    createAccount: async ({ email, password, full_name, role }) => {
      const r = await fetch(SB_URL + "/functions/v1/create-user", { method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, full_name, role }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "Could not create account"); logAudit("created", "user", j.id || null, full_name + " (" + role + ")"); reload();
    },
    disableUser: (id) => { const u = data.users.find((x) => x.id === id); return call("/rest/v1/profiles?id=eq." + id, { method: "PATCH", body: { status: "Disabled" } }).then(() => logAudit("disabled", "user", id, u ? u.name : "")); },
    enableUser: (id) => { const u = data.users.find((x) => x.id === id); return call("/rest/v1/profiles?id=eq." + id, { method: "PATCH", body: { status: "Active" } }).then(() => logAudit("enabled", "user", id, u ? u.name : "")); },
    /* Admin-only, via the profiles_admin_write policy (not the self-update path, so the anti-escalation trigger doesn't apply here).
       The owner's own row is separately protected in the DB (profiles_protect_owner trigger) so this is a no-op if aimed at them. */
    updateUserRole: (id, roleKey) => { const u = data.users.find((x) => x.id === id);
      return call("/rest/v1/profiles?id=eq." + id, { method: "PATCH", body: { role: roleKey, level: ROLE_KEY_LABEL[roleKey] } })
        .then(() => logAudit("role changed", "user", id, (u ? u.name : "") + " -> " + ROLE_KEY_LABEL[roleKey])); },
    /* Only the current owner can call this (enforced by the transfer_ownership() DB function, not just this check). */
    transferOwnership: (newOwnerId) => { const u = data.users.find((x) => x.id === newOwnerId);
      return sbFetch("/rest/v1/rpc/transfer_ownership", { method: "POST", token: session.token, body: { new_owner_id: newOwnerId } })
        .then(() => { logAudit("ownership transferred", "user", newOwnerId, "-> " + (u ? u.name : "")); reload(); }); },
    /* Name/phone only — role changes go through updateUserRole, and email/password through the
       create-user edge function below (needs the service role, not available to the client). */
    editUser: (id, patch) => { const u = data.users.find((x) => x.id === id);
      return call("/rest/v1/profiles?id=eq." + id, { method: "PATCH", body: { full_name: patch.name, phone: patch.phone || null } })
        .then(() => { logAudit("edited", "user", id, u ? u.name : ""); reload(); }); },
    /* Sets their password directly (no reset email) — for handing someone a new login on the spot. */
    setUserPassword: async (id, password) => {
      const u = data.users.find((x) => x.id === id);
      const r = await fetch(SB_URL + "/functions/v1/create-user", { method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_password", id, password }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "Could not set password");
      logAudit("password reset", "user", id, u ? u.name : "");
    },
    /* Permanently removes their login (auth.users, cascading to profiles). The edge function
       refuses this if the person still has jobs/placements/etc referencing their account —
       disable them instead in that case. Never usable on the owner. */
    deleteUser: async (id) => {
      const u = data.users.find((x) => x.id === id);
      const r = await fetch(SB_URL + "/functions/v1/create-user", { method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "Could not delete account");
      logAudit("deleted", "user", id, u ? u.name : ""); reload();
    },
    settings: data.settings,
    saveSettings: (v) => call("/rest/v1/agency_settings?id=eq.1", { method: "PATCH", body: { agency_name: v.name, guarantee_days: v.guaranteeDays, ai_screening: v.ai, default_currency: v.defaultCurrency, default_country: v.defaultCountry, retention_days: v.retentionDays || null, integrations: v.integrations || {}, company: v.company || {}, invoice_prefix: v.invoicePrefix || "INV" } }).then(() => logAudit("updated", "agency_settings", "1", "Agency settings changed")),
    auditLog: data.auditLog,
    /* Deletes rejected candidates older than the retention window (data-privacy tab computes the eligible list). */
    purgeCandidates: async (ids) => {
      for (const id of ids) { await sbFetch("/rest/v1/candidates?id=eq." + id, { method: "DELETE", token: session.token }).catch(() => {}); }
      logAudit("purged", "candidates", null, ids.length + " rejected candidate(s) past the retention window");
      reload();
    },
    /* Your own account security: password, TOTP two-factor, and signing out other sessions. */
    changePassword: (password) => sbFetch("/auth/v1/user", { method: "PUT", token: session.token, body: { password } }),
    mfaListFactors: async () => { const j = await sbFetch("/auth/v1/user", { token: session.token }); return j.factors || []; },
    mfaEnroll: () => sbFetch("/auth/v1/factors", { method: "POST", token: session.token, body: { factor_type: "totp", friendly_name: "Authenticator app" } }),
    mfaChallenge: (factorId) => sbFetch("/auth/v1/factors/" + factorId + "/challenge", { method: "POST", token: session.token, body: {} }),
    mfaVerify: (factorId, challengeId, code) => sbFetch("/auth/v1/factors/" + factorId + "/verify", { method: "POST", token: session.token, body: { challenge_id: challengeId, code } }),
    mfaUnenroll: (factorId) => sbFetch("/auth/v1/factors/" + factorId, { method: "DELETE", token: session.token }),
    signOutEverywhere: () => sbFetch("/auth/v1/logout?scope=others", { method: "POST", token: session.token, body: {} }),
    updateNotificationPrefs: (prefs) => { setMe((m) => ({ ...m, notificationPrefs: prefs })); return sbFetch("/rest/v1/profiles?id=eq." + session.uid, { method: "PATCH", token: session.token, body: { notification_prefs: prefs } }).catch((e) => toast(e.message)); },
    team: buildTeam(data.users, data.cands, data.placements),
    openCandidate: (id) => setCandId(id),
    // Opens Billing with the new billing entry form ready for this candidate.
    startBilling: (id) => { setCandId(null); setBillFor(id); setPage("billing"); },
    billFor, clearBillFor: () => setBillFor(null),
    insertCandidateAwait: (c) => call("/rest/v1/candidates", { method: "POST", body: { id: c.id, name: c.name, role_title: c.role, location: c.location, recruiter_id: c.recruiterId, status: c.status, ai_score: c.ai || null, email: c.emailAddr || null, is_draft: !!c.isDraft } }),
    logAudit,
    setJobStatus: (id, status) => { const j = data.jobs.find((x) => x.id === id);
      return call("/rest/v1/jobs?id=eq." + id, { method: "PATCH", body: { status } }).then(() => {
        setData((d) => ({ ...d, jobs: d.jobs.map((x) => (x.id === id ? { ...x, status } : x)) }));
        logAudit("status changed", "job", id, (j ? j.role + ", " + j.client : "") + ": " + (j ? j.status : "?") + " → " + status);
      }); },
    /* Candidate <-> job pipeline (candidate_jobs table). screeningAnswers: [{q,a}] answered by the
       recruiter right when they attach the candidate to a job that has screening_questions. */
    /* Submitting a candidate to a job opens their company card; the first AI screening
       (resume + application answers + anything they've answered for other jobs) starts right away. */
    linkJob: async (candidateId, jobId, fit, screeningAnswers) => {
      let rows;
      try { rows = await sbFetch("/rest/v1/candidate_jobs?on_conflict=candidate_id,job_id", { method: "POST", token: session.token, prefer: "resolution=ignore-duplicates,return=representation", body: { candidate_id: candidateId, job_id: jobId, fit: fit || null, stage: "In review", screening_answers: screeningAnswers || [] } }); }
      catch (e) { toast(e.message); throw e; }
      reload();
      const row = rows && rows[0];
      if (row) aiCall("screen", { linkId: row.id }).then(() => { toast("AI screening ready"); reload(); }).catch((e) => toast("Added, but the AI couldn't screen yet: " + e.message));
      return row;
    },
    /* Routing: the role shows on the candidate's page; their company card appears once they accept. */
    routeToJob: (candidateId, jobId) => call("/rest/v1/candidate_jobs?on_conflict=candidate_id,job_id", { method: "POST", prefer: "resolution=ignore-duplicates", body: { candidate_id: candidateId, job_id: jobId, stage: "Sourced", candidate_response: "pending" } }),
    /* "Add candidate" flow — quick, resume-only fit check on a draft candidate that stays
       invisible to everyone but its creator (enforced by RLS on is_draft) until Submit.
       Still persisted on the backend and logged to the audit log, per the AI's own result. */
    checkFit: async (candidateId, jobId, job) => {
      const r = await aiCall("check_fit", { candidateId, jobId });
      logAudit("checked fit", "candidate", candidateId, (job ? job.role + " – " + job.client : "") + ": " + r.verdict);
      return r;
    },
    /* Submit finishes the draft: clears is_draft (making the candidate visible to staff),
       saves the resume-derived fields via score_cv, then attaches to the job with the
       answered screening questions — same pipeline as any other candidate from here on. */
    submitDraftCandidate: async (candidateId, jobId, screeningAnswers, job) => {
      await sbFetch("/rest/v1/candidates?id=eq." + candidateId, { method: "PATCH", token: session.token, body: { is_draft: false } });
      try { await aiCall("score_cv", { candidateId }); } catch (e) { /* resume may already be scored from Check fit */ }
      let rows;
      try { rows = await sbFetch("/rest/v1/candidate_jobs?on_conflict=candidate_id,job_id", { method: "POST", token: session.token, prefer: "resolution=ignore-duplicates,return=representation", body: { candidate_id: candidateId, job_id: jobId, stage: "In review", screening_answers: screeningAnswers || [] } }); }
      catch (e) { toast(e.message); throw e; }
      reload();
      const row = rows && rows[0];
      if (row) aiCall("screen", { linkId: row.id }).then(() => reload()).catch((e) => toast("Added, but the AI couldn't screen yet: " + e.message));
      logAudit("added candidate", "candidate", candidateId, job ? job.role + " – " + job.client : "");
      return row;
    },
    setStage: (linkId, stage) => call("/rest/v1/candidate_jobs?id=eq." + linkId, { method: "PATCH", body: { stage } }),
    setScreeningAnswers: (linkId, screeningAnswers) => call("/rest/v1/candidate_jobs?id=eq." + linkId, { method: "PATCH", body: { screening_answers: screeningAnswers } }),
    unlinkJob: (linkId) => call("/rest/v1/candidate_jobs?id=eq." + linkId, { method: "DELETE" }),
    /* Engage/disengage log: job_recruiters is the "currently on it" set; job_engagements is the
       permanent history (engaged_at / disengaged_at / reason) admins review per job. */
    jobEngagements: data.jobEngagements,
    engageJob: async (jobId) => {
      await sbFetch("/rest/v1/job_recruiters?on_conflict=job_id,recruiter_id", { method: "POST", token: session.token, prefer: "resolution=ignore-duplicates", body: { job_id: jobId, recruiter_id: session.uid } });
      await call("/rest/v1/job_engagements", { method: "POST", body: { job_id: jobId, recruiter_id: session.uid } });
    },
    disengageJob: async (jobId, reason) => {
      await sbFetch("/rest/v1/job_recruiters?job_id=eq." + jobId + "&recruiter_id=eq." + session.uid, { method: "DELETE", token: session.token });
      await call("/rest/v1/job_engagements?job_id=eq." + jobId + "&recruiter_id=eq." + session.uid + "&disengaged_at=is.null", { method: "PATCH", body: { disengaged_at: new Date().toISOString(), reason: reason || null } });
    },
    /* Resumes live in the private `resumes` bucket at <candidateId>/<file>. ai-screen reads the same file. */
    uploadResume: async (candidateId, file) => {
      const path = candidateId + "/" + Date.now() + "-" + file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      const r = await fetch(SB_URL + "/storage/v1/object/resumes/" + path, { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + session.token, "Content-Type": resumeMime(file.name, file.type), "x-upsert": "true" }, body: file });
      if (!r.ok) { const t = await r.text(); toast("Upload failed: " + t); throw new Error(t); }
      await call("/rest/v1/candidates?id=eq." + candidateId, { method: "PATCH", body: { resume_path: path, resume_name: file.name } });
      return path;
    },
    openResume: async (path) => {
      const bucket = path.includes("/") ? "resumes" : "cvs"; // legacy CVs were stored flat in `cvs`
      const w = window.open("", "_blank");
      try {
        const r = await fetch(SB_URL + "/storage/v1/object/sign/" + bucket + "/" + path, { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 600 }) });
        const j = await r.json(); if (!r.ok || !j.signedURL) throw new Error(j.message || j.error || "Could not open resume");
        const url = SB_URL + "/storage/v1" + j.signedURL; if (w) w.location.href = url; else window.location.href = url;
      } catch (e) { if (w) w.close(); toast(e.message); }
    },
    /* AI rewrite of a job ad for search (job-redraft Edge Function) */
    aiRedraft: async (payload) => {
      const r = await fetch(SB_URL + "/functions/v1/job-redraft", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || j.message || j.msg || "AI redraft failed"); return j;
    },
    /* Reads an uploaded job brief (PDF, Word, text, photo) and has AI pull the job fields
       out of it, to prefill "Post a job" (job-redraft Edge Function, "extract" mode). */
    parseJobDoc: async (file) => {
      const data = await fileToBase64(file);
      const r = await fetch(SB_URL + "/functions/v1/job-redraft", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "extract", file: { name: file.name, data } }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || j.message || j.msg || "Couldn't read that file"); return j;
    },
    aiScreen: aiCall,
    /* Your own account: name/phone update straight to your profiles row, avatar via the public `avatars` bucket. */
    updateMyProfile: (patch) => {
      const body = {}; if ("name" in patch) body.full_name = patch.name; if ("phone" in patch) body.phone = patch.phone;
      setMe((m) => ({ ...m, ...("name" in patch ? { name: patch.name } : {}), ...("phone" in patch ? { phone: patch.phone } : {}) }));
      return sbFetch("/rest/v1/profiles?id=eq." + session.uid, { method: "PATCH", token: session.token, body })
        .then(reload)
        .catch((e) => { toast(e.message); reload(); throw e; });
    },
    uploadAvatar: async (file) => {
      const path = session.uid + "/" + Date.now() + "-" + file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      const r = await fetch(SB_URL + "/storage/v1/object/avatars/" + path, { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + session.token, "Content-Type": file.type || "image/png", "x-upsert": "true" }, body: file });
      if (!r.ok) { const t = await r.text(); toast("Upload failed: " + t); throw new Error(t); }
      const url = SB_URL + "/storage/v1/object/public/avatars/" + path;
      setMe((m) => ({ ...m, avatarUrl: url }));
      await sbFetch("/rest/v1/profiles?id=eq." + session.uid, { method: "PATCH", token: session.token, body: { avatar_url: url } }).catch((e) => toast(e.message));
      reload();
      return url;
    },
  };
  const onPromote = (job) => setPromote({ open: true, job });
  const pendingQ = countFollowups(data.cands, "draft");

  if (portal) return <CandidatePortal onBack={() => setPortal(false)} data={null} />;

  const scope = role === "recruiter" ? "recruiter" : "all";
  const candData = role === "recruiter" ? data.cands.filter((c) => c.recruiterId === session.uid) : data.cands;
  const candidate = data.cands.find((c) => c.id === candId);

  let content;
  if (candidate) content = <CandidateDetail key={candidate.id} candidate={candidate} onBack={() => setCandId(null)} toast={toast} S={S} />;
  else if (page === "overview") content = role === "recruiter" ? <OverviewRecruiter S={S} /> : <OverviewRecOps S={S} />;
  else if (page === "candidates") content = <CandidatesList scope={scope} data={candData} openCandidate={(c) => setCandId(c.id)} setPage={setPage} onAddCandidate={() => { setAddCandidateJobId(null); setPage("uploadCandidates"); }} S={S} toast={toast} />;
  else if (page === "uploadCandidates") content = <AddCandidate setPage={setPage} toast={toast} S={S} initialJobId={addCandidateJobId} />;
  else if (page === "inbox") content = <InboxPage toast={toast} S={S} />;
  else if (page === "jobs") content = <JobsPage setPage={setPage} onPromote={onPromote} S={S} onOpenJob={(id) => { setJobId(id); setPageRaw("jobDetail"); }} />;
  else if (page === "postJob") content = <PostJobForm setPage={setPage} toast={toast} onPromote={onPromote} S={S} onOpenJob={(id) => { setJobId(id); setPageRaw("jobDetail"); }} />;
  else if (page === "editJob") content = <PostJobForm setPage={setPage} toast={toast} onPromote={onPromote} S={S} onOpenJob={(id) => { setJobId(id); setPageRaw("jobDetail"); }} editJob={data.jobs.find((j) => j.id === jobId)} />;
  else if (page === "jobDetail") content = <JobDetail job={data.jobs.find((j) => j.id === jobId)} S={S} toast={toast} onBack={() => setPage("jobs")} onPromote={onPromote} onEdit={() => setPage("editJob")} onDeleted={() => setPage("jobs")} onAddCandidate={() => { setAddCandidateJobId(jobId); setPage("uploadCandidates"); }} />;
  else if (page === "campaigns") content = <CampaignsPage toast={toast} S={S} />;
  else if (page === "billing") content = <BillingPage role={role} toast={toast} S={S} />;
  else if (page === "ads") content = <AdsPage role={role} toast={toast} onPromote={onPromote} S={S} />;
  else if (page === "users") content = role === "admin" ? <UsersPage toast={toast} S={S} /> : <OverviewRecOps S={S} />;
  else if (page === "settings") content = role === "admin" ? <SettingsPage toast={toast} S={S} /> : <OverviewRecOps S={S} />;
  else if (page === "myProfile") content = <MyProfilePage S={S} toast={toast} onBack={() => setPage("overview")} />;
  else content = <OverviewRecOps S={S} />;

  return (
    <div className="flex min-h-screen" style={{ background: C.canvas, color: C.ink, fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>
      <TopProgressBar show={refreshing} />
      <Sidebar role={role} page={page} setPage={setPage} me={myMe} pendingQ={pendingQ} onSignOut={signOut} />
      <div className="flex-1 min-w-0">
        <TopBar query={query} setQuery={setQuery} S={S} />
        <div className="px-4 md:px-8" style={{ paddingBottom: 96 }}>{content}</div>
      </div>
      <MobileBottomNav role={role} page={page} setPage={setPage} onMore={() => setMoreOpen(true)} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} role={role} page={page} setPage={setPage} me={myMe} onSignOut={signOut} />
      <PromoteModal open={promote.open} onClose={() => setPromote({ ...promote, open: false })} jobTitle={promote.job} toast={toast} S={S} />
      <Toast text={toastText} />
    </div>
  );
}
