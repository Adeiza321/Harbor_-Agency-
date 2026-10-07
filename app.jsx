import React, { useState, useEffect } from "react";
import {
  LayoutDashboard, Users, Inbox as InboxIcon, Briefcase, TrendingUp, Send,
  CreditCard, Megaphone, Search, Bell, ChevronDown, ChevronRight, ChevronLeft,
  Plus, Download, Filter, Upload, Check, CheckCheck, X, Lock, Copy, MessageSquare,
  Sparkles, AlertTriangle, Mail, MapPin, Clock, Settings, Shield,
  Phone, CheckCircle2, MoreHorizontal, UserPlus, Pencil, Info, Calendar,
  Camera, UserRound, MessageCircle, ArrowLeft, SendHorizontal, Paperclip,
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
  Open: "info", "On hold": "warn", Closed: "neutral", Offer: "em", Engaged: "em", Closing: "warn",
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
// Requests that stall (a dropped connection) are cut off instead of hanging forever;
// reads are retried once automatically before giving up with a clear message.
const SLOW_MSG = "The server didn't answer in time. Check your internet connection and try again.";
async function sbFetch(path, { method = "GET", body, token, prefer, timeout = 20000 } = {}, attempt = 0) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
  let r;
  try {
    r = await fetch(SB_URL + path, { method, signal: ctl ? ctl.signal : undefined, headers: { apikey: SB_KEY, Authorization: "Bearer " + (token || SB_KEY), "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (method === "GET" && attempt === 0) return sbFetch(path, { method, body, token, prefer, timeout }, 1);
    throw new Error(e && e.name === "AbortError" ? SLOW_MSG : "Couldn't reach the server. Check your internet connection and try again.");
  }
  if (timer) clearTimeout(timer);
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = { message: t }; }
  if (!r.ok) throw new Error((j && (j.message || j.msg || j.error_description || j.error)) || r.statusText);
  return j;
}
const store = { get: () => { try { return JSON.parse(localStorage.getItem("harbor.session") || "null"); } catch (e) { return null; } }, set: (v) => { try { if (v) localStorage.setItem("harbor.session", JSON.stringify(v)); else localStorage.removeItem("harbor.session"); } catch (e) {} } };
// Inactivity tracking for automatic sign-out (see App). The limit is the agency setting,
// remembered locally so a stale session can be refused before anything loads.
const IDLE_KEY = "harbor.lastActive", IDLE_MIN_KEY = "harbor.idleMinutes", IDLE_WARN_MS = 120000;
const idleStore = {
  last: () => { try { return Number(localStorage.getItem(IDLE_KEY)) || 0; } catch (e) { return 0; } },
  touch: (t) => { try { localStorage.setItem(IDLE_KEY, String(t)); } catch (e) {} },
  clear: () => { try { localStorage.removeItem(IDLE_KEY); } catch (e) {} },
  minutes: () => { try { const m = Number(localStorage.getItem(IDLE_MIN_KEY)); return m >= 5 && m <= 480 ? m : 30; } catch (e) { return 30; } },
  setMinutes: (m) => { try { localStorage.setItem(IDLE_MIN_KEY, String(m)); } catch (e) {} },
  label: () => { const m = idleStore.minutes(); return m < 60 ? m + " minutes" : m === 60 ? "1 hour" : m / 60 + " hours"; },
};
const idleExpired = () => { const l = idleStore.last(); return !!l && Date.now() - l >= idleStore.minutes() * 60000; };
// Ends the session on the server too (revokes its refresh token), best effort.
const endServerSession = (s) => { try { fetch(SB_URL + "/auth/v1/logout?scope=local", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + s.token } }).catch(() => {}); } catch (e) {} };
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
// Job status is the role's own state (Open, On hold, Closed). Engaging is per person and separate.
const JOB_STATUSES = ["Open", "On hold", "Closed"];
// On hold and Closed roles take no new candidates (the database enforces it too).
const takesCandidates = (j) => !!j && j.status !== "Closed" && j.status !== "On hold";
const holdText = (j) => "On hold" + (j.holdUntil ? " until " + fdate(j.holdUntil + "T12:00:00") : "") + (j.holdReason ? ": " + j.holdReason : "");
// A role the candidate is actively on (accepted, not finished).
const isLiveLink = (l) => l.response === "accepted" && !["Rejected", "Withdrawn", "Placed"].includes(l.stage);
// Every match score is a percentage (0-100). One colour scale everywhere: 80+ green,

// ProNext logo (wordmark and the chevron mark), embedded so it shows without a network call.
const LOGO_SRC = "data:image/png;base64,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";
const MARK_SRC = "data:image/png;base64,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";
function BrandLogo({ height = 28, chip = false, style }) {
  const img = <img src={LOGO_SRC} alt="ProNext" style={{ height, width: "auto", display: "block", ...(chip ? {} : style) }} />;
  return chip ? <div className="rounded-lg inline-flex items-center" style={{ background: "#fff", padding: "5px 9px", ...style }}>{img}</div> : img;
}
function BrandMark({ size = 32, chip = true }) {
  return <div className="rounded-lg flex items-center justify-center shrink-0" style={{ width: size, height: size, background: chip ? "#fff" : "transparent" }}><img src={MARK_SRC} alt="ProNext" style={{ width: size * 0.72, height: size * 0.72 }} /></div>;
}

// 60-79 amber (60 is where ProNext counts someone as a strong fit), under 60 red.
const scoreTone = (v) => (!v ? "neutral" : v >= 80 ? "em" : v >= 60 ? "warn" : "danger");
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
    skills: c.skills || [], strengths: c.strengths || [], gaps: c.gaps || [], screening: c.screening || { state: "pending" }, matches: c.matches || [], portal: c.portal_token, photoUrl: c.photo_url || null, source: c.source, cv: c.resume_path || c.cv_path || null, cvName: c.resume_name || null,
    ai_locked: !!c.ai_locked, ai_locked_reason: c.ai_locked_reason || "", isDraft: !!c.is_draft,
    industries: Array.isArray(c.industries) ? c.industries : [], industriesAt: c.industries_checked_at || null,
    parallelTitles: Array.isArray(c.parallel_titles) ? c.parallel_titles : [], parallelTitlesAt: c.parallel_titles_at || null,
    currentTitle: c.current_title || "", currentCompany: c.current_company || "", linkedin: c.linkedin_url || "", pitchConsent: !!c.pitch_consent, pitchAnswered: !!c.pitch_consent_at, emailOptOut: !!c.email_opt_out, profileReadAt: c.profile_read_at || null,
    jobLinks: (c.candidate_jobs || []).map((l) => ({ id: l.id, jobId: l.job_id, stage: l.stage, fit: l.fit, screeningAnswers: l.screening_answers || [], ai: l.ai || {}, response: l.candidate_response || "accepted", reject: l.reject_reason ? { kind: l.reject_kind, reason: l.reject_reason, feedback: l.reject_feedback || "", message: l.reject_message || "", at: l.rejected_at, by: pname(l.rejected_by) } : null, createdAt: l.created_at ? new Date(l.created_at).getTime() : 0, submittedAt: l.submitted_at ? new Date(l.submitted_at).getTime() : null,
      clientToken: l.client_token, clientRevealed: !!l.client_revealed, clientRevealedAt: l.client_revealed_at, clientViewedAt: l.client_viewed_at,
      // Messages with this candidate about this specific job (candidate_job_messages), oldest first.
      messages: (l.candidate_job_messages || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((m) => ({ id: m.id, sender: m.sender, authorId: m.author_id, body: m.body, at: new Date(m.created_at).getTime(), recruiterReadAt: m.recruiter_read_at, candidateReadAt: m.candidate_read_at, deliveredAt: m.delivered_at, emailStatus: m.email_status, emailError: m.email_error, file: m.attachment_path ? { name: m.attachment_name, type: m.attachment_type, size: m.attachment_size } : null })) })),
    endorsed: (c.candidate_endorsements || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((e) => ({ id: e.id, company: e.company, role: e.role_title, by: fdate(e.created_at) + " by " + pname(e.endorsed_by).split(" ")[0], status: e.status, next: e.next_step || "" })),
    comments: (c.candidate_comments || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((m) => ({ who: pname(m.author_id).split(" ")[0], role: ROLE_KEY_LABEL[(pm[m.author_id] || {}).role] || "", init: initialsOf(pname(m.author_id)), tone: "info", when: fdate(m.created_at), text: m.body })),
    timeline: (c.candidate_timeline || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((t) => ({ t: t.title, d: fdate(t.created_at), done: t.done, at: new Date(t.created_at).getTime() })),
  }));
  const ends = d.candidates.flatMap((c) => c.candidate_endorsements || []);
  const jobs = d.jobs.map((j) => { const en = ends.filter((e) => e.company === j.client && e.role_title === j.role_title); const links = j.candidate_jobs || [];
    const active = links.filter((l) => l.stage !== "Rejected" && l.stage !== "Withdrawn");
    // "Submitted" means actually submitted to the client (candidate_jobs.submitted_at set,
    // i.e. stage has reached Submitted/Interview/Offer/Placed) — NOT every candidate still
    // sitting earlier in the pipeline (Sourced/In review/Screening), which `active` also
    // includes. Using `active` here made this number match "lineup", not the Overview
    // dashboard's own submissions count.
    const submittedLinks = links.filter((l) => l.submitted_at);
    return { id: j.id, role: j.role_title, client: j.client, description: j.description || "", location: j.location || "", workSetup: j.work_setup || "", minPay: j.min_pay, maxPay: j.max_pay, currency: j.currency || "NGN", country: j.country || "", seo: j.seo || null, createdAt: j.created_at ? new Date(j.created_at).getTime() : Date.now(), screeningQuestions: j.screening_questions || [],
      salaryPeriod: j.salary_period || "Yearly", commissionOnly: !!j.commission_only, employmentType: j.employment_type || "", headcount: j.headcount != null ? j.headcount : 1,
      billingFrequency: j.billing_frequency || "One-off", billingMonths: j.billing_months,
      incentiveFrequency: j.incentive_frequency || "One-off", incentiveMonths: j.incentive_months,
      billingType: j.billing_type || "percent", billingAmount: j.billing_amount, billingCurrency: j.billing_currency || j.currency || "NGN",
      incentiveType: j.incentive_type || "percent", incentiveAmount: j.incentive_amount, incentiveCurrency: j.incentive_currency || j.currency || "NGN",
      recruiters: (j.job_recruiters || []).map((r) => initialsOf(pname(r.recruiter_id))),
      engagedIds: (j.job_recruiters || []).map((r) => r.recruiter_id), engagedNames: (j.job_recruiters || []).map((r) => pname(r.recruiter_id)),
      holdReason: j.hold_reason || "", holdUntil: j.hold_until || null, heldAt: j.held_at ? new Date(j.held_at).getTime() : null, heldBy: j.held_by ? pname(j.held_by) : "",
      submitted: new Set([...en.map((e) => e.candidate_id), ...submittedLinks.map((l) => l.candidate_id)]).size,
      interview: new Set([...en.filter((e) => e.status === "Interview").map((e) => e.candidate_id), ...links.filter((l) => l.stage === "Interview").map((l) => l.candidate_id)]).size, days: Math.floor((Date.now() - new Date(j.created_at)) / 864e5), status: j.status, link: "harbor.link/j/" + j.link_slug }; });
  const inbox = d.applications.map((a) => ({ id: a.id, name: a.name, role: a.role_title, source: a.source || "-", email: a.email || "", phone: a.phone || "", ai: a.ai_score || 0, when: ago(a.created_at), assigned: a.assigned_to ? initialsOf(pname(a.assigned_to)) : null, assignedId: a.assigned_to, candidateId: a.candidate_id }));
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
  const secByUser = {};
  (d.profileSecurity || []).forEach((s) => { secByUser[s.user_id] = { lastIp: s.last_ip || "", lastLocation: s.last_location || "", lastLoginAt: s.last_login_at ? new Date(s.last_login_at).getTime() : null }; });
  const users = d.profiles.map(mapUser).map((u) => ({ ...u, security: secByUser[u.id] || { lastIp: "", lastLocation: "", lastLoginAt: null } }));
  const candName = {}; d.candidates.forEach((c) => (candName[c.id] = c.name));
  const jobRow = {}; d.jobs.forEach((j) => (jobRow[j.id] = j));
  const interviews = (d.interviews || []).map((i) => {
    const start = new Date(i.starts_at).getTime(), j = jobRow[i.job_id] || null;
    return { id: i.id, candidateId: i.candidate_id, candidateName: candName[i.candidate_id] || "Candidate", jobId: i.job_id, linkId: i.link_id, roleTitle: j ? j.role_title : "", client: j ? j.client : "",
      round: i.round || "1st round", start, end: start + (i.duration_min || 60) * 60000, durationMin: i.duration_min || 60, locationType: i.location_type || "meet", location: i.location || "", meetUrl: i.meet_url || "",
      notes: i.notes || "", recruiterId: i.recruiter_id, recruiter: pname(i.recruiter_id), schedulerTz: i.scheduler_tz, candidateTz: i.candidate_tz, clientTz: i.client_tz,
      status: i.status, decision: i.decision, feedback: i.feedback || "", confirmed: !!i.candidate_confirmed_at, googleEventId: i.google_event_id, googleError: i.google_error || "",
      sendReminders: i.send_reminders !== false, noshowSent: i.noshow_followup_sent_at || null };
  });
  return { cands, jobs, inbox, placements, campaigns, ads, jobEngagements, auditLog, users, interviews,
    settings: { name: set.agency_name || "ProNext", guaranteeDays: set.guarantee_days != null ? set.guarantee_days : 60, ai: set.ai_screening !== false,
      defaultCurrency: set.default_currency || "NGN", defaultCountry: set.default_country || "Nigeria", retentionDays: set.retention_days || null,
      integrations: set.integrations || {}, company: set.company || {}, invoicePrefix: set.invoice_prefix || "INV", idleMinutes: set.idle_timeout_minutes || 30 } };
}
function buildTeam(users, cands, placements) {
  return users.filter((u) => u.status === "Active" && (u.roleKey === "recruiter" || u.roleKey === "recops")).map((u) => {
    const mine = cands.filter((c) => c.recruiterId === u.id); const placed = mine.filter((c) => c.status === "Placed").length;
    // "submissions" = candidates actually submitted to a client (a job link that reached
    // submitted_at), not just every candidate on this recruiter's bench (mine.length) —
    // matches the definition the Overview dashboard's own Submissions chart uses.
    const submitted = mine.reduce((n, c) => n + (c.jobLinks || []).filter((l) => l.submittedAt).length, 0);
    const billedPlacements = placements.filter((p) => p.recruiterId === u.id && ["Ready", "Invoiced", "Paid"].includes(p.status));
    return { id: u.id, init: initialsOf(u.name), name: u.name, level: u.role, submissions: submitted, interviews: mine.filter((c) => c.status === "Interview").length, placed, conv: mine.length ? Math.round((placed / mine.length) * 100) : 0, billed: sumByCurrency(billedPlacements, "feeNum", "feeCurrency") };
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
// Lineup = every candidate a recruiter put forward for a job (candidate_jobs row), whether or
// not it ever reached the client. Bucketed by when the link was made, not by submittedAt, so a
// candidate rejected internally before ever being submitted still shows up somewhere.
const lineupOf = (cands, recruiterId) => cands.filter((c) => !recruiterId || c.recruiterId === recruiterId)
  .flatMap((c) => (c.jobLinks || []).map((l) => ({ at: l.createdAt, submittedAt: l.submittedAt, stage: l.stage, cand: c, link: l })));
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
const SERIES_COLORS = { lineup: "#3B4BB8", submitted: "#534AB7", passed: "#EDA100", failed: "#D85A30", placed: "#1D9E75" };
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
  // Only show rows that actually have something in them — an item with 0 people is nothing to
  // act on, so it's just clutter here.
  const rows = items.filter((r) => (r.people || []).length > 0);
  return (
    <Card>
      <SectionTitle title={title} />
      {rows.length === 0 ? (
        <div className="text-sm py-6 text-center" style={{ color: C.ink3 }}>Nothing needs attention right now.</div>
      ) : (
      <div className="mt-3 flex flex-col">
        {rows.map((r, i) => {
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
      )}
    </Card>
  );
}
const daysAgo = (t) => { const d = Math.floor((Date.now() - t) / 864e5); return d <= 0 ? "today" : d === 1 ? "1 day" : d + " days"; };
const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
const jobName = (S, jobId) => { const j = S.jobs.find((x) => x.id === jobId); return j ? j.client : ""; };
const linkPeople = (S, pred) => S.cands.flatMap((c) => (c.jobLinks || []).filter((l) => pred(l, c)).map((l) => ({ id: c.id, name: c.name, sub: jobName(S, l.jobId) })));

/* Recruiter performance for one month or one year: four bars per recruiter, all drawn from the
   same cohort — every candidate a recruiter lined up (linked to a job) in the period. Submitted,
   Failed and Passed are outcomes within that cohort, tracked to wherever they stand now, so a
   candidate rejected internally before ever reaching the client still counts as Failed. */
function RecruiterPerformanceChart({ S }) {
  const now = new Date();
  const [mode, setMode] = useState("month");
  const [month, setMonth] = useState(now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0"));
  const [year, setYear] = useState(String(now.getFullYear()));
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); return { v: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"), l: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) }; });
  const allLineup = lineupOf(S.cands);
  const firstYear = Math.min(now.getFullYear(), ...allLineup.map((x) => new Date(x.at).getFullYear()));
  const years = Array.from({ length: now.getFullYear() - firstYear + 1 }, (_, i) => String(now.getFullYear() - i));
  const [y0, m0] = month.split("-").map(Number);
  const from = mode === "month" ? new Date(y0, m0 - 1, 1).getTime() : new Date(Number(year), 0, 1).getTime();
  const to = mode === "month" ? new Date(y0, m0, 1).getTime() : new Date(Number(year) + 1, 0, 1).getTime();
  const owners = new Set(S.cands.map((c) => c.recruiterId).filter(Boolean));
  const people = (S.users || []).filter((u) => u.status === "Active" && (u.roleKey === "recruiter" || u.roleKey === "recops" || owners.has(u.id)));
  const rows = people.map((u) => {
    const mine = allLineup.filter((x) => x.cand.recruiterId === u.id && x.at >= from && x.at < to);
    return {
      name: u.name,
      lineup: mine.length,
      submitted: mine.filter((x) => x.submittedAt).length,
      passed: mine.filter((x) => x.stage === "Placed").length,
      // Failed = rejected or withdrawn, whether that happened before the candidate was ever
      // submitted (rejected on our end, during our own screening/review) or after (client-end).
      failed: mine.filter((x) => ["Rejected", "Withdrawn"].includes(x.stage)).length,
    };
  }).sort((a, b) => b.passed - a.passed || b.lineup - a.lineup);
  const label = mode === "month" ? months.find((m) => m.v === month)?.l : year;
  const sel = { borderColor: C.line, background: "#FAF8F3" };
  const series = [["Lineup", "lineup"], ["Submitted", "submitted"], ["Failed", "failed"], ["Passed (placed)", "placed"]].map(([name, k]) => ({ name, color: SERIES_COLORS[k], data: rows.map((r) => r[k === "placed" ? "passed" : k]) }));
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <SectionTitle title="Recruiter performance" sub={"Candidates lined up in " + label + " and what has happened to them since"} />
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
      <div className="text-xs mt-2" style={{ color: C.ink3 }}>Lineup = candidates put forward for a job. Submitted = reached the client. Passed = placed. Failed = rejected or withdrawn, on our end or the client's.</div>
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
// Parallel work: someone at Interview or Offer on another role, or already Placed/Hired,
// is never pitched for a new one. Returns what they're busy with, or null.
const BUSY_STAGES = ["Interview", "Offer", "Placed"];
function busyWith(c, jobs) {
  const l = (c.jobLinks || []).find((x) => x.response !== "declined" && BUSY_STAGES.includes(x.stage));
  if (l) { const j = (jobs || []).find((x) => x.id === l.jobId); return l.stage + (j ? " with " + j.client : ""); }
  if (["Interview", "Placed", "Hired"].includes(c.status)) return c.status;
  return null;
}
// A role counts as a fit only after the full AI review (location, seniority, skills,
// every requirement) rated them Possible or Perfect fit at 60% or more.
const FIT_MIN = 60;
const isRealFit = (m) => !!(m && m.reviewedAt && ["Perfect fit", "Good fit", "Possible fit"].includes(m.verdict) && (m.fit || 0) >= FIT_MIN);
// Reviewed fits for this job among people who are free to be pitched and aren't on it yet.
function benchFitsFor(job, S) {
  return S.cands
    .filter((c) => !c.jobLinks.some((l) => l.jobId === job.id) && !busyWith(c, S.jobs))
    .map((c) => ({ c, m: (c.matches || []).find((m) => m.job_id === job.id) }))
    .filter((x) => isRealFit(x.m))
    .sort((a, b) => (b.m.fit || 0) - (a.m.fit || 0));
}
// Open roles a candidate really fits (for the profile card, dashboard and counts).
function realMatches(c, S) {
  if (busyWith(c, S.jobs)) return [];
  return (c.matches || []).filter((m) => {
    const j = S.jobs.find((x) => x.id === m.job_id);
    return j && takesCandidates(j) && !c.jobLinks.some((l) => l.jobId === j.id) && isRealFit(m);
  });
}

/* Helpers */
// Long text shown in two lines with a "more" toggle.
function Clamp({ text, lines = 2, className = "" }) {
  const [open, setOpen] = useState(false);
  const long = String(text || "").length > 70;
  return (
    <div className={className}>
      <div style={!open && long ? { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" } : null}>{text}</div>
      {long && <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-normal underline mt-0.5" style={{ color: C.ink2 }} aria-expanded={open}>{open ? "Less" : "More"}</button>}
    </div>
  );
}
// Skill pills: the first 12, then "+N more".
function SkillPills({ skills, max = 12 }) {
  const [open, setOpen] = useState(false);
  const shown = open ? skills : skills.slice(0, max);
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {shown.map((s, i) => <Pill key={i} tone="neutral">{s}</Pill>)}
      {skills.length > max && <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs underline px-1" style={{ color: C.ink2 }} aria-expanded={open}>{open ? "Show fewer" : "+" + (skills.length - max) + " more"}</button>}
    </div>
  );
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
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
// location/phone default to blank, never a guessed value: the AI screener (score_cv) only fills
// them from the resume when the candidate doesn't already have one on file, so a hardcoded
// default here would silently block that fill forever. Let the UI show "not set" instead and
// leave resume + screening answers as the only source of truth.
const newCandidate = (o) => ({ id: uid(), recruiterId: null, emailAddr: "", phone: "", portal: "", createdAt: Date.now(), location: "", recruiter: null, recruiterInit: "", status: "In review", ai: 70, email: "Unverified", opens: 0, activity: "Just now", experience: "-", notice: "-", pay: "-", skills: [], strengths: [], gaps: [], endorsed: [], screening: { state: "pending" }, comments: [], timeline: [], matches: [], cv: null, ...o });

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

function Btn({ children, onClick, kind = "ghost", icon: Icon, className = "", full = false, type = "button", disabled = false, title }) {
  const base = `inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium ${full ? "w-full" : ""}`;
  const style =
    kind === "primary" ? { background: C.em, color: "#fff" } :
    kind === "dark" ? { background: C.ink, color: "#fff" } :
    kind === "danger" ? { background: C.dangerFg, color: "#fff" } :
    { background: "#fff", color: C.ink, border: `1px solid ${C.line}` };
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title || undefined} className={`${base} ${className}`} style={{ ...style, ...(disabled ? { opacity: 0.6, cursor: "not-allowed" } : {}) }}>
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

function Loader({ label = "Loading…", onRetry }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(t); }, []);
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-5" style={{ background: C.canvas }}>
      <GlobalStyles />
      <div className="relative flex items-center justify-center" style={{ width: 56, height: 56 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `3px solid ${C.line}` }} />
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "3px solid transparent", borderTopColor: C.em, animation: "harborSpin 0.85s linear infinite" }} />
        <img src={MARK_SRC} alt="" style={{ width: 26, height: 26 }} />
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <div style={{ animation: "harborPulse 1.8s ease-in-out infinite" }}><BrandLogo height={22} /></div>
        <div className="text-xs" style={{ color: C.ink3 }}>{label}</div>
        {slow && <div className="text-xs mt-2 text-center" style={{ color: C.ink2 }}>This is taking longer than usual. Your connection may be slow.</div>}
        {slow && onRetry && <button type="button" onClick={onRetry} className="text-xs font-medium mt-1" style={{ color: C.em }}>Try again</button>}
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

// Errors interrupt with a modal the person has to dismiss, rather than a toast that can be
// missed or mistaken for a success message.
function ErrorModal({ message, onClose }) {
  if (!message) return null;
  return (
    <Modal open={!!message} onClose={onClose} title="Something went wrong">
      <div className="flex items-start gap-3 mb-5">
        <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: C.dangerBg, color: C.dangerFg }}><X size={16} strokeWidth={2.5} /></div>
        <div className="text-sm leading-relaxed pt-1" style={{ color: C.ink }}>{message}</div>
      </div>
      <Btn kind="primary" full onClick={onClose}>Dismiss</Btn>
    </Modal>
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
// Page numbers to show: first, last, and the pages around the current one, with gaps as "…".
function pageList(page, pages) {
  const want = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const out = []; let prev = 0;
  [...want].sort((a, b) => a - b).forEach((n) => { if (n - prev > 1) out.push("…" + n); out.push(n); prev = n; });
  return out;
}
function Pager({ page, pages, size, total, onPage, onSize }) {
  const from = total ? (page - 1) * size + 1 : 0, to = Math.min(total, page * size);
  const btn = (active) => ({ minWidth: 32, height: 32, borderRadius: 8, fontSize: 13, border: `1px solid ${active ? C.ink : C.line}`, background: active ? C.ink : "#fff", color: active ? "#fff" : C.ink });
  return (
    <nav aria-label="Pages" className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 mt-2" style={{ borderTop: `1px solid ${C.line}` }}>
      <div className="text-xs" style={{ color: C.ink2 }}>Showing {from}–{to} of {total}</div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} className="px-2.5 text-xs disabled:opacity-40" style={btn(false)} aria-label="Previous page">‹ Prev</button>
        {pageList(page, pages).map((n) => typeof n === "string"
          ? <span key={n} className="px-1 text-xs" style={{ color: C.ink3 }}>…</span>
          : <button type="button" key={n} onClick={() => onPage(n)} aria-current={n === page ? "page" : undefined} style={btn(n === page)}>{n}</button>)}
        <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages} className="px-2.5 text-xs disabled:opacity-40" style={btn(false)} aria-label="Next page">Next ›</button>
        <select value={size} onChange={(e) => onSize(Number(e.target.value))} aria-label="Rows per page" className="text-xs rounded-lg border px-2 ml-1" style={{ borderColor: C.line, height: 32, background: "#fff" }}>
          {[10, 25, 50].map((n) => <option key={n} value={n}>{n} per page</option>)}
        </select>
      </div>
    </nav>
  );
}

function DataTable({ columns, rows: allRows, onRowClick, keyField = "id", empty = "Nothing here yet.", pageSize = 10 }) {
  const desktop = useDesktop();
  const primary = columns[0];
  const rest = columns.slice(1);
  const [size, setSize] = useState(pageSize);
  const [page, setPage] = useState(1);
  // A filter or search that changes the list starts again from page 1.
  useEffect(() => { setPage(1); }, [allRows.length]);
  const pages = Math.max(1, Math.ceil(allRows.length / size));
  const cur = Math.min(page, pages);
  const rows = allRows.slice((cur - 1) * size, cur * size);
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
      {allRows.length === 0 && <div className="text-sm text-center py-6" style={{ color: C.ink3 }}>{empty}</div>}
      {allRows.length > 10 && <Pager page={cur} pages={pages} size={size} total={allRows.length} onPage={(n) => setPage(Math.max(1, Math.min(pages, n)))} onSize={(n) => { setSize(n); setPage(1); }} />}
    </div>
  );
}

/* Nav config */
const NAV_RECOPS = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "candidates", label: "Candidates", icon: Users },
  { key: "inbox", label: "Inbox", icon: InboxIcon },
  { key: "messages", label: "Messages", icon: MessageSquare },
  { key: "jobs", label: "Jobs", icon: Briefcase },
  { key: "interviews", label: "Interviews", icon: Calendar },
  { key: "campaigns", label: "Outreach", icon: Send },
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
  { key: "messages", label: "Messages", icon: MessageSquare },
  { key: "jobs", label: "Jobs", icon: Briefcase },
  { key: "interviews", label: "Interviews", icon: Calendar },
  { key: "campaigns", label: "Outreach", icon: Send },
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
    S.mfaEnroll().then((j) => setEnroll({ factorId: j.id, qr: j.totp && j.totp.qr_code, secret: j.totp && j.totp.secret })).catch((e) => S.error(e.message)).finally(() => setMfaBusy(false));
  };
  const confirmEnroll = () => {
    if (!code.trim()) { toast("Enter the 6-digit code"); return; }
    setMfaBusy(true);
    S.mfaChallenge(enroll.factorId)
      .then((ch) => S.mfaVerify(enroll.factorId, ch.id, code.trim()))
      .then(() => { toast("Two-factor authentication turned on"); setEnroll(null); setCode(""); return S.mfaListFactors().then(setFactors); })
      .catch((e) => S.error(e.message))
      .finally(() => setMfaBusy(false));
  };
  const removeFactor = (id) => {
    setMfaBusy(true);
    S.mfaUnenroll(id).then(() => { toast("Two-factor authentication turned off"); return S.mfaListFactors().then(setFactors); }).catch((e) => S.error(e.message)).finally(() => setMfaBusy(false));
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

function MyProfilePage({ S, toast, onBack, initialTab }) {
  const [tab, setTab] = useState(["account", "notifications", "security", "calendar"].includes(initialTab) ? initialTab : "account");
  return (
    <div className="flex flex-col gap-5 md:gap-6 max-w-2xl">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Back</button>
      <SectionTitle size="text-3xl md:text-4xl" title="My profile" sub="Your account details, visible to the rest of the team." />
      <Tabs tabs={[{ key: "account", label: "Account" }, { key: "notifications", label: "Notifications" }, { key: "security", label: "Security" }, { key: "calendar", label: "Calendar" }]} active={tab} setActive={setTab} />
      {tab === "account" && <AccountTab S={S} toast={toast} />}
      {tab === "notifications" && <NotificationsTab S={S} toast={toast} />}
      {tab === "security" && <SecurityTab S={S} toast={toast} />}
      {tab === "calendar" && <GoogleCalendarTab S={S} toast={toast} />}
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
        {collapsed ? <BrandMark size={32} /> : <div className="flex-1 min-w-0"><BrandLogo height={24} chip /></div>}
        <button onClick={() => setCollapsed((c) => !c)} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(255,255,255,0.08)" }}>
          {collapsed ? <ChevronRight size={16} color="#A9BBB1" /> : <ChevronLeft size={16} color="#A9BBB1" />}
        </button>
      </div>
      {!collapsed && <div className="px-4 pb-1.5 text-xs font-semibold tracking-widest" style={{ color: "#6F8A7D" }}>WORKSPACE</div>}
      {/* The menu scrolls on short screens so the sign-out and profile below always stay in view. */}
      <div className="px-3 flex-1 min-h-0 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>{collapsed ? <NavList items={items.map((i) => ({ ...i, label: "" }))} page={page} setPage={setPage} dark /> : <NavList items={[...items, ...extra]} page={page} setPage={setPage} dark />}</div>
      {!collapsed && (
        <div className="px-3 pb-3 pt-3 shrink-0">
          <div className="rounded-xl p-3.5 mb-3" style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)" }}>
            <div className="flex items-center gap-2 mb-1"><Sparkles size={15} color={C.lime} /><span className="text-xs font-medium text-white">AI needs your approval</span></div>
            <div className="text-xs" style={{ color: "#A9BBB1" }}>{pendingQ} sets of screening questions are waiting for approval.</div>
          </div>
          <button onClick={onSignOut} className="w-full text-left text-xs rounded-lg px-2 py-2" style={{ color: "#A9BBB1", border: "1px solid rgba(255,255,255,0.12)" }}>Sign out</button>
        </div>
      )}
      <button onClick={() => setPage("myProfile")} className="px-4 pb-5 pt-2 flex items-center gap-2.5 text-left w-full shrink-0" style={{ background: page === "myProfile" ? "rgba(255,255,255,0.07)" : "transparent" }} title="My profile">
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
      <div className="shrink-0" style={{ display: desktop ? "none" : "block" }}><BrandMark size={32} /></div>
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
          const matches = S.cands.map((c) => ({ c, n: realMatches(c, S).length })).filter((x) => x.n > 0).map(({ c, n }) => ({ id: c.id, name: c.name, sub: plural(n, "role") }));
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
  const [rereading, setRereading] = useState(null); // "3/18" while re-reading resumes
  // Rec Ops/Admin: full AI refresh of everyone with a resume, one candidate and one step at a
  // time: profile details, employer industries (if not looked up yet), parallel titles, then a
  // rescreen of their company cards (skipped for locked, manually reviewed candidates).
  const rereadAll = async () => {
    const list = data.filter((c) => c.cv);
    if (!list.length) { toast("No resumes on file"); return; }
    let done = 0, failed = 0;
    for (const c of list) {
      setRereading((done + failed + 1) + "/" + list.length);
      let ok = true;
      for (const step of ["profile", "industries", "titles", "screen"]) {
        try { const r = await S.aiScreen("refresh_candidate", { candidateId: c.id, step }); if (r && r.ok === false) ok = false; } catch (e) { ok = false; }
      }
      if (ok) done++; else failed++;
    }
    setRereading(null);
    toast("Refreshed " + plural(done, "candidate") + (failed ? ". " + failed + " had a step that didn't finish; run it again for them." : "."));
  };
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
  const tabs = ["All", "In review", "With client", "Interview", "Offer", "Active file", "Hired", "Placed"].map((t) => ({ key: t, label: t === "All" ? `All ${data.length}` : `${t} ${data.filter((c) => c.status === t).length}` }));
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
            { key: "ai", label: "AI", render: (c) => <Pill tone={scoreTone(c.ai)}>{c.ai ? c.ai + "%" : "-"}</Pill> },
            { key: "email", label: "EMAIL", render: (c) => <Pill tone={c.email === "Verified" ? "em" : "warn"}>{c.email}</Pill> },
            { key: "activity", label: "ACTIVITY", render: (c) => <span className="text-xs" style={{ color: C.ink2 }}>{c.activity}</span> },
          ]}
        />
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Chat, shared by the candidate page and the dashboard                     */
/* ---------------------------------------------------------------------- */
/* One conversation per candidate_jobs row. Each side loads it through its own RPC
   (candidate_chat with the portal token, staff_chat when signed in), which also marks the
   other side's messages delivered and, while the chat is on screen, read.
   Ticks on your own messages:
     recruiter messages (also emailed to the candidate, see send-message / email-status)
       clock      sending, or the email's delivery isn't confirmed yet
       two ticks  the email reached the candidate's inbox; lime once they've read it on their page
       one tick   the email bounced or was rejected (red), or wasn't sent (no address / unsubscribed)
     candidate messages (in-app only)
       one tick = sent, two ticks = it reached the recruiter's dashboard, lime = read
   "typing…" travels over a Supabase Realtime broadcast on chat-<linkId> (instant) and a
   chat_typing heartbeat the 3-second poll reads (works even if the socket can't connect).
   Files and pictures go through the chat-file function into the private chat-files bucket. */

// Minimal Supabase Realtime (Phoenix) client: broadcast only, reconnects on its own.
function rtChannel(topic, onEvent) {
  let ws = null, ref = 0, hb = null, retry = null, closed = false;
  const t = "realtime:" + topic;
  const url = SB_URL.replace(/^http/, "ws") + "/realtime/v1/websocket?apikey=" + SB_KEY + "&vsn=1.0.0";
  const push = (event, payload, tpc) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ topic: tpc || t, event, payload, ref: String(++ref) })); } catch (e) { /* socket gone */ } };
  const connect = () => {
    if (closed || typeof WebSocket === "undefined") return;
    try { ws = new WebSocket(url); } catch (e) { return; }
    ws.onopen = () => {
      push("phx_join", { config: { broadcast: { self: false, ack: false }, presence: { key: "" }, postgres_changes: [], private: false }, access_token: SB_KEY });
      hb = setInterval(() => push("heartbeat", {}, "phoenix"), 25000);
    };
    ws.onmessage = (e) => {
      try { const m = JSON.parse(e.data); if (m.topic === t && m.event === "broadcast" && m.payload) onEvent(m.payload.event, m.payload.payload || {}); } catch (err) { /* not ours */ }
    };
    ws.onclose = () => { clearInterval(hb); if (!closed) retry = setTimeout(connect, 5000); };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* already closed */ } };
  };
  connect();
  return {
    send: (event, payload) => push("broadcast", { type: "broadcast", event, payload: payload || {} }),
    close: () => { closed = true; clearInterval(hb); clearTimeout(retry); try { if (ws) ws.close(); } catch (e) { /* already closed */ } },
  };
}

const chatTime = (d) => new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const chatDay = (d) => {
  const x = new Date(d), today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(x); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return x.toLocaleDateString("en-GB", { weekday: "long" });
  return x.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: x.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};
const fileSize = (n) => (!n ? "" : n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB");
const isImage = (type) => /^image\/(jpeg|png|webp|gif)$/.test(type || "");
const filePreview = (m) => (m && (m.body || (m.file ? "📎 " + (m.file.name || "File") : ""))) || "";

// Brand look: deep green for your own messages, white cards for theirs, on the canvas colour.
const CHAT = { mine: C.side, mineMeta: "rgba(255,255,255,0.62)", theirs: "#FFFFFF", wall: C.canvas, read: C.lime, bad: "#FF9B85" };

// What the ticks on one of your own messages mean (icon + plain-English label for the tooltip).
function tickState(m) {
  if (m.failed) return { icon: "fail", label: "Not sent" };
  if (m.pending) return { icon: "clock", label: "Sending" };
  if (m.sender === "recruiter") {
    if (m.emailStatus === "bounced") return { icon: "one", bad: true, label: "Email bounced" + (m.emailError ? ": " + m.emailError : "") };
    if (m.emailStatus === "not_sent") return { icon: "one", bad: true, label: "Not emailed" + (m.emailError ? ": " + m.emailError : "") };
    if (m.readAt) return { icon: "two", read: true, label: "Read on their candidate page" };
    if (m.emailStatus === "sent") return { icon: "clock", label: "Emailed, waiting for delivery" };
    if (m.emailStatus === "delivered") return { icon: "two", label: "Delivered to their email" };
    return { icon: "none", label: "Sent before email tracking started" };
  }
  if (m.readAt) return { icon: "two", read: true, label: "Read" };
  if (m.deliveredAt) return { icon: "two", label: "Delivered" };
  return { icon: "one", label: "Sent" };
}
function MsgTicks({ m }) {
  const s = tickState(m);
  const color = s.bad ? CHAT.bad : s.read ? CHAT.read : CHAT.mineMeta;
  if (s.icon === "none") return null;
  return (
    <span title={s.label} aria-label={s.label} className="inline-flex">
      {s.icon === "fail" ? <AlertTriangle size={13} color={CHAT.bad} />
        : s.icon === "clock" ? <Clock size={12} color={color} />
        : s.icon === "two" ? <CheckCheck size={15} color={color} />
        : <Check size={15} color={color} />}
    </span>
  );
}

// Same ticks on a light background (conversation lists).
function ListTicks({ m }) {
  const s = tickState({ ...m, readAt: m.readAt || m.candidateReadAt });
  const color = s.bad ? C.dangerFg : s.read ? C.em : C.ink3;
  if (s.icon === "none") return null;
  return <span title={s.label} className="inline-flex shrink-0">{s.icon === "two" ? <CheckCheck size={13} color={color} /> : s.icon === "clock" ? <Clock size={11} color={color} /> : <Check size={13} color={color} />}</span>;
}

function ChatAttachment({ file, url, mine, onLoad }) {
  if (isImage(file.type)) {
    return url
      ? <a href={url} target="_blank" rel="noreferrer" className="block -mx-1 -mt-0.5 mb-1"><img src={url} alt={file.name} onLoad={onLoad} className="rounded-xl block max-h-72 w-auto max-w-full object-cover" /></a>
      : <div className="-mx-1 -mt-0.5 mb-1 rounded-xl flex items-center justify-center" style={{ width: 220, height: 160, background: mine ? "rgba(255,255,255,0.08)" : C.canvas }}><InlineDots color={mine ? "#fff" : C.ink3} /></div>;
  }
  const ext = (String(file.name || "").split(".").pop() || "file").slice(0, 4).toUpperCase();
  const inner = (
    <div className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 mb-1" style={{ background: mine ? "rgba(255,255,255,0.1)" : C.canvas, minWidth: 200 }}>
      <span className="w-9 h-10 rounded-md flex items-center justify-center text-[10px] font-bold shrink-0" style={{ background: mine ? C.lime : C.emTint, color: mine ? C.side : C.em }}>{ext}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium truncate">{file.name}</span>
        <span className="block text-[11px]" style={{ opacity: 0.7 }}>{fileSize(file.size)}{url ? " · Open" : ""}</span>
      </span>
      <Download size={16} style={{ opacity: url ? 0.8 : 0.3 }} />
    </div>
  );
  return url ? <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{inner}</a> : inner;
}

// Reads a picked file for upload. Large photos are shrunk to 1600px so they send quickly.
const FILE_TYPES = { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
const MAX_CHAT_FILE = 8 * 1024 * 1024;
const readChatFile = (file) => new Promise((resolve, reject) => {
  const type = file.type || FILE_TYPES[(file.name.split(".").pop() || "").toLowerCase()] || "";
  if (!Object.values(FILE_TYPES).includes(type)) { reject(new Error("That kind of file can't be sent. Try a picture, PDF, Word, Excel, PowerPoint or text file.")); return; }
  const shrink = /^image\/(jpeg|png|webp)$/.test(type) && file.size > 1.5 * 1024 * 1024;
  if (!shrink && file.size > MAX_CHAT_FILE) { reject(new Error("Files can be up to 8 MB.")); return; }
  if (shrink) {
    const img = new Image(), u = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.width, img.height));
      const cv = document.createElement("canvas"); cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(u);
      resolve({ name: file.name.replace(/\.[^.]+$/, "") + ".jpg", type: "image/jpeg", data: cv.toDataURL("image/jpeg", 0.85).split(",")[1], size: Math.round(file.size) });
    };
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error("That picture couldn't be opened.")); };
    img.src = u;
    return;
  }
  const r = new FileReader();
  r.onload = () => resolve({ name: file.name, type, data: String(r.result).split(",")[1], size: file.size });
  r.onerror = () => reject(new Error("That file couldn't be read."));
  r.readAsDataURL(file);
});

/* props:
   linkId, mine ("candidate" | "recruiter"),
   api: { load(read) -> payload, send(text), sendFile(file, caption), urls(ids) -> { id: url }, typing() }
   title, subtitle, avatarSrc, avatarInit, onBack (shows the back arrow), onProfile (makes the
   header open the person's profile), onClose (called on unmount so the parent can refresh
   unread counts), headerExtra (node under the header), emptyText, peerName */
function ChatRoom({ linkId, mine, api, title, subtitle, avatarSrc, avatarInit, onBack, onProfile, onClose, headerExtra, emptyText, peerName, className = "", style }) {
  const [msgs, setMsgs] = useState(null);
  const [pending, setPending] = useState([]);
  const [peerTypingAt, setPeerTypingAt] = useState(0);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(null); // { name, type, data, size } waiting to be sent
  const [urls, setUrls] = useState({});
  const [, setTick] = useState(0);
  const apiRef = React.useRef(api); apiRef.current = api;
  const closeRef = React.useRef(onClose); closeRef.current = onClose;
  const scrollRef = React.useRef(null);
  const atBottom = React.useRef(true);
  const rt = React.useRef(null);
  const lastTypingSent = React.useRef(0);
  const lastSeenPeer = React.useRef("");
  const asked = React.useRef(new Set());
  const inputRef = React.useRef(null);
  const fileRef = React.useRef(null);

  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  const load = React.useCallback(async () => {
    try {
      const p = await apiRef.current.load(visible());
      if (!p) return;
      const list = Array.isArray(p.messages) ? p.messages : [];
      setMsgs(list);
      if (p.peerTypingAt) setPeerTypingAt((t) => Math.max(t, new Date(p.peerTypingAt).getTime()));
      setErr("");
      // Newest message from the other side, now read by us: tell them straight away.
      const lastPeer = list.filter((m) => m.sender !== mine).slice(-1)[0];
      if (lastPeer && visible() && lastPeer.id !== lastSeenPeer.current) {
        lastSeenPeer.current = lastPeer.id;
        if (rt.current) rt.current.send("seen", { who: mine });
      }
      // Short-lived links for any files we haven't fetched yet.
      const need = list.filter((m) => m.file && !asked.current.has(m.id)).map((m) => m.id);
      if (need.length && apiRef.current.urls) {
        need.forEach((id) => asked.current.add(id));
        apiRef.current.urls(need).then((u) => setUrls((x) => ({ ...x, ...(u || {}) }))).catch(() => need.forEach((id) => asked.current.delete(id)));
      }
    } catch (e) { setErr(e.message || "Couldn't load messages"); }
  }, [linkId, mine]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setMsgs(null); setPending([]); setPeerTypingAt(0); setUrls({}); setAttach(null);
    lastSeenPeer.current = ""; asked.current = new Set(); atBottom.current = true;
    load();
    const poll = setInterval(() => { if (visible()) load(); }, 3000);
    const tick = setInterval(() => setTick((n) => n + 1), 1000);
    const onVis = () => { if (visible()) load(); };
    document.addEventListener("visibilitychange", onVis);
    rt.current = rtChannel("chat-" + linkId, (event, payload) => {
      if (payload && payload.who === mine) return;
      if (event === "typing") setPeerTypingAt(Date.now());
      else if (event === "msg") { setPeerTypingAt(0); load(); }
      else if (event === "seen") load();
    });
    return () => {
      clearInterval(poll); clearInterval(tick); document.removeEventListener("visibilitychange", onVis);
      if (rt.current) rt.current.close();
      rt.current = null;
      if (closeRef.current) closeRef.current();
    };
  }, [linkId]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = [...(msgs || []), ...pending];
  const lastPeerAt = (msgs || []).filter((m) => m.sender !== mine).reduce((a, m) => Math.max(a, new Date(m.createdAt).getTime()), 0);
  const peerTyping = peerTypingAt > 0 && Date.now() - peerTypingAt < 6000 && peerTypingAt > lastPeerAt;

  // Stay on the newest message unless they've scrolled up to read older ones.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [all.length, peerTyping, msgs === null, Object.keys(urls).length]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = () => { const el = scrollRef.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
  // A picture finishing loading makes the list taller: keep the newest message in view.
  const stick = () => { const el = scrollRef.current; if (el && atBottom.current) el.scrollTop = el.scrollHeight; };

  const onType = (v) => {
    setText(v);
    const now = Date.now();
    if (v.trim() && now - lastTypingSent.current > 2500) {
      lastTypingSent.current = now;
      if (rt.current) rt.current.send("typing", { who: mine });
      Promise.resolve(apiRef.current.typing && apiRef.current.typing()).catch(() => {});
    }
  };
  const pickFile = async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    try { setAttach(await readChatFile(f)); setErr(""); } catch (x) { setErr(x.message); }
    if (inputRef.current) inputRef.current.focus();
  };
  // Sends the typed text and/or the picked file; a failed send stays in the list with a retry.
  const send = async (retry) => {
    const item = retry || { id: "tmp" + Date.now() + Math.random().toString(36).slice(2, 6), sender: mine, body: text.trim(), file: attach, createdAt: new Date().toISOString() };
    if (!item.body && !item.file) return;
    setPending((p) => (retry ? p.map((m) => (m.id === item.id ? { ...m, failed: false, pending: true } : m)) : [...p, { ...item, pending: true }]));
    if (!retry) { setText(""); setAttach(null); if (inputRef.current) inputRef.current.style.height = "auto"; }
    atBottom.current = true;
    lastTypingSent.current = 0;
    try {
      if (item.file) await apiRef.current.sendFile(item.file, item.body);
      else await apiRef.current.send(item.body);
      await load();
      setPending((p) => p.filter((m) => m.id !== item.id));
      if (rt.current) rt.current.send("msg", { who: mine });
    } catch (e) {
      setPending((p) => p.map((m) => (m.id === item.id ? { ...m, pending: false, failed: true, error: e.message } : m)));
    }
    if (inputRef.current) inputRef.current.focus();
  };

  const canSend = !!(text.trim() || attach);
  const headerMain = (
    <>
      <Avatar init={avatarInit || "?"} tone="em" size={40} src={avatarSrc || undefined} />
      <div className="min-w-0 flex-1 text-left">
        <div className="text-[17px] leading-tight truncate" style={{ ...SERIF, color: C.ink }}>{title}</div>
        <div className="text-xs truncate mt-0.5" style={{ color: peerTyping ? C.em : C.ink2, fontWeight: peerTyping ? 600 : 400 }}>
          {peerTyping ? "typing…" : subtitle}
        </div>
      </div>
      {onProfile && <span className="hidden sm:inline-flex items-center gap-1 text-xs font-medium shrink-0 rounded-full px-2.5 py-1" style={{ background: C.emTint, color: C.em }}>View profile <ChevronRight size={13} /></span>}
    </>
  );
  let lastDay = "";
  return (
    <div className={"flex flex-col min-h-0 " + className}
      style={{ background: CHAT.wall, backgroundImage: "radial-gradient(rgba(20,32,27,0.05) 1px, transparent 1px)", backgroundSize: "18px 18px", ...(style || {}) }}>
      <div className="flex items-center gap-2 px-3 py-2.5 shrink-0" style={{ background: "#fff", borderBottom: `1px solid ${C.line}` }}>
        {onBack && <button onClick={onBack} aria-label="Back" className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center shrink-0" style={{ color: C.ink }}><ArrowLeft size={20} /></button>}
        {onProfile
          ? <button onClick={onProfile} title="Open full profile" className="flex items-center gap-3 min-w-0 flex-1 rounded-xl -my-1 py-1 pr-1">{headerMain}</button>
          : <div className="flex items-center gap-3 min-w-0 flex-1">{headerMain}</div>}
      </div>
      {headerExtra}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-3 md:px-6 py-4 flex flex-col gap-1">
        {msgs === null && !err && <div className="m-auto"><InlineDots color={C.ink3} /></div>}
        {err && msgs === null && <div className="m-auto text-sm text-center px-6" style={{ color: C.dangerFg }}>{err}</div>}
        {msgs !== null && all.length === 0 && (
          <div className="m-auto text-sm text-center rounded-2xl px-4 py-3 max-w-xs" style={{ background: "#fff", color: C.ink2, border: `1px dashed ${C.line}` }}>{emptyText || "No messages yet. Say hello!"}</div>
        )}
        {all.map((m, i) => {
          const day = chatDay(m.createdAt);
          const showDay = day !== lastDay; lastDay = day;
          const isMine = m.sender === mine;
          const next = all[i + 1];
          const lastOfGroup = !next || next.sender !== m.sender || chatDay(next.createdAt) !== day;
          const st = isMine ? tickState(m) : null;
          return (
            <React.Fragment key={m.id || i}>
              {showDay && (
                <div className="flex items-center gap-3 my-3 text-[11px] font-medium uppercase tracking-wider" style={{ color: C.ink3 }}>
                  <span className="flex-1 h-px" style={{ background: C.line }} />{day}<span className="flex-1 h-px" style={{ background: C.line }} />
                </div>
              )}
              <div className={"flex flex-col " + (lastOfGroup ? "mb-2" : "")} style={{ alignItems: isMine ? "flex-end" : "flex-start" }}>
                <div className="max-w-[82%] md:max-w-[62%] px-3.5 pt-2 pb-1.5 text-[14.5px] leading-snug"
                  style={{ background: isMine ? CHAT.mine : CHAT.theirs, color: isMine ? "#fff" : C.ink, borderRadius: 18,
                    border: isMine ? "none" : `1px solid ${C.line}`, boxShadow: "0 1px 2px rgba(20,32,27,0.06)",
                    ...(lastOfGroup ? (isMine ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }) : {}) }}>
                  {m.file && <ChatAttachment file={m.file} url={urls[m.id]} mine={isMine} onLoad={stick} />}
                  {m.body && <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>}
                  <div className="flex items-center justify-end gap-1 mt-0.5 text-[10.5px]" style={{ color: isMine ? CHAT.mineMeta : C.ink3 }}>
                    {chatTime(m.createdAt)}{isMine && <MsgTicks m={m} />}
                  </div>
                </div>
                {isMine && st && st.bad && lastOfGroup && <div className="text-[11px] mt-1 mr-1" style={{ color: C.dangerFg }}>{st.label}</div>}
                {m.failed && <button onClick={() => send(m)} className="text-[11px] font-medium mt-1 mr-1" style={{ color: C.dangerFg }}>Not sent. Tap to try again</button>}
              </div>
            </React.Fragment>
          );
        })}
        {peerTyping && (
          <div className="flex items-center gap-2 text-xs mt-1" style={{ color: C.ink3 }}>
            <span className="rounded-full px-3 py-2 inline-flex" style={{ background: "#fff", border: `1px solid ${C.line}` }}><InlineDots color={C.em} /></span>
            {(peerName || title || "They").split(" ")[0]} is typing
          </div>
        )}
      </div>
      {err && msgs !== null && <div className="text-xs px-4 py-1.5 shrink-0" style={{ background: C.dangerBg, color: C.dangerFg }}>{err}</div>}
      <div className="px-3 pt-2 pb-3 shrink-0" style={{ background: "#fff", borderTop: `1px solid ${C.line}` }}>
        {attach && (
          <div className="flex items-center gap-2 rounded-xl px-3 py-2 mb-2 text-sm" style={{ background: C.canvas }}>
            <Paperclip size={15} color={C.em} />
            <span className="truncate flex-1">{attach.name}</span>
            <span className="text-xs shrink-0" style={{ color: C.ink3 }}>{fileSize(attach.size)}</span>
            <button onClick={() => setAttach(null)} aria-label="Remove file" className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ color: C.ink2 }}><X size={14} /></button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <button onClick={() => fileRef.current && fileRef.current.click()} aria-label="Attach a file or picture" title="Attach a file or picture"
            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: C.canvas, color: C.ink2 }}><Paperclip size={18} /></button>
          <input ref={fileRef} type="file" className="hidden" onChange={pickFile}
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv" />
          <textarea ref={inputRef} value={text} rows={1} onChange={(e) => onType(e.target.value)} placeholder={attach ? "Add a caption (optional)" : "Write a message"}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            onInput={(e) => { const el = e.target; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 120) + "px"; }}
            className="flex-1 resize-none rounded-2xl border px-4 py-2.5 text-[15px] outline-none" style={{ borderColor: C.line, background: "#FAF8F3", color: C.ink, maxHeight: 120 }} />
          <button onClick={() => send()} disabled={!canSend} aria-label="Send"
            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: canSend ? C.em : C.line, color: "#fff" }}>
            <SendHorizontal size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Data access for each side of a conversation.
const chatFileCall = async (body) => {
  const r = await fetch(SB_URL + "/functions/v1/chat-file", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Couldn't send the file. Please try again.");
  return j;
};
const candidateChatApi = (token, linkId) => ({
  load: (read) => sbFetch("/rest/v1/rpc/candidate_chat", { method: "POST", body: { p_token: token, p_link_id: linkId, p_read: !!read } }),
  send: (text) => sbFetch("/rest/v1/rpc/candidate_send_message", { method: "POST", body: { p_token: token, p_link_id: linkId, p_body: text } }),
  sendFile: (file, caption) => chatFileCall({ action: "send", token, linkId, name: file.name, type: file.type, data: file.data, caption }),
  urls: (ids) => chatFileCall({ action: "urls", token, linkId, ids }).then((j) => j.urls || {}),
  typing: () => sbFetch("/rest/v1/rpc/candidate_typing", { method: "POST", body: { p_token: token, p_link_id: linkId } }),
});
const staffChatApi = (S, linkId) => ({
  load: (read) => S.sb("/rest/v1/rpc/staff_chat", { method: "POST", body: { p_link_id: linkId, p_read: !!read } }),
  send: (text) => S.sendMessageQuiet(linkId, text),
  // Upload first, then post through send-message so the candidate is emailed too.
  sendFile: async (file, caption) => {
    const up = await S.sb("/functions/v1/chat-file", { method: "POST", body: { action: "upload", linkId, name: file.name, type: file.type, data: file.data }, timeout: 60000 });
    return S.sendMessageQuiet(linkId, caption, up.file);
  },
  urls: (ids) => S.sb("/functions/v1/chat-file", { method: "POST", body: { action: "urls", linkId, ids } }).then((j) => j.urls || {}),
  typing: () => S.sb("/rest/v1/rpc/staff_typing", { method: "POST", body: { p_link_id: linkId } }),
});

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
  // Which job the "Message" modal is talking about (a candidate can have more than one live
  // link); defaults to the most recently created one that isn't declined.
  const liveLinks = candidate.jobLinks.filter((l) => l.response !== "declined").sort((a, b) => b.createdAt - a.createdAt);
  const [msgLinkId, setMsgLinkId] = useState(null);
  const msgLink = candidate.jobLinks.find((l) => l.id === (msgLinkId || (liveLinks[0] && liveLinks[0].id))) || null;
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
  // Best open role they've actually been reviewed as fitting (not just the first open job).
  const sugMatch = realMatches(candidate, S).slice().sort((a, b) => (b.fit || 0) - (a.fit || 0))[0] || null;
  const sug = sugMatch ? S.jobs.find((j) => j.id === sugMatch.job_id) || null : null;
  // Rerouting and forwarding to another role both go through the fit review and Route.
  const [routeJob, setRouteJob] = useState(null);
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
    } catch (e) { S.error("Resume saved, but the AI couldn't read it: " + e.message); }
    setAiBusy(false);
  };
  const [readBusy, setReadBusy] = useState(false);
  const readProfile = async () => {
    setReadBusy(true);
    try {
      const r = await S.aiScreen("read_profile", { candidateId: candidate.id });
      toast(r && r.skillsLocked ? "Details re-read from the resume. Skills kept, because the review is locked." : "Details re-read from the resume");
    } catch (e) { S.error(e.message); }
    setReadBusy(false);
  };
  const removeResume = async () => {
    setResumeDelBusy(true);
    try { await S.aiScreen("remove_resume", { candidateId: candidate.id }); setResumeDel(false); toast("Resume removed"); }
    catch (e) { S.error(e.message); }
    setResumeDelBusy(false);
  };
  const [unlockBusy, setUnlockBusy] = useState(false);
  const unlockReview = async () => {
    setUnlockBusy(true);
    try { await patch(() => ({ ai_locked: false })); toast("Review unlocked. AI can re-screen this candidate again."); }
    catch (e) { S.error(e.message); }
    setUnlockBusy(false);
  };
  const [editForm, setEditForm] = useState(null);
  const openEdit = () => setEditForm({ linkedin: candidate.linkedin || "", name: candidate.name, role: candidate.role, location: candidate.location, emailAddr: candidate.emailAddr, phone: candidate.phone, experience: candidate.experience, notice: candidate.notice, pay: candidate.pay });
  const saveEdit = () => {
    if (!editForm.name.trim()) { toast("Name can't be empty"); return; }
    const li = (editForm.linkedin || "").trim();
    patch(() => ({ ...editForm, linkedin: li && !/^https?:\/\//i.test(li) ? "https://" + li : li }));
    setEditForm(null); toast("Candidate details updated");
  };

  // Rejected by the client (they were already forwarded) is tracked separately from an
  // ordinary reject (never made it that far) in the timeline/history, but both outcomes send
  // the candidate straight back to Active file rather than a dead-end "Rejected" status --
  // they stay searchable for other roles instead of falling out of the pipeline.
  // Rejecting records a reason and tells the candidate why (see RejectModal); then suggest
  // their best other open role.
  const [rejectKind, setRejectKind] = useState(null);
  const reject = (clientReject) => setRejectKind(clientReject ? "client" : "internal");
  const afterReject = () => { setReassign("searching"); setTimeout(() => setReassign("found"), 1200); };
  // Status follows the candidate's roles: every action here changes a role's stage, and their
  // overall status (In review, With client, Interview, Offer, Placed, Active file) follows from
  // that in the database. Only someone with no live role has their status set directly.
  const activeRoles = candidate.jobLinks.filter(isLiveLink).map((l) => ({ link: l, job: S.jobs.find((j) => j.id === l.jobId) })).filter((x) => x.job);
  const [holdPick, setHoldPick] = useState(false);
  const holdOn = (x) => S.setStage(x.link.id, "In review").then(() => { setHoldPick(false); toast("Back to In review for " + x.job.role); }).catch(() => {});
  const doStatus = (opt) => {
    setMenuOpen(false);
    if (opt === "Not a fit for this role") {
      if (activeRoles.length) { reject(false); return; }
      setStatus("Active file"); setReassign("searching"); toast("Moved to Active file");
      setTimeout(() => setReassign("found"), 1200);
    } else if (opt === "Approve, forward to client") { setFwd(activeRoles.length === 1 ? activeRoles[0].job.id : ""); setPanel("fwd"); }
    else if (opt === "Reject") { reject(false); }
    else if (opt === "Client reject") { reject(true); }
    else if (opt === "Mark placed") { openPlaced(); }
    // A recruiter's only status action: flags the candidate for Rec Ops/Admin to confirm.
    // Doesn't create a placement or billing entry — that still only happens via Mark placed.
    else if (opt === "Hired") { setStatus("Hired"); toast("Marked Hired — Rec Ops or an Admin will confirm the placement"); }
    else if (activeRoles.length === 0) { setStatus("In review"); toast("Status set to In review"); }
    else if (activeRoles.length === 1) holdOn(activeRoles[0]);
    else setHoldPick(true);
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
    } catch (e) { S.error(e.message || "Could not record the placement"); }
  };
  const postComment = () => {
    if (!draft.trim()) { setErr("Write a note before posting."); return; }
    patch((c) => ({ comments: [{ who: S.me.first, role: S.me.label, init: S.me.init, tone: "info", when: "Just now", text: draft }, ...c.comments] }));
    setDraft(""); setErr("");
  };

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Candidates</button>
      <Modal open={panel === "msg" && liveLinks.length === 0} onClose={() => setPanel(null)} title={"Message " + candidate.name.split(" ")[0]}>
        <div className="text-sm" style={{ color: C.ink3 }}>Attach {candidate.name.split(" ")[0]} to a job first — messages are tied to a specific role.</div>
      </Modal>
      {panel === "msg" && msgLink && (
        <div className="fixed inset-0 z-50 flex justify-center" style={{ background: "rgba(20,32,27,0.45)" }} onClick={(e) => { if (e.target === e.currentTarget) setPanel(null); }}>
          <div className="w-full md:max-w-2xl flex flex-col" style={{ height: "100dvh" }}>
            <ChatRoom key={msgLink.id} linkId={msgLink.id} mine="recruiter" api={staffChatApi(S, msgLink.id)} className="flex-1"
              title={candidate.name} avatarSrc={candidate.photoUrl} avatarInit={initialsOf(candidate.name)}
              subtitle={(() => { const j = S.jobs.find((x) => x.id === msgLink.jobId); return j ? j.role + " · " + j.client : "Role"; })()}
              onBack={() => setPanel(null)} onClose={() => S.reload && S.reload()}
              onProfile={() => setPanel(null)} peerName={candidate.name}
              emptyText={"No messages yet. " + candidate.name.split(" ")[0] + " also gets an email for each message you send."}
              headerExtra={liveLinks.length > 1 ? (
                <div className="px-3 py-2 shrink-0" style={{ background: "#fff", borderBottom: `1px solid ${C.line}` }}>
                  <select value={msgLink.id} onChange={(e) => setMsgLinkId(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none" style={{ borderColor: C.line, background: "#fff" }}>
                    {liveLinks.map((l) => { const j = S.jobs.find((x) => x.id === l.jobId); return <option key={l.id} value={l.id}>{j ? j.role + " · " + j.client : "Role"}</option>; })}
                  </select>
                </div>
              ) : null} />
          </div>
        </div>
      )}
      <Modal open={!!editForm} onClose={() => setEditForm(null)} title="Edit candidate details">
        {editForm && (
          <div className="flex flex-col gap-3">
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Name</label><input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Role</label><input value={editForm.role} onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Location</label><input value={editForm.location} onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Email</label><input value={editForm.emailAddr} onChange={(e) => setEditForm((f) => ({ ...f, emailAddr: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Phone</label><input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>LinkedIn</label><input value={editForm.linkedin} placeholder="linkedin.com/in/…" onChange={(e) => setEditForm((f) => ({ ...f, linkedin: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
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
        {(() => {
          const fj = S.jobs.find((x) => x.id === fwd) || null;
          const fl = fj ? candidate.jobLinks.find((l) => l.jobId === fj.id) || null : null;
          const onIt = fl && fl.response === "accepted";
          return (
            <>
              <div className="text-sm mb-3" style={{ color: C.ink2 }}>Pick the role. A role they're already on is marked as sent to the client; any other role is reviewed against its job description, then routed to {candidate.name.split(" ")[0]} to accept.</div>
              <div className="flex flex-col gap-2 mb-4">
                {S.jobs.filter((j) => j.status !== "Closed" && (takesCandidates(j) || candidate.jobLinks.some((x) => x.jobId === j.id))).map((j) => { const l = candidate.jobLinks.find((x) => x.jobId === j.id); return (
                  <button key={j.id} onClick={() => setFwd(j.id)} className="rounded-xl border p-3 text-sm text-left flex items-center justify-between gap-2" style={{ borderColor: fwd === j.id ? C.em : C.line, background: fwd === j.id ? C.emTint : "#fff" }}>
                    <span>{j.role}, {j.client}</span>
                    {l && <span className="text-xs shrink-0" style={{ color: C.ink2 }}>{l.response === "pending" ? "routed, waiting" : l.response === "declined" ? "declined" : "on this role"}</span>}
                  </button>
                ); })}
              </div>
              <Btn kind="primary" full disabled={!fj || (fl && fl.response !== "accepted")} onClick={() => {
                if (!fj) { toast("Pick a role"); return; }
                if (onIt) {
                  S.setStage(fl.id, "Submitted").catch(() => {});
                  patch((c) => ({ timeline: [...c.timeline, { t: "Sent to " + fj.client + " for " + fj.role, d: todayStr(), done: true }] }));
                  setPanel(null); toast("Marked as sent to " + fj.client);
                } else { setPanel(null); setRouteJob(fj); }
              }}>{!fj ? "Pick a role" : onIt ? "Mark as sent to " + fj.client : fl ? "Already routed" : "Review fit and route"}</Btn>
            </>
          );
        })()}
      </Modal>
      {routeJob && <FitReviewModal open onClose={() => setRouteJob(null)} candidate={candidate} job={routeJob} S={S} toast={toast} />}
      <Modal open={holdPick} onClose={() => setHoldPick(false)} title="Which role goes back to review?">
        <div className="flex flex-col gap-2">
          {activeRoles.map((x) => (
            <button key={x.link.id} onClick={() => holdOn(x)} className="rounded-xl border p-3 text-sm text-left flex items-center justify-between gap-2" style={{ borderColor: C.line }}>
              <span>{x.job.role}, {x.job.client}</span><StatusPill status={x.link.stage} />
            </button>
          ))}
        </div>
      </Modal>
      {rejectKind && <RejectModal candidate={candidate} kind={rejectKind} S={S} toast={toast} onClose={() => setRejectKind(null)} onDone={afterReject} />}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <div className="md:col-span-2 flex flex-col gap-4">
          <Card>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-4">
              <Avatar init={candidate.name.split(" ").map((x) => x[0]).join("")} tone="em" size={64} src={candidate.photoUrl || undefined} />
              <div className="flex-1 min-w-0">
                <div className="text-2xl md:text-3xl" style={{ ...SERIF }}>{candidate.name}</div>
                {candidate.currentTitle
                  ? <div className="text-sm font-medium mt-0.5" style={{ color: C.ink }}>{candidate.currentTitle}{candidate.currentCompany ? " at " + candidate.currentCompany : ""}</div>
                  : null}
                <div className="text-sm font-medium mt-0.5" style={{ color: C.em }}>{candidate.currentTitle ? "Added for " : ""}{candidate.role || "Role not set"}</div>
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
                    {["Hold", "Approve, forward to client", "Not a fit for this role", "Mark placed", ["With client", "Interview", "Offer"].includes(status) ? "Client reject" : "Reject"].map((o) => (
                      <button key={o} onClick={() => doStatus(o)} className="w-full text-left px-3.5 py-2.5 text-sm" style={{ color: o === "Reject" || o === "Client reject" ? C.dangerFg : C.ink }}>{o}</button>
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
              <span title="Whether they agreed, on their candidate page, to be presented anonymously to other employers"><Pill tone={candidate.pitchConsent ? "em" : "neutral"}>{candidate.pitchConsent ? "Open to anonymous pitches" : candidate.pitchAnswered ? "Declined pitches" : "Not asked about pitches yet"}</Pill></span>
              {candidate.emailOptOut && <span title="They clicked unsubscribe in one of our emails. ProNext no longer emails them; contact them another way."><Pill tone="danger">Unsubscribed from emails</Pill></span>}
            </div>
            {reassign && (
              <div className="rounded-xl p-4 mb-4" style={{ background: C.emTint }}>
                {reassign === "searching" && <div className="text-sm flex items-center gap-2" style={{ color: C.em }}><Sparkles size={15} /> Comparing against other open roles&hellip;</div>}
                {(reassign === "found" || reassign === "submitted") && (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="text-sm" style={{ color: C.em }}><Sparkles size={15} className="inline mr-1" />{sug ? <>Best match: <b>{sug.role}, {sug.client}</b>{sugMatch && sugMatch.fit != null ? " (" + sugMatch.fit + "% fit)" : ""}</> : "No reviewed open role fits them right now. Use Forward to review them against a specific job."}</div>
                    {sug && <Btn kind="primary" onClick={() => setRouteJob(sug)}>Review and route</Btn>}
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-3 gap-4 mb-4">
              {[["Experience", candidate.experience], ["Notice", candidate.notice], ["Salary expectation", candidate.pay]].map(([l, v]) => (
                <div key={l} className="min-w-0"><div className="text-xs" style={{ color: C.ink3 }}>{l}</div><Clamp text={v || "-"} className="text-sm font-medium mt-0.5 break-words" /></div>
              ))}
            </div>
            <div className="mb-4">
              <div className="text-xs mb-1.5" style={{ color: C.ink3 }}>SKILLS</div>
              {candidate.skills.length > 0 ? <SkillPills skills={candidate.skills} /> : <div className="text-sm" style={{ color: C.ink3 }}>No skills on file yet.</div>}
            </div>
            <IndustryExperience candidate={candidate} S={S} toast={toast} />
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 pt-4 text-sm" style={{ borderTop: `1px solid ${C.line}` }}>
              <div className="flex items-center gap-2 min-w-0" style={{ color: C.ink2 }}><Mail size={15} className="shrink-0" /><span className="truncate">{candidate.emailAddr || "No email on file"}</span></div>
              <div className="flex items-center gap-2" style={{ color: C.ink2 }}><Phone size={15} className="shrink-0" />{candidate.phone || "No phone on file"}</div>
              {candidate.linkedin && <a href={candidate.linkedin} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-medium" style={{ color: C.em }}><span className="text-[10px] font-bold rounded px-1 leading-4" style={{ background: C.em, color: "#fff" }}>in</span>LinkedIn</a>}
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
          <CandidateInterviewsCard candidate={candidate} S={S} toast={toast} />
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
const VERDICT_TONE = { "Perfect fit": "em", "Good fit": "em", "Possible fit": "warn", "Possible reject": "danger", Reject: "danger" };
// Once a candidate is sent to the client, the card always reads Good fit — regardless of
// what the AI verdict actually was. Being put forward is a human decision that overrides
// the AI's own read; the raw ai.verdict is kept underneath for the "why" text, the gaps/
// strengths and follow-up-question logic, none of which this display override touches.
const SENT_STAGES = ["Submitted", "Interview", "Offer", "Placed"];
const shownVerdict = (verdict, sent) => (sent && verdict ? "Good fit" : verdict);
const FOLLOW_PILL = { draft: ["Waiting for approval", "warn"], sent: ["Sent · waiting for answers", "info"], answered: ["Answered", "em"] };
const NICE_RE = /\s*\((nice to have|preferred)\)\s*$/i;
// Why the card has its verdict: the stored reason, or one built from the must-have checklist.
function verdictWhy(ai) {
  // The label already names the verdict, so drop a reason that starts by repeating it.
  if (ai.verdict_reason) return String(ai.verdict_reason).replace(/^(perfect fit|good fit|possible fit|possible reject|not a fit|rejected?)(\s+for this (client|role|job))?(\s*\([^)]*\))?[.:]\s*/i, "");
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
  // Accepted roles, and roles they've been routed to but haven't accepted yet (shown with the
  // fit review against that job's description, and screened in full once they accept).
  candidate.jobLinks
    .filter((l) => l.response === "accepted" || (l.response === "pending" && l.stage !== "Withdrawn"))
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
              {S.role !== "recruiter" && e.id && <button type="button" title="Remove this submission" aria-label={"Remove the " + e.company + " submission"} onClick={() => S.deleteEndorsement(e.id).then(() => toast("Submission removed")).catch(() => {})} className="w-7 h-7 rounded-lg border flex items-center justify-center shrink-0" style={{ borderColor: C.line, color: C.ink2, background: "#fff" }}><X size={14} /></button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// A blind, anonymized profile link to share with the client once a candidate is sent to them.
// Hides name, contact details and current employer until a recruiter/Rec Ops explicitly reveals
// them on the same link -- the client never gets a second link.
function ClientLinkBox({ link, job, candidate, S, toast }) {
  const [busy, setBusy] = useState(false);
  const canManage = S.role !== "recruiter";
  const url = window.location.origin + window.location.pathname + "?t=" + link.clientToken;
  const copy = () => copyText(url, toast, "Client link copied");
  const reveal = () => {
    setBusy(true);
    S.sb("/rest/v1/candidate_jobs?id=eq." + link.id, { method: "PATCH", body: { client_revealed: true, client_revealed_at: new Date().toISOString() } })
      .then(() => S.sb("/rest/v1/candidate_timeline", { method: "POST", body: { candidate_id: candidate.id, title: "Full details revealed to " + job.client } }))
      .then(() => { toast("Full details revealed to " + job.client); S.reload(); })
      .catch((e) => S.error(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center gap-3" style={{ background: "#fff" }}>
      <div className="flex-1 text-sm">
        <div className="font-medium">Blind profile for {job.client}</div>
        <div className="text-xs mt-0.5" style={{ color: C.ink2 }}>
          {link.clientRevealed ? "Full details revealed" + (link.clientRevealedAt ? " " + ago(link.clientRevealedAt) : "" ) : "Name, contact and current employer are hidden until you reveal them"}
          {link.clientViewedAt ? " · opened by the client" : ""}
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <Btn icon={Copy} onClick={copy}>Copy link</Btn>
        {canManage && !link.clientRevealed && <Btn kind="primary" disabled={busy} onClick={reveal}>{busy ? "Revealing…" : "Reveal full details"}</Btn>}
      </div>
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
  // Routed but not accepted yet: shows the fit review against this job; screening, questions
  // and answers open up once they accept on their candidate page.
  const pending = link.response === "pending";
  const e = endorsed.find((x) => x.role === job.role) || null;
  const status = pending ? "Routed, waiting for " + first + " to accept" : e ? e.status : link.stage;
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  // Once put forward to the client, this always reads Good fit, whatever the AI verdict was.
  const sent = !!e || SENT_STAGES.includes(link.stage);
  const verdict = shownVerdict(ai.verdict, sent);
  const upgraded = !!ai.verdict && verdict !== ai.verdict;
  // Typing in answers from a call, or removing questions: Rec Ops/Admin or the candidate's recruiter.
  const canAnswer = !pending && (staff || candidate.recruiterId === S.me.id);
  const [answering, setAnswering] = useState(null);
  const [busy, setBusy] = useState("");
  // Editable copy of the drafted follow-up questions; reset whenever a new screening lands.
  const stamp = (ai.updatedAt || "") + (f ? f.state : "");
  const [drafts, setDrafts] = useState(null);
  const [seen, setSeen] = useState(stamp);
  if (stamp !== seen) { setSeen(stamp); setDrafts(null); setAnswering(null); }
  const qList = drafts !== null ? drafts : f && f.state === "draft" ? f.questions.map((x) => x.q) : [];
  const editing = !pending && staff && ((f && f.state === "draft") || (!f && drafts !== null));
  const setQ = (i, v) => setDrafts(qList.map((q, k) => (k === i ? v : q)));
  const run = async (label, fn) => { setBusy(label); try { await fn(); } catch (err) { S.error(err.message); } setBusy(""); };
  // New cards are screened on the server by themselves. While that runs (up to ~10 minutes,
  // with retries) the card says so and refreshes itself instead of offering a button.
  const autoRunning = !pending && !ai.stage && !candidate.ai_locked && !(ai.auto && ai.auto.error && (ai.auto.tries || 0) >= 3)
    && Date.now() - (link.createdAt || 0) < 12 * 60e3;
  useEffect(() => {
    if (!autoRunning || !S.reload) return;
    const t = setInterval(() => S.reload(), 15000);
    return () => clearInterval(t);
  }, [autoRunning]); // eslint-disable-line react-hooks/exhaustive-deps
  const screen = () => run("screen", async () => {
    await S.aiScreen("screen", { linkId: link.id });
    // Draft follow-up questions right away, with no separate manual step -- best-effort, since
    // it's a normal outcome for this to be a no-op (e.g. questions already sent).
    await S.aiScreen("draft_followups", { linkId: link.id }).catch(() => {});
    toast("Screened for " + job.client);
  });
  const approve = () => run("approve", async () => {
    const qs = qList.map((q) => q.trim()).filter(Boolean);
    if (!qs.length) throw new Error("Add at least one question");
    await S.aiScreen("approve_questions", { linkId: link.id, questions: qs });
    toast("Sent to " + first + "'s candidate page");
  });
  // Save follow-ups edited by hand (answers typed in, questions removed). Removed questions are
  // never suggested again; with every question answered the card is rescreened.
  const saveFollow = (label, questions, done) => run(label, async () => {
    const r = await S.aiScreen("save_followups", { linkId: link.id, questions });
    setAnswering(null); setDrafts(null);
    toast(done(r || {}));
  });
  const startAnswers = () => setAnswering((editing ? qList.map((q) => ({ q, a: "" })) : ((f && f.questions) || []).map((x) => ({ q: x.q, a: x.a || "" }))).filter((x) => String(x.q || "").trim()));
  const allTyped = !!answering && answering.length > 0 && answering.every((x) => x.a.trim());
  const saveAnswers = () => saveFollow("answers", answering, (r) =>
    !answering.length ? "Follow-up questions removed"
      : !answering.some((x) => x.a.trim()) ? "Saved. Removed questions won't be suggested again"
      : r.rescreened ? "Answers saved and " + first + " rescreened for " + job.client
      : r.locked ? "Answers saved. The review is locked, so it wasn't rescreened"
      : "Answers saved. The AI rescreens once every question has an answer");
  const removeSaved = (i) => saveFollow("remove", f.questions.filter((_, k) => k !== i).map((x) => ({ q: x.q, a: x.a || "" })), () => "Question removed. It won't be suggested again");
  const discardAll = () => saveFollow("discard", [], () => "Follow-up questions removed. They won't be suggested again");
  const xBtn = (onClick, label) => (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={!!busy} className="w-7 h-7 rounded-lg border flex items-center justify-center shrink-0" style={{ borderColor: C.line, color: C.ink2, background: "#fff" }}><X size={12} strokeWidth={2.5} /></button>
  );
  const appQs = job.screeningQuestions || [];
  const answered = appQs.filter((_, i) => String(link.screeningAnswers[i] || "").trim()).length;
  const box = { background: "#fff" };
  // Question sections start folded; the follow-up opens itself when it needs someone to act.
  const [showApp, setShowApp] = useState(false);
  const [showFollow, setShowFollow] = useState(null);
  const [showReqs, setShowReqs] = useState(false);
  const followOpen = !!answering || (showFollow !== null ? showFollow : editing || (f && f.state === "draft"));
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
        {verdict && <span className="hidden sm:inline"><Pill tone={VERDICT_TONE[verdict] || "neutral"}>{verdict}</Pill></span>}
        <ChevronDown size={18} color={C.ink2} className="shrink-0" style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-3.5">
          {group.items.length > 1 && <Tabs tabs={group.items.map((x, i) => ({ key: i, label: x.job.role }))} active={idx} setActive={setIdx} />}
          {link.reject && (
            <div className="rounded-lg px-3 py-2.5 text-sm flex flex-col gap-1" style={{ background: C.dangerBg, color: "#8E3320" }}>
              <div className="font-semibold">{link.reject.kind === "client" ? "Rejected by the client" : "Rejected"}: {REJECT_LABEL[link.reject.reason] || link.reject.reason}{link.reject.at ? " · " + fdate(link.reject.at) : ""}{link.reject.by ? " by " + link.reject.by : ""}</div>
              {link.reject.feedback && <div style={{ color: C.ink }}><span style={{ color: "#8E3320" }}>Feedback (internal): </span>{link.reject.feedback}</div>}
              {link.reject.message && <div style={{ color: C.ink2 }}>Told {first}: “{link.reject.message}”</div>}
            </div>
          )}
          {pending && (
            <div className="rounded-lg px-3 py-2.5 text-sm flex flex-col sm:flex-row sm:items-center gap-2" style={{ background: C.warnBg, color: "#7A4B05" }}>
              <span className="flex-1">Routed to {job.role}. Waiting for {first} to accept on their candidate page; the full screening runs as soon as they do.{ai.stage ? " Below is the fit review against this job's description." : ""}</span>
              {staff && <Btn onClick={() => setWithdrawOpen(true)} disabled={!!busy} className="shrink-0">Withdraw</Btn>}
            </div>
          )}
          {sent && link.clientToken && <ClientLinkBox link={link} job={job} candidate={candidate} S={S} toast={toast} />}
          {verdict && <span className="sm:hidden w-fit"><Pill tone={VERDICT_TONE[verdict] || "neutral"}>{verdict}</Pill></span>}
          {candidate.ai_locked && (
            <div className="rounded-lg p-2.5 flex items-center gap-2 text-xs" style={{ background: C.warnBg, color: C.warnFg }}>
              <Lock size={13} className="shrink-0" /> Locked — manually reviewed. {S.role === "admin" ? "Unlock from the candidate header to let the AI re-screen." : "An admin can unlock it to let the AI re-screen."}
            </div>
          )}
          {!ai.stage ? (
            <div className="rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center gap-3" style={box}>
              <div className="text-sm flex-1" style={{ color: C.ink2 }}>{pending ? "Not screened yet. It runs automatically once " + first + " accepts this role."
                : autoRunning ? <span className="inline-flex items-center gap-2"><Sparkles size={14} color={C.em} className="shrink-0" />Screening automatically against this job. It takes about a minute; this card updates by itself. <InlineDots /></span>
                : candidate.ai_locked ? "Not screened. The review is locked."
                : <>Automatic screening didn't finish{ai.auto && ai.auto.error ? " (" + ai.auto.error + ")" : ""}. Screen now to try again.</>}</div>
              {!pending && !autoRunning && <Btn kind="primary" onClick={screen} disabled={!!busy || candidate.ai_locked}>{busy === "screen" ? <>Screening <InlineDots color="#fff" /></> : "Screen now"}</Btn>}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs flex-wrap" style={{ color: C.ink2 }}>
                <Sparkles size={14} color={C.em} className="shrink-0" />
                <span>{ai.stage === "final" ? "Final screening" : "First screening"} · {ai.usedResume ? "resume + " : "no resume · "}{ai.answersUsed || 0} {ai.answersUsed === 1 ? "answer" : "answers"} · updated {ai.updatedAt ? fdate(ai.updatedAt) : "–"}</span>
                {!pending && !candidate.ai_locked && S.role !== "recruiter" && <button type="button" onClick={screen} disabled={!!busy} className="ml-auto font-medium" style={{ color: C.em }}>{busy === "screen" ? "Screening…" : "Rescreen"}</button>}
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
              {(why || upgraded) && verdict && (
                <div className="rounded-lg px-3 py-2.5 text-sm leading-relaxed" style={{ background: (TONE[VERDICT_TONE[verdict]] || TONE.neutral).bg }}>
                  <span className="font-semibold" style={{ color: (TONE[VERDICT_TONE[verdict]] || TONE.neutral).fg }}>Why {verdict === "Reject" ? "rejected" : verdict.toLowerCase()}: </span>
                  {upgraded ? <>Sent to {job.client}{e && e.by ? " " + e.by : ""}. The AI rated them {String(ai.verdict || "").toLowerCase() || "unscreened"}{why ? ": " + why : "."}</> : why}
                </div>
              )}
              {ai.verdict === "Possible reject" && (
                <div className="rounded-lg border px-3 py-2.5 text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2" style={{ borderColor: C.line }}>
                  <span><span className="font-medium">Not a final rejection.</span> <span style={{ color: C.ink2 }}>{first} hasn't answered any screening questions for this job yet. Screen them with the AI follow-up questions {f ? "below" : ""} before deciding.</span></span>
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
                  : (f.enteredBy ? "Answers entered by " + f.enteredBy : "Approved by " + (f.approvedBy || "Rec Ops")) + (f.answeredAt ? " · answered " + fdate(f.answeredAt) : "")}>
              {answering ? (
                <>
                  <div className="text-xs" style={{ color: C.ink2 }}>Type in what {first} told you on a call or message. Remove any question you don't need; it won't be suggested again. Once every question has an answer, the AI rescreens this card with them.</div>
                  {answering.map((x, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">{i + 1}. {x.q}</div>
                        <textarea value={x.a} onChange={(ev) => setAnswering(answering.map((y, k) => (k === i ? { ...y, a: ev.target.value } : y)))} rows={2} placeholder={first + "'s answer"}
                          className="w-full mt-1 text-sm rounded-lg border px-2.5 py-2" style={{ borderColor: C.line, background: "#FAF8F3" }} aria-label={"Answer to question " + (i + 1)} />
                      </div>
                      {xBtn(() => setAnswering(answering.filter((_, k) => k !== i)), "Remove question")}
                    </div>
                  ))}
                  {!answering.length && <div className="text-sm" style={{ color: C.ink3 }}>Every question removed. Save to clear them from this card.</div>}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Btn kind="primary" onClick={saveAnswers} disabled={!!busy}>{busy === "answers" ? <>Saving <InlineDots color="#fff" /></> : allTyped && !candidate.ai_locked ? "Save and rescreen" : "Save"}</Btn>
                    <Btn onClick={() => setAnswering(null)} disabled={!!busy}>Cancel</Btn>
                  </div>
                </>
              ) : editing ? (
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
                    {qList.some((q) => q.trim()) && <Btn onClick={startAnswers} disabled={!!busy}>Enter answers yourself</Btn>}
                    {f && <button type="button" onClick={discardAll} disabled={!!busy} className="text-xs font-medium ml-auto" style={{ color: C.ink2 }}>{busy === "discard" ? "Removing…" : "Remove all"}</button>}
                  </div>
                </>
              ) : f && f.state === "draft" ? (
                <>
                  {f.questions.map((x, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <div className="text-sm flex-1">{i + 1}. {x.q}{x.a && <div className="whitespace-pre-line mt-0.5" style={{ color: C.ink2 }}>{x.a}</div>}</div>
                      {canAnswer && xBtn(() => removeSaved(i), "Remove question")}
                    </div>
                  ))}
                  <div className="text-xs" style={{ color: C.warnFg }}>Waiting for Rec Ops or an Admin to approve before they're sent{canAnswer ? ", or enter " + first + "'s answers yourself" : ""}.</div>
                  {canAnswer && <Btn onClick={startAnswers} disabled={!!busy} className="w-fit">Enter answers yourself</Btn>}
                </>
              ) : (
                <>
                  {(f.questions || []).map((x, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <div className="text-sm flex-1"><div className="font-medium">{x.q}</div>{x.a && <div className="whitespace-pre-line mt-0.5" style={{ color: C.ink2 }}>{x.a}</div>}</div>
                      {canAnswer && f.state === "sent" && xBtn(() => removeSaved(i), "Remove question")}
                    </div>
                  ))}
                  {f.reply && <div className="text-sm whitespace-pre-line" style={{ color: C.ink2 }}>{f.reply}</div>}
                  {canAnswer && (f.state === "sent" || f.enteredBy) && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Btn onClick={startAnswers} disabled={!!busy}>{f.state === "answered" ? "Edit answers" : "Enter answers yourself"}</Btn>
                      {f.state === "sent" && <span className="text-xs" style={{ color: C.ink3 }}>No reply on their page yet? Type in what they told you.</span>}
                    </div>
                  )}
                </>
              )}
            </Fold>
          )}
          {!pending && !f && !editing && staff && ai.stage && ai.verdict !== "Reject" && (
            <button type="button" onClick={() => setDrafts([""])} className="text-xs font-medium w-fit" style={{ color: C.em }}>+ Ask an AI follow-up question</button>
          )}
        </div>
      )}
      <ConfirmModal open={withdrawOpen} onClose={() => setWithdrawOpen(false)} title={"Withdraw " + job.role + "?"} confirmLabel="Withdraw"
        body={"This removes the route to " + job.role + ", " + job.client + ". It disappears from " + first + "'s candidate page and from this profile."}
        onConfirm={() => run("withdraw", async () => { await S.unlinkJob(link.id); setWithdrawOpen(false); toast("Route withdrawn"); })} busy={busy === "withdraw"} />
    </div>
  );
}

/* Reject with a recorded reason, and tell the candidate why (email + their candidate page). */
const REJECT_REASONS = [["experience", "Not enough experience"], ["skill", "Missing a must-have skill"], ["salary", "Salary expectation"], ["location", "Location / work authorisation"],
  ["notice", "Notice period"], ["other_candidate", "Client chose another candidate"], ["role_closed", "Role filled or paused"], ["interview", "Interview performance"], ["other", "Other"]];
const REJECT_LABEL = Object.fromEntries(REJECT_REASONS);
function RejectModal({ candidate, kind: kind0, linkId: link0, S, toast, onClose, onDone }) {
  const first = candidate.name.split(" ")[0];
  const links = candidate.jobLinks.filter((l) => l.response !== "declined" && !["Rejected", "Withdrawn"].includes(l.stage)).sort((a, b) => b.createdAt - a.createdAt);
  const [kind, setKind] = useState(kind0 || "internal");
  const [linkId, setLinkId] = useState(link0 || (links[0] ? links[0].id : ""));
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [notify, setNotify] = useState(!!candidate.emailAddr);
  const [message, setMessage] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState(null);
  const link = candidate.jobLinks.find((l) => l.id === linkId) || null;
  const job = link ? S.jobs.find((j) => j.id === link.jobId) : null;
  const draft = () => { setBusy("draft"); S.msgQuiet("draft_reject", { linkId: linkId || undefined, candidateId: candidate.id, kind, reason, feedback }).then((r) => { setMessage(r.message || ""); setEdited(false); }).catch((e) => S.error(e.message)).finally(() => setBusy("")); };
  // A plain explanation as soon as a reason is picked; "Write it from the feedback" makes it specific.
  React.useEffect(() => { if (reason && !edited && !feedback.trim()) S.msgQuiet("draft_reject", { linkId: linkId || undefined, candidateId: candidate.id, kind, reason }).then((r) => setMessage(r.message || "")).catch(() => {}); }, [reason, kind]); // eslint-disable-line
  const showPreview = () => { setBusy("preview"); S.msgQuiet("preview_reject", { linkId: linkId || undefined, candidateId: candidate.id, kind, reason, message }).then(setPreview).catch((e) => S.error(e.message)).finally(() => setBusy("")); };
  const submit = () => {
    if (!reason) { toast("Pick the main reason"); return; }
    setBusy("save");
    S.rejectCandidate({ linkId: linkId || undefined, candidateId: candidate.id, kind, reason, feedback, message, notify })
      .then((r) => { toast((kind === "client" ? "Recorded as rejected by the client" : "Candidate rejected") + (r.emailed ? ". " + first + " has been emailed why." : notify && r.unsubscribed ? ". Not emailed: " + first + " has unsubscribed from emails." : notify && !r.emailed ? ". The email couldn't be sent." : ".") + (r.movedToActiveFile ? " Moved to Active file." : "")); onDone && onDone(r); onClose(); })
      .catch(() => {}).finally(() => setBusy(""));
  };
  const ta = "w-full mt-1.5 rounded-lg border px-3 py-2.5 text-sm outline-none resize-none";
  const taS = { borderColor: C.line, background: "#FAF8F3" };
  const pill = (on, label, onClick) => <button key={label} type="button" aria-pressed={on} onClick={onClick} className="rounded-full px-3 py-1.5 text-sm" style={on ? { background: C.ink, color: "#fff" } : { border: "1px solid #D5D2C7", color: C.ink2, background: "#fff" }}>{label}</button>;
  return (
    <Modal open onClose={onClose} title={(kind === "client" ? "Client reject · " : "Reject · ") + candidate.name} wide>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1"><label className="text-xs font-medium" style={{ color: C.ink2 }}>Role</label>
            <select value={linkId} onChange={(e) => setLinkId(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3 py-2.5 text-sm" style={taS}>
              {links.map((l) => { const j = S.jobs.find((x) => x.id === l.jobId); return <option key={l.id} value={l.id}>{j ? j.role + " · " + j.client : "Role"}</option>; })}
              <option value="">{links.length ? "Not for a specific role" : "No role linked"}</option>
            </select></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Who decided</label>
            <div className="flex gap-1.5 mt-1.5">{pill(kind === "client", "The client", () => setKind("client"))}{pill(kind === "internal", "Us", () => setKind("internal"))}</div></div>
        </div>
        <div><div className="text-xs font-medium mb-1.5" style={{ color: C.ink2 }}>Main reason (required)</div>
          <div className="flex flex-wrap gap-1.5">{REJECT_REASONS.map(([k, l]) => pill(reason === k, l, () => setReason(k)))}</div></div>
        <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>{kind === "client" ? "Client's feedback, in full" : "Why, in your words"} (internal, never sent)</label>
          <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} className={ta} style={taS} placeholder={kind === "client" ? "Paste or type what the client said" : "e.g. 5 years short of the 10 required; no SEC reporting"} /></div>
        <div className="pt-3 flex flex-col gap-2" style={{ borderTop: `1px solid ${C.line}` }}>
          <label className="flex items-center gap-2.5 text-sm font-medium"><input type="checkbox" checked={notify} disabled={!candidate.emailAddr && !link} onChange={(e) => setNotify(e.target.checked)} />
            {candidate.emailAddr ? "Email " + first + " why " + (kind === "client" ? "the client didn't move forward" : "we're not putting them forward") : "Tell " + first + " why on their candidate page (no email on file)"}</label>
          {notify && <>
            <div className="flex items-end justify-between gap-2"><label className="text-xs font-medium" style={{ color: C.ink2 }}>What {first} will read</label>
              <button type="button" disabled={!reason || !feedback.trim() || !!busy} onClick={draft} className="text-xs font-medium" style={{ color: reason && feedback.trim() ? C.em : C.ink3 }}>{busy === "draft" ? "Writing…" : "Write it from the feedback (AI)"}</button></div>
            <textarea rows={4} value={message} onChange={(e) => { setMessage(e.target.value); setEdited(true); }} className={ta} style={taS} placeholder={reason ? "" : "Pick a reason first"} />
            <div className="text-xs" style={{ color: C.ink2 }}>Kind and specific, never harsh. It also appears on {first}'s candidate page. <button type="button" className="underline" disabled={!reason || !!busy} onClick={showPreview}>{busy === "preview" ? "Loading…" : "Preview the email"}</button></div>
          </>}
        </div>
        <div className="text-xs rounded-lg px-3 py-2" style={{ background: C.canvas, color: C.ink2 }}>The reason and feedback are saved on this role's card and {first}'s timeline. {link ? "The role is marked Rejected. " : ""}They go back to Active file unless they're live on another role, so they stay searchable.</div>
        <div className="flex justify-end gap-2"><Btn onClick={onClose} disabled={busy === "save"}>Cancel</Btn><Btn kind="danger" disabled={!reason || busy === "save"} onClick={submit}>{busy === "save" ? <>Saving <InlineDots color="#fff" /></> : notify ? "Reject and send" : "Reject"}</Btn></div>
      </div>
      <Modal open={!!preview} onClose={() => setPreview(null)} title="Email preview" wide>
        {preview && <div className="flex flex-col gap-2">
          <div className="text-xs" style={{ color: C.ink2 }}>To: {preview.to || "(no email on file)"} · Subject: <span style={{ color: C.ink }}>{preview.subject}</span></div>
          <iframe title="Email preview" srcDoc={preview.html} sandbox="" className="w-full rounded-lg border" style={{ borderColor: C.line, height: 520 }} />
        </div>}
      </Modal>
    </Modal>
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
    catch (e) { S.error(e.message); }
    setBusy(false);
  };
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="text-xs" style={{ color: C.ink3 }}>INDUSTRY EXPERIENCE</div>
      </div>
      {!items.length ? (
        <div className="text-sm" style={{ color: C.ink3 }}>{candidate.cv ? "Not looked up yet. It runs automatically when they're screened." : "Upload a resume to look up their employers."}</div>
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
              <Btn kind="primary" onClick={route} disabled={!!busy || !takesCandidates(job)}>{busy === "route" ? <>Routing <InlineDots color="#fff" /></> : chosen.length ? "Route with " + chosen.length + " question" + (chosen.length > 1 ? "s" : "") : "Route without questions"}</Btn>
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
const MATCHES_COLLAPSED_COUNT = 3;
function MatchesCard({ candidate, S, toast }) {
  const [reviewJob, setReviewJob] = useState(null);
  const [showAllMatches, setShowAllMatches] = useState(false);
  const [titlesBusy, setTitlesBusy] = useState(false);
  const busy = busyWith(candidate, S.jobs);
  const refreshTitles = () => {
    setTitlesBusy(true);
    S.aiScreen("parallel_titles", { candidateId: candidate.id }).then(() => toast("Parallel titles updated")).catch((e) => S.error(e.message)).finally(() => setTitlesBusy(false));
  };
  const titles = (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium" style={{ color: C.ink2 }}>PARALLEL TITLES · roles they could be hired into now</div>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {candidate.parallelTitles.length
          ? candidate.parallelTitles.map((t) => <span key={t} className="text-xs rounded-full px-2.5 py-1" style={{ background: C.canvas, color: C.ink }}>{t}</span>)
          : <span className="text-xs" style={{ color: C.ink2 }}>Not worked out yet. They're added automatically when the resume is read or the candidate is screened.</span>}
      </div>
      <div className="text-xs mt-1.5" style={{ color: C.ink2 }}>Bench checks for a new job only consider people whose parallel titles match it.</div>
    </div>
  );
  if (busy) return (
    <Card>
      <SectionTitle title="Other roles they could fit" size="text-xl" />
      <div className="text-sm mt-2" style={{ color: C.ink2 }}>At {busy}. Not pitched for other roles until that process ends.</div>
      {titles}
    </Card>
  );
  const rows = realMatches(candidate, S)
    .map((m) => ({ m, job: S.jobs.find((j) => j.id === m.job_id) }))
    .sort((a, b) => (b.m.fit || 0) - (a.m.fit || 0));
  const listed = new Set(rows.map((x) => x.job.id));
  const others = S.jobs.filter((j) => takesCandidates(j) && !listed.has(j.id) && !candidate.jobLinks.some((l) => l.jobId === j.id));
  return (
    <Card>
      <SectionTitle title="Other roles they could fit" sub="Roles the full AI review rated a fit on location, experience, skills and requirements. A company card appears once you route them and they accept." size="text-xl" />
      {titles}
      {!rows.length && <div className="text-sm mt-3" style={{ color: C.ink2 }}>No reviewed fits on open roles yet.</div>}
      {(showAllMatches ? rows : rows.slice(0, MATCHES_COLLAPSED_COUNT)).map(({ m, job }) => {
        const link = candidate.jobLinks.find((l) => l.jobId === job.id) || null;
        return (
          <div key={job.id} className="flex items-center justify-between py-2.5 gap-2" style={{ borderTop: `1px solid ${C.line}` }}>
            <div className="min-w-0"><div className="text-sm font-medium truncate">{job.role}</div><div className="text-xs" style={{ color: C.ink2 }}>{job.client} · reviewed {fdate(m.reviewedAt)}</div></div>
            <div className="flex items-center gap-2 shrink-0">
              {m.fit != null && <span className="text-sm font-medium">{m.fit}%</span>}
              {m.verdict && <Pill tone={VERDICT_TONE[m.verdict] || "neutral"}>{m.verdict}</Pill>}
              {link && <span className="text-xs font-medium" style={{ color: link.response === "declined" ? C.dangerFg : C.warnFg }}>{link.response === "declined" ? "Declined" : "Waiting to accept"}</span>}
              <Btn onClick={() => setReviewJob(job)} className="text-xs px-3 py-1.5">Open review</Btn>
            </div>
          </div>
        );
      })}
      {rows.length > MATCHES_COLLAPSED_COUNT && (
        <button onClick={() => setShowAllMatches((v) => !v)} className="text-xs underline mt-2" style={{ color: C.ink2 }}>
          {showAllMatches ? "Show less" : "See all " + rows.length}
        </button>
      )}
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
    } catch (e) { S.error(e.message || "AI screening failed"); }
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
  const available = S.jobs.filter((j) => takesCandidates(j) && !candidate.jobLinks.some((l) => l.jobId === j.id));
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
    S.setCands((l) => [newCandidate({ name: x.name, role: x.role, recruiter: r.name, recruiterId: r.id, recruiterInit: init, ai: x.ai, emailAddr: x.email || "", phone: x.phone || "", source: x.source, timeline: [{ t: "Applied via " + x.source + ", assigned to " + r.name, d: fdate(new Date()), done: true }] }), ...l]);
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
            { key: "email", label: "CONTACT", render: (x) => <span className="text-xs" style={{ color: C.ink2 }}>{x.email || x.phone || "-"}</span> },
            { key: "ai", label: "AI", render: (x) => { const c = x.candidateId ? S.cands.find((y) => y.id === x.candidateId) : null; const v = c && c.ai ? c.ai : x.ai; return <span title={c && c.ai ? "Their current score" : "Score when they applied"}><Pill tone={scoreTone(v)}>{v ? v + "%" : "-"}</Pill></span>; } },
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

/* Every job-linked candidate is a possible thread, whether or not anyone has said anything
   yet — that's what lets a recruiter start a conversation, not just answer one. */
function MessagesPage({ toast, S }) {
  // On phones an open conversation takes the whole screen (above the bottom navigation).
  const desktop = useDesktop();
  const [jobFilter, setJobFilter] = useState("");
  const [openId, setOpenId] = useState(null);
  const [search, setSearch] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeSearch, setComposeSearch] = useState("");

  const allThreads = S.cands.flatMap((c) => c.jobLinks.filter((l) => l.response !== "declined").map((l) => {
    const j = S.jobs.find((x) => x.id === l.jobId);
    const msgs = l.messages || [];
    const last = msgs[msgs.length - 1] || null;
    const unread = msgs.filter((m) => m.sender === "candidate" && !m.recruiterReadAt).length;
    return { cand: c, link: l, job: j, last, unread, at: last ? last.at : l.createdAt, hasMsgs: msgs.length > 0 };
  }));

  const q = search.trim().toLowerCase();
  const matches = (t) => !q || t.cand.name.toLowerCase().includes(q)
    || (t.job && (t.job.role.toLowerCase().includes(q) || t.job.client.toLowerCase().includes(q)))
    || (t.last && filePreview(t.last).toLowerCase().includes(q));
  const threads = allThreads
    .filter((t) => t.hasMsgs)
    .filter((t) => !jobFilter || (t.job && t.job.id === jobFilter))
    .filter(matches)
    .sort((a, b) => b.unread - a.unread || b.at - a.at);

  const openThread = allThreads.find((t) => t.link.id === openId) || null;
  const open = (t) => { setOpenId(t.link.id); if (t.unread) S.markThreadRead(t.link.id).catch(() => {}); };

  const cq = composeSearch.trim().toLowerCase();
  const composeList = allThreads
    .filter((t) => !t.hasMsgs)
    .filter((t) => !cq || t.cand.name.toLowerCase().includes(cq) || (t.job && (t.job.role.toLowerCase().includes(cq) || t.job.client.toLowerCase().includes(cq))))
    .sort((a, b) => a.cand.name.localeCompare(b.cand.name));
  const startNew = (t) => { setOpenId(t.link.id); setComposeOpen(false); setComposeSearch(""); };

  // WhatsApp-style: the list and the open chat are two separate screens on mobile -- picking a
  // conversation swaps the list out for a full-width chat with a back arrow. From md up there's
  // room for both side by side. Once a conversation is open (either breakpoint), the page title
  // steps aside and both panels stretch to fill the viewport under the top bar, so the chat reads
  // as a full page rather than a small box -- the panel's own header (avatar + name + back arrow)
  // stands in for the page title, the way a messaging app's chat screen does.
  const fullHeightStyle = { height: "calc(100vh - 190px)", minHeight: 420 };
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      {!openId && <SectionTitle size="text-3xl md:text-4xl" title="Messages" sub="Conversations you've actually started, by role." />}
      <div className="flex flex-col md:flex-row gap-5 md:gap-6">
        <Card className={(openId ? "hidden md:flex md:flex-col md:-mb-24 " : "") + "md:w-80 shrink-0 !p-0 overflow-hidden"} style={openId ? fullHeightStyle : {}}>
          <div className="p-3.5 flex flex-col gap-2.5 shrink-0" style={{ borderBottom: `1px solid ${C.line}` }}>
            <div className="flex items-center gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search conversations" />
              <button onClick={() => setComposeOpen(true)} title="New message" className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: C.side, color: "#fff" }}><Plus size={16} /></button>
            </div>
            <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }}>
              <option value="">All jobs</option>
              {S.jobs.map((j) => <option key={j.id} value={j.id}>{j.role} · {j.client}</option>)}
            </select>
          </div>
          <div className={"overflow-y-auto " + (openId ? "flex-1 min-h-0" : "max-h-[70vh] md:max-h-[28rem]")}>
            {threads.length === 0 && <div className="text-sm text-center py-8 px-4" style={{ color: C.ink3 }}>{search || jobFilter ? "No matching conversations." : "No conversations yet. Tap + to message a candidate."}</div>}
            {threads.map((t) => (
              <button key={t.link.id} onClick={() => open(t)} className="w-full text-left px-3.5 py-3 flex items-start gap-2.5"
                style={{ borderBottom: `1px solid ${C.line}`, background: openId === t.link.id ? C.canvas : "transparent" }}>
                <Avatar init={initialsOf(t.cand.name)} tone="em" size={32} src={t.cand.photoUrl || undefined} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">{t.cand.name}</span>
                    {t.unread > 0 && <span className="text-[10px] rounded-full px-1.5 py-0.5 shrink-0" style={{ background: C.dangerBg, color: C.dangerFg }}>{t.unread}</span>}
                  </div>
                  <div className="text-xs truncate" style={{ color: C.ink2 }}>{t.job ? t.job.role + " · " + t.job.client : "Role"}</div>
                  <div className="text-xs truncate mt-0.5 flex items-center gap-1" style={{ color: C.ink3 }}>
                    {t.last && t.last.sender === "recruiter" && <ListTicks m={t.last} />}
                    <span className="truncate">{t.last ? (t.last.sender === "recruiter" ? "You: " : "") + filePreview(t.last) : "No messages yet"}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </Card>
        <Card className={(openId ? "flex flex-col md:-mb-24 !p-0 overflow-hidden " : "hidden md:block ") + "flex-1"} style={openId ? (desktop ? fullHeightStyle : { position: "fixed", inset: 0, zIndex: 50, height: "100dvh", borderRadius: 0, border: "none" }) : {}}>
          {!openThread ? (
            <div className="text-sm text-center py-10" style={{ color: C.ink3 }}>Pick a conversation on the left, or tap + to start one.</div>
          ) : (
            <ChatRoom key={openThread.link.id} linkId={openThread.link.id} mine="recruiter" api={staffChatApi(S, openThread.link.id)} className="h-full"
              title={openThread.cand.name} avatarSrc={openThread.cand.photoUrl} avatarInit={initialsOf(openThread.cand.name)}
              subtitle={openThread.job ? openThread.job.role + " · " + openThread.job.client : "Role"}
              onBack={() => setOpenId(null)} onClose={() => S.reload && S.reload()}
              onProfile={() => S.openCandidate(openThread.cand.id)} peerName={openThread.cand.name}
              emptyText={"No messages yet. " + openThread.cand.name.split(" ")[0] + " also gets an email for each message you send."} />
          )}
        </Card>
      </div>
      <Modal open={composeOpen} onClose={() => { setComposeOpen(false); setComposeSearch(""); }} title="New message">
        <div className="flex flex-col gap-3">
          <SearchInput value={composeSearch} onChange={setComposeSearch} placeholder="Search candidates by name, role or client" />
          <div className="max-h-96 overflow-y-auto flex flex-col gap-1">
            {composeList.length === 0 && <div className="text-sm text-center py-6" style={{ color: C.ink3 }}>{allThreads.filter((t) => !t.hasMsgs).length === 0 ? "Every job-linked candidate already has a conversation." : "No candidates found."}</div>}
            {composeList.map((t) => (
              <button key={t.link.id} onClick={() => startNew(t)} className="w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-2.5" style={{ background: "transparent" }}
                onMouseEnter={(e) => e.currentTarget.style.background = C.canvas} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                <Avatar init={initialsOf(t.cand.name)} tone="em" size={32} src={t.cand.photoUrl || undefined} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{t.cand.name}</div>
                  <div className="text-xs truncate" style={{ color: C.ink3 }}>{t.job ? t.job.role + " · " + t.job.client : "Role"}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </Modal>
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
  const [benchBusy, setBenchBusy] = useState(false);
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
  const setStatus = (v) => { if (v === "On hold") { setHold({ reason: job.holdReason || "", until: job.holdUntil || "" }); return; } S.setJobStatus(job.id, v).then(() => toast(v === "Open" ? "Role reopened" : "Role " + v.toLowerCase())).catch(() => {}); };
  const [hold, setHold] = useState(null);
  const saveHold = () => { setBusy(true); S.setJobStatus(job.id, "On hold", hold).then(() => { setHold(null); toast("Role on hold. No new candidates until it's reopened."); }).catch(() => {}).finally(() => setBusy(false)); };
  const engagedPeople = (job.engagedNames || []).filter(Boolean);
  const copyLink = () => { try { navigator.clipboard.writeText("https://" + job.link); toast("Link copied"); } catch (e) { toast("Copy failed. Select the link and copy it."); } };
  const fits = benchFitsFor(job, S);
  const lastBench = Math.max(0, ...S.cands.flatMap((c) => (c.matches || []).filter((m) => m.job_id === job.id && m.reviewedAt).map((m) => new Date(m.reviewedAt).getTime())));
  const checkBench = () => {
    setBenchBusy(true);
    S.aiScreen("bench_fits", { jobId: job.id })
      .then((r) => toast(r.considered
        ? plural(r.considered, "person", "people") + " with a matching title. Reviewed " + r.reviewed + (r.reused ? ", reused " + r.reused + " recent review" + (r.reused > 1 ? "s" : "") : "") + (r.busy ? ". " + r.busy + " busy elsewhere, left out." : ".") + (r.errors && r.errors.length ? " " + r.errors.length + " couldn't be reviewed." : "")
        : "No one free on the bench has a parallel title matching this role" + (r.busy ? " (" + r.busy + " busy elsewhere)." : ".")))
      .catch((e) => S.error(e.message)).finally(() => setBenchBusy(false));
  };

  // Engage/disengage: job_recruiters is "who's on it now"; job_engagements is the permanent
  // history admins review (per job: who, how long, and why they stepped back).
  const jobEngLog = (S.jobEngagements || []).filter((e) => e.jobId === job.id);
  // Engaging is personal: it only marks the person who clicked it, never the job for everyone.
  const myOpenEngagement = jobEngLog.find((e) => e.recruiterId === S.me.id && !e.disengagedAt) || ((job.engagedIds || []).includes(S.me.id) ? { engagedAt: null } : null);
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
            <Btn icon={Upload} kind="dark" onClick={onAddCandidate} disabled={!takesCandidates(job)} title={takesCandidates(job) ? "" : "This role isn't taking new candidates"}>Add candidate</Btn>
            <Btn onClick={() => onPromote(job.role)}>Promote</Btn>
            {myOpenEngagement
              ? <Btn onClick={() => setReasonOpen(true)} disabled={busy}>Disengage</Btn>
              : <Btn kind="primary" onClick={engage} disabled={busy || job.status === "Closed"}>Engage</Btn>}
            {S.role !== "recruiter" && <Btn icon={Pencil} onClick={onEdit}>Edit</Btn>}
            {S.role === "admin" && <Btn icon={X} onClick={() => setDelOpen(true)}>Delete</Btn>}
            {S.role !== "recruiter" && (
              <div className="relative">
                <Btn kind="primary" onClick={() => setMenuOpen((m) => !m)}>Change status</Btn>
                {menuOpen && (
                  <div className="absolute right-0 top-11 rounded-xl border shadow-lg z-10 w-48 py-1" style={{ background: "#fff", borderColor: C.line }}>
                    {JOB_STATUSES.map((o) => (
                      <button key={o} onClick={() => { setStatus(o); setMenuOpen(false); }} disabled={o === job.status && o !== "On hold"} className="w-full text-left px-3.5 py-2.5 text-sm flex items-center justify-between" style={{ color: o === job.status && o !== "On hold" ? C.ink3 : C.ink }}>
                        <span>{o === "Open" && job.status !== "Open" && job.status !== "Draft" ? "Reopen" : o === "On hold" && job.status === "On hold" ? "Edit hold" : o === "On hold" ? "Put on hold" : o}</span>{o === job.status && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mb-4">
          <StatusPill status={job.status} />
          {myOpenEngagement ? <Pill tone="em">You're engaged{myOpenEngagement.engagedAt ? " · since " + ago(myOpenEngagement.engagedAt) : ""}</Pill> : <Pill tone="neutral">You're not engaged</Pill>}
          {engagedPeople.length > 0 && <span title={engagedPeople.join(", ")}><Pill tone="neutral">{engagedPeople.length} {engagedPeople.length === 1 ? "person" : "people"} engaged</Pill></span>}
        </div>
        {job.status === "On hold" && (
          <div className="rounded-lg px-3 py-2.5 mb-4 text-sm flex flex-col sm:flex-row sm:items-center gap-2" style={{ background: C.warnBg, color: "#7A4B05" }}>
            <span className="flex-1"><b>{holdText(job)}.</b> Recruiters can't add or route new candidates until it's reopened{job.holdUntil ? " (it reopens by itself on that date)" : ""}. Candidates already on it carry on as normal.{job.heldBy ? " Put on hold by " + job.heldBy + (job.heldAt ? " " + ago(job.heldAt) : "") + "." : ""}</span>
            {S.role !== "recruiter" && <Btn onClick={() => setStatus("Open")} className="shrink-0">Reopen</Btn>}
          </div>
        )}
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
      {S.role !== "recruiter" && takesCandidates(job) && (
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <SectionTitle title="Candidates who might fit this role" sub="Only people whose parallel job titles match this role are reviewed, on location, work setup, experience, skills and every requirement. Anyone at Interview or Offer on another role is left out." size="text-xl" />
            <Btn icon={Sparkles} onClick={checkBench} disabled={benchBusy} className="shrink-0">{benchBusy ? "Checking…" : "Check the bench"}</Btn>
          </div>
          {lastBench > 0 && <div className="text-xs mt-1" style={{ color: C.ink2 }}>Last checked {fdate(lastBench)} · {plural(fits.length, "fit")}</div>}
          <div className="flex flex-col gap-2 mt-3">
            {fits.map(({ c, m }) => (
              <div key={c.id} className="rounded-xl border p-3" style={{ borderColor: C.line }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0 cursor-pointer" onClick={() => S.openCandidate(c.id)}>
                    <Avatar init={c.name.split(" ").map((x) => x[0]).join("")} tone="em" />
                    <div className="min-w-0"><div className="font-medium text-sm truncate">{c.name}</div><div className="text-xs truncate" style={{ color: C.ink2 }}>{[c.role, c.location, c.recruiter].filter(Boolean).join(" · ")}</div></div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm font-medium">{m.fit}%</span>
                    <Pill tone={VERDICT_TONE[m.verdict] || "neutral"}>{m.verdict}</Pill>
                  </div>
                </div>
                {m.verdict_reason && <div className="text-xs mt-2" style={{ color: C.ink2 }}>{m.verdict_reason}</div>}
                <div className="flex gap-2 mt-2 justify-end"><Btn onClick={() => setFitFor(c)}>Open review</Btn><Btn kind="primary" onClick={() => reroute(c)}>Route</Btn></div>
              </div>
            ))}
            {!fits.length && <div className="text-sm" style={{ color: C.ink2 }}>{lastBench ? "No one on the bench meets this role's must-haves yet." : "Not checked yet. Check the bench to review the closest people already in ProNext."}</div>}
          </div>
        </Card>
      )}
      {S.role !== "recruiter" && <JobSourcingCard job={job} S={S} toast={toast} />}
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
              { key: "ai", label: "FIT", render: (c) => { const v = c.link && c.link.fit != null ? c.link.fit : c.ai; return <Pill tone={scoreTone(v)}>{v ? v + "%" : "-"}</Pill>; } },
            ]}
          />
        </div>
      </Card>
      <Modal open={!!hold} onClose={() => setHold(null)} title={job.status === "On hold" ? "Edit the hold" : "Put this role on hold"}>
        {hold && (
          <div className="flex flex-col gap-3">
            <div className="text-sm" style={{ color: C.ink2 }}>While it's on hold, no one can add, route or resubmit new candidates to {job.role}, and its public page stops taking applications. Candidates already on it carry on: interviews, offers and status changes still work.</div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Why (optional, everyone on the team sees it)</label>
              <input value={hold.reason} onChange={(e) => setHold({ ...hold, reason: e.target.value })} placeholder="e.g. Client reviewing the shortlist" className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Reopen automatically on (optional)</label>
              <input type="date" value={hold.until || ""} min={ymdToday()} onChange={(e) => setHold({ ...hold, until: e.target.value })} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
              <div className="text-xs mt-1" style={{ color: C.ink3 }}>Leave empty to keep it on hold until someone reopens it.</div></div>
            <Btn kind="primary" full onClick={saveHold} disabled={busy}>{busy ? <>Saving <InlineDots color="#fff" /></> : job.status === "On hold" ? "Save" : "Put on hold"}</Btn>
          </div>
        )}
      </Modal>
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
  const [tab, setTab] = useState("All");
  const mine = (j) => (j.engagedIds || []).includes(S.me.id);
  const inTab = (j, t) => t === "All" || (t === "Mine" ? mine(j) : j.status === t);
  const filtered = S.jobs.filter((j) => inTab(j, tab) && hit(j, q.toLowerCase()) && hit(j, gq));
  const tabs = ["All", "Open", "On hold", "Closed", "Mine"].map((t) => ({ key: t, label: (t === "Mine" ? "I'm engaged" : t) + " " + S.jobs.filter((j) => inTab(j, t)).length }));
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="All roles" sub="Every role has its own unique link." />
        <Btn kind="primary" icon={Plus} onClick={() => setPage("postJob")}>Post a job</Btn>
      </div>
      <Card>
        <div className="mb-3 overflow-x-auto"><Tabs tabs={tabs} active={tab} setActive={setTab} /></div>
        <div className="mb-3"><SearchInput value={q} onChange={setQ} placeholder="Search roles or clients" /></div>
        <DataTable
          rows={filtered}
          onRowClick={(j) => onOpenJob(j.id)}
          columns={[
            { key: "role", label: "ROLE", render: (j) => <div><div className="font-medium">{j.role}</div><div className="text-xs" style={{ color: C.ink2 }}>{j.client}</div></div> },
            { key: "recruiters", label: "ENGAGED", render: (j) => j.recruiters.length ? <div className="flex -space-x-2" title={(j.engagedNames || []).join(", ")}>{j.recruiters.map((r, i) => <Avatar key={i} init={r} tone={PEOPLE_TONE[r]} size={26} />)}</div> : <span className="text-xs" style={{ color: C.ink3 }}>None yet</span> },
            { key: "submitted", label: "SUBMITTED", render: (j) => j.submitted },
            { key: "interview", label: "INTERVIEW", render: (j) => j.interview },
            { key: "days", label: "DAYS", render: (j) => `${j.days}d` },
            { key: "status", label: "STATUS", render: (j) => (
              <div className="flex items-center gap-2">
                <span title={j.status === "On hold" ? holdText(j) : ""}><StatusPill status={j.status} /></span>
                {mine(j) && <Pill tone="em">You're engaged</Pill>}
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
    catch (e) { S.error(e.message); }
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
    } catch (e) { S.error(e.message || "Couldn't read that file"); }
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
  const [copy, setCopy] = useState(`We're hiring: ${jobTitle}. Competitive pay, remote-friendly, fast interview process. Apply through ProNext today.`);

  React.useEffect(() => {
    setCopy(`We're hiring: ${jobTitle}. Competitive pay, remote-friendly, fast interview process. Apply through ProNext today.`);
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

/* ----------------------------------------------------------------------
   Interviews: calendar, scheduling, outcomes. Server side is the `interviews` Edge Function
   (Google Calendar sync, candidate emails and reminders, no-show follow-up).
   Times are stored once (UTC) and shown in each viewer's own time zone.
   ---------------------------------------------------------------------- */
const MY_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; } })();
const TZ_OPTIONS = [
  ["Africa/Lagos", "Lagos (WAT)"], ["Europe/London", "London"], ["Europe/Dublin", "Dublin"], ["Europe/Lisbon", "Lisbon"],
  ["Europe/Paris", "Central Europe (Paris, Berlin, Madrid)"], ["Europe/Athens", "Eastern Europe (Athens, Helsinki)"],
  ["America/New_York", "US Eastern"], ["America/Chicago", "US Central"], ["America/Denver", "US Mountain"], ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "US Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"], ["America/Toronto", "Toronto"],
  ["Asia/Kuala_Lumpur", "Malaysia"], ["Asia/Singapore", "Singapore"], ["Asia/Dubai", "Dubai"], ["Asia/Kolkata", "India"],
  ["Africa/Nairobi", "Nairobi"], ["Africa/Johannesburg", "Johannesburg"], ["Australia/Sydney", "Sydney"], ["UTC", "UTC"],
];
if (!TZ_OPTIONS.some(([z]) => z === MY_TZ)) TZ_OPTIONS.unshift([MY_TZ, MY_TZ.replace(/_/g, " ")]);
const US_TZ = { ET: "America/New_York", CT: "America/Chicago", MT: "America/Denver", PT: "America/Los_Angeles" };
const US_STATE_TZ = {};
"CT DE DC FL GA IN KY ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV".split(" ").forEach((s) => (US_STATE_TZ[s] = US_TZ.ET));
"AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI".split(" ").forEach((s) => (US_STATE_TZ[s] = US_TZ.CT));
"CO ID MT NM UT WY".split(" ").forEach((s) => (US_STATE_TZ[s] = US_TZ.MT));
"CA NV OR WA".split(" ").forEach((s) => (US_STATE_TZ[s] = US_TZ.PT));
Object.assign(US_STATE_TZ, { AZ: "America/Phoenix", AK: "America/Anchorage", HI: "Pacific/Honolulu" });
const COUNTRY_TZ = { nigeria: "Africa/Lagos", ghana: "Africa/Lagos", "united kingdom": "Europe/London", uk: "Europe/London", england: "Europe/London", scotland: "Europe/London", ireland: "Europe/Dublin", portugal: "Europe/Lisbon",
  malaysia: "Asia/Kuala_Lumpur", singapore: "Asia/Singapore", "united arab emirates": "Asia/Dubai", uae: "Asia/Dubai", india: "Asia/Kolkata", kenya: "Africa/Nairobi", "south africa": "Africa/Johannesburg", australia: "Australia/Sydney", canada: "America/Toronto",
  greece: "Europe/Athens", finland: "Europe/Athens", romania: "Europe/Athens", bulgaria: "Europe/Athens", estonia: "Europe/Athens", latvia: "Europe/Athens", lithuania: "Europe/Athens", cyprus: "Europe/Athens" };
["france", "germany", "spain", "italy", "netherlands", "belgium", "austria", "switzerland", "sweden", "norway", "denmark", "poland", "czech republic", "hungary", "luxembourg", "croatia", "slovenia", "slovakia", "malta"].forEach((c) => (COUNTRY_TZ[c] = "Europe/Paris"));
// Best guess of a time zone from "Austin, TX", "Tulsa, Oklahoma", "Lagos, Nigeria", "Remote (US)"...
const US_STATE_NAMES = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY" };
function guessTz(...places) {
  for (const raw of places) {
    const s = String(raw || "").trim(); if (!s) continue;
    const low = s.toLowerCase();
    const abbr = (s.match(/\b[A-Z]{2}\b/g) || []).find((t) => US_STATE_TZ[t]);
    if (abbr) return US_STATE_TZ[abbr];
    const named = Object.keys(US_STATE_NAMES).sort((a, b) => b.length - a.length).find((n) => new RegExp("\\b" + n + "\\b").test(low));
    if (named) return US_STATE_TZ[US_STATE_NAMES[named]];
    const country = Object.keys(COUNTRY_TZ).sort((a, b) => b.length - a.length).find((n) => new RegExp("\\b" + n + "\\b").test(low));
    if (country) return COUNTRY_TZ[country];
    if (/united states?|\busa?\b/i.test(s)) return US_TZ.ET;
    if (/lagos|abuja/i.test(s)) return "Africa/Lagos";
    if (/london/i.test(s)) return "Europe/London";
    if (/kuala lumpur/i.test(s)) return "Asia/Kuala_Lumpur";
  }
  return "";
}
// Offset of a zone from UTC at a moment, in ms.
function tzOffset(ms, tz) {
  try {
    const p = {}; new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).forEach((x) => (p[x.type] = x.value));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  } catch (e) { return 0; }
}
// "2026-10-01" + "17:00" in Africa/Lagos -> UTC ms.
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = String(dateStr).split("-").map(Number), [hh, mm] = String(timeStr || "00:00").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}
const zoned = (ms, tz) => { const off = tzOffset(ms, tz); const d = new Date(ms + off); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() }; };
const pad2 = (n) => String(n).padStart(2, "0");
const ymdIn = (ms, tz) => { const z = zoned(ms, tz); return z.y + "-" + pad2(z.m + 1) + "-" + pad2(z.d); };
const hmIn = (ms, tz) => { const z = zoned(ms, tz); return pad2(z.h) + ":" + pad2(z.min); };
const TZ_ABBR = { "Africa/Lagos": "WAT", "Asia/Kuala_Lumpur": "MYT", "Asia/Singapore": "SGT", "Asia/Dubai": "GST", "Africa/Nairobi": "EAT", "Africa/Johannesburg": "SAST", "Asia/Kolkata": "IST" };
function tzAbbr(ms, tz) {
  if (TZ_ABBR[tz]) return TZ_ABBR[tz];
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName").value; } catch (e) { return tz; }
}
const fmtDay = (ms, tz) => { try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(ms)); } catch (e) { return fdate(ms); } };
const fmtDayLong = (ms, tz) => { try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(ms)); } catch (e) { return fdate(ms); } };
const tzLabel = (tz) => (TZ_OPTIONS.find(([z]) => z === tz) || [tz, String(tz || "").replace(/_/g, " ")])[1];
const ROUNDS = ["1st round", "2nd round", "3rd round", "Final round", "Technical test", "Phone screen", "Other"];
const nextRound = (r) => ({ "Phone screen": "1st round", "1st round": "2nd round", "2nd round": "3rd round", "3rd round": "Final round" }[r] || r);
const IV_STATUS = { scheduled: "Scheduled", done: "Took place", no_show: "Candidate no-show", client_cancelled: "Client cancelled", rescheduled: "To be rescheduled", cancelled: "Cancelled" };
const IV_DECISION = { next_round: "Through to next round", offer: "Offer", client_reject: "Client reject", waiting: "Waiting for feedback" };
const WHERE = { meet: "Google Meet", link: "Client's video link", phone: "Phone", in_person: "In person" };
const ivJobOf = (iv, S) => S.jobs.find((j) => j.id === iv.jobId) || null;
const ivCandOf = (iv, S) => S.cands.find((c) => c.id === iv.candidateId) || null;
const needsOutcome = (iv) => iv.status === "scheduled" && iv.end < Date.now();
// Clashes: two upcoming interviews overlapping for the same recruiter or the same candidate.
function clashesOf(list) {
  const out = new Set(); const live = list.filter((i) => i.status === "scheduled").sort((a, b) => a.start - b.start);
  for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length && live[b].start < live[a].end; b++) {
    if ((live[a].recruiterId && live[a].recruiterId === live[b].recruiterId) || live[a].candidateId === live[b].candidateId) { out.add(live[a].id); out.add(live[b].id); }
  }
  return out;
}
function ivTone(iv, clash) {
  if (iv.status !== "scheduled" || iv.end < Date.now()) return { bg: "#EFEBE1", fg: "#3E4742", border: "transparent" };
  const base = iv.confirmed ? { bg: C.emTint, fg: "#14503C" } : { bg: C.warnBg, fg: "#7A4B05" };
  return { ...base, border: clash ? C.dangerFg : "transparent" };
}

function GoogleChip({ S }) {
  const [st, setSt] = useState(null);
  React.useEffect(() => { S.ivQuiet("google_status", {}).then(setSt).catch(() => setSt({ error: true })); }, []); // eslint-disable-line
  if (!st || st.error) return null;
  const ok = st.connected && !st.lastError;
  return (
    <button onClick={() => S.goProfile && S.goProfile("calendar")} className="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs md:text-sm" style={{ borderColor: C.line, background: "#fff", color: C.ink }}>
      <span className="w-2 h-2 rounded-full" style={{ background: ok ? C.em : st.connected ? C.dangerFg : "#B9B5AA" }} />
      {st.connected ? (st.lastError ? "Google Calendar needs attention" : "Google Calendar connected") : "Connect Google Calendar"}
    </button>
  );
}

// Week grid: the viewer's own time zone; overlapping interviews sit side by side.
function WeekGrid({ days, list, clash, onOpen }) {
  const HOUR = 52;
  const inDay = (d) => list.filter((iv) => ymdIn(iv.start, MY_TZ) === d.ymd);
  const mins = list.flatMap((iv) => { const z = zoned(iv.start, MY_TZ); return [z.h, Math.ceil((z.h * 60 + z.min + iv.durationMin) / 60)]; });
  const from = Math.min(8, ...mins), to = Math.max(19, ...mins.map((m) => Math.min(m, 24)));
  const hours = []; for (let h = from; h < to; h++) hours.push(h);
  const now = Date.now(), todayYmd = ymdIn(now, MY_TZ), nz = zoned(now, MY_TZ);
  const lay = (items) => {
    const sorted = items.slice().sort((a, b) => a.start - b.start); const lanes = []; const pos = {};
    sorted.forEach((iv) => { let l = lanes.findIndex((end) => end <= iv.start); if (l < 0) { l = lanes.length; lanes.push(0); } lanes[l] = iv.end; pos[iv.id] = l; });
    return { pos, n: Math.max(1, lanes.length) };
  };
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: 60 + days.length * 84 }}>
        <div className="grid gap-1.5 pb-2 text-xs" style={{ gridTemplateColumns: `44px repeat(${days.length}, minmax(0, 1fr))`, borderBottom: `1px solid ${C.line}`, color: C.ink2 }}>
          <div />
          {days.map((d) => (
            <div key={d.ymd} className="px-1.5 flex items-center gap-1.5">{d.wd}
              <span className={d.ymd === todayYmd ? "rounded-full px-2 font-semibold" : "font-semibold"} style={d.ymd === todayYmd ? { background: C.em, color: "#fff" } : { color: C.ink, fontSize: 14 }}>{d.d}</span>
            </div>
          ))}
        </div>
        <div className="grid gap-1.5 mt-2" style={{ gridTemplateColumns: `44px repeat(${days.length}, minmax(0, 1fr))`, height: hours.length * HOUR }}>
          <div className="relative">{hours.map((h, i) => <div key={h} className="absolute right-1.5 text-[11px]" style={{ top: i * HOUR - 6, color: C.ink2 }}>{pad2(h)}:00</div>)}</div>
          {days.map((d) => {
            const items = inDay(d); const { pos, n } = lay(items);
            return (
              <div key={d.ymd} className="relative" style={{ borderLeft: `1px solid #EFEBE1`, background: d.ymd === todayYmd ? "#FBFAF6" : "transparent" }}>
                {hours.map((h, i) => <div key={h} className="absolute left-0 right-0" style={{ top: i * HOUR, borderTop: i ? "1px dashed #F0ECE3" : "none" }} />)}
                {d.ymd === todayYmd && nz.h >= from && nz.h < to && <div className="absolute left-0 right-0" style={{ top: ((nz.h - from) * 60 + nz.min) * HOUR / 60, height: 2, background: C.dangerFg, zIndex: 2 }} />}
                {items.map((iv) => {
                  const z = zoned(iv.start, MY_TZ); const top = ((z.h - from) * 60 + z.min) * HOUR / 60; const h = Math.max(24, iv.durationMin * HOUR / 60 - 2);
                  const t = ivTone(iv, clash.has(iv.id)); const w = 100 / n;
                  return (
                    <button key={iv.id} onClick={() => onOpen(iv)} title={iv.title} className="absolute rounded-lg px-1.5 py-1 text-left overflow-hidden"
                      style={{ top, height: h, left: `calc(${pos[iv.id] * w}% + 2px)`, width: `calc(${w}% - 4px)`, background: t.bg, color: t.fg, border: `2px solid ${t.border}`, fontSize: 11, lineHeight: 1.25, zIndex: 1 }}>
                      <div className="font-semibold truncate" style={{ color: C.ink }}>{iv.candidateName}</div>
                      <div className="truncate">{hmIn(iv.start, MY_TZ)} · {iv.round}</div>
                      {h > 50 && <div className="truncate">{iv.client}</div>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthGrid({ anchor, list, clash, onOpen }) {
  const a = zoned(anchor, MY_TZ); const first = Date.UTC(a.y, a.m, 1); const startWd = (new Date(first).getUTCDay() + 6) % 7;
  const daysIn = new Date(Date.UTC(a.y, a.m + 1, 0)).getUTCDate(); const cells = [];
  for (let i = 0; i < startWd; i++) cells.push(null);
  for (let d = 1; d <= daysIn; d++) cells.push(a.y + "-" + pad2(a.m + 1) + "-" + pad2(d));
  while (cells.length % 7) cells.push(null);
  const todayYmd = ymdIn(Date.now(), MY_TZ);
  return (
    <div className="overflow-x-auto"><div style={{ minWidth: 640 }}>
      <div className="grid grid-cols-7 gap-1 text-xs mb-1" style={{ color: C.ink2 }}>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="px-1.5">{d}</div>)}</div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((ymd, i) => {
          const items = ymd ? list.filter((iv) => ymdIn(iv.start, MY_TZ) === ymd).sort((x, y) => x.start - y.start) : [];
          return (
            <div key={i} className="rounded-lg p-1.5 min-h-[92px]" style={{ background: ymd ? (ymd === todayYmd ? "#FBFAF6" : "#fff") : "transparent", border: ymd ? `1px solid ${C.line}` : "none" }}>
              {ymd && <div className="text-xs font-semibold mb-1" style={{ color: ymd === todayYmd ? C.em : C.ink }}>{Number(ymd.slice(8))}</div>}
              <div className="flex flex-col gap-1">
                {items.slice(0, 3).map((iv) => { const t = ivTone(iv, clash.has(iv.id)); return (
                  <button key={iv.id} onClick={() => onOpen(iv)} className="text-left rounded px-1.5 py-0.5 text-[11px] truncate" style={{ background: t.bg, color: C.ink, border: `1.5px solid ${t.border}` }}>{hmIn(iv.start, MY_TZ)} {iv.candidateName}</button>
                ); })}
                {items.length > 3 && <div className="text-[11px]" style={{ color: C.ink2 }}>+{items.length - 3} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div></div>
  );
}

function IvRow({ iv, onOpen, clash, showDate = true }) {
  return (
    <button onClick={() => onOpen(iv)} className="w-full text-left rounded-xl border p-3 flex flex-col gap-0.5" style={{ borderColor: clash ? C.dangerFg : C.line, background: "#fff" }}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-semibold">{showDate ? fmtDay(iv.start, MY_TZ) + " · " : ""}{hmIn(iv.start, MY_TZ)}–{hmIn(iv.end, MY_TZ)}</span>
        {needsOutcome(iv) ? <Pill tone="neutral">Needs outcome</Pill> : iv.status === "scheduled" ? <Pill tone={iv.confirmed ? "em" : "warn"}>{iv.confirmed ? "Confirmed" : "Not confirmed"}</Pill> : <Pill tone={iv.status === "no_show" ? "danger" : "neutral"}>{iv.decision ? IV_DECISION[iv.decision] : IV_STATUS[iv.status]}</Pill>}
      </div>
      <div className="text-sm">{iv.candidateName}</div>
      <div className="text-xs" style={{ color: C.ink2 }}>{[iv.round, iv.roleTitle, iv.client].filter(Boolean).join(" · ")}</div>
      {iv.status === "scheduled" && !needsOutcome(iv) && iv.candidateTz && iv.candidateTz !== MY_TZ && <div className="text-xs" style={{ color: C.ink2 }}>Candidate: {hmIn(iv.start, iv.candidateTz)} {tzAbbr(iv.start, iv.candidateTz)}{iv.clientTz && iv.clientTz !== iv.candidateTz ? " · Client: " + hmIn(iv.start, iv.clientTz) + " " + tzAbbr(iv.start, iv.clientTz) : ""}</div>}
    </button>
  );
}

function InterviewsPage({ S, toast }) {
  const [view, setView] = useState("week");
  const [anchor, setAnchor] = useState(Date.now());
  const [rec, setRec] = useState("All");
  const [client, setClient] = useState("All");
  const [open, setOpen] = useState(null);
  const [sched, setSched] = useState(null);
  const all = S.interviews || [];
  const list = all.filter((iv) => (rec === "All" || iv.recruiterId === rec) && (client === "All" || iv.client === client) && iv.status !== "cancelled");
  const clash = clashesOf(list);
  const clients = [...new Set(all.map((i) => i.client).filter(Boolean))].sort();
  const recs = [...new Map(all.filter((i) => i.recruiterId).map((i) => [i.recruiterId, i.recruiter])).entries()];
  // Week starting Monday, in the viewer's zone.
  const az = zoned(anchor, MY_TZ); const mondayUtc = Date.UTC(az.y, az.m, az.d) - ((az.wd + 6) % 7) * 864e5;
  const week = [0, 1, 2, 3, 4, 5, 6].map((i) => { const d = new Date(mondayUtc + i * 864e5); return { ymd: d.toISOString().slice(0, 10), d: d.getUTCDate(), wd: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getUTCDay()] }; });
  const days = week.filter((d, i) => i < 5 || list.some((iv) => ymdIn(iv.start, MY_TZ) === d.ymd));
  const step = (dir) => setAnchor((a) => { if (view === "month") { const z = zoned(a, MY_TZ); return Date.UTC(z.y, z.m + dir, 15, 12); } return a + dir * 7 * 864e5; });
  const rangeLabel = view === "month" ? new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(Date.UTC(az.y, az.m, 15)))
    : fmtDay(Date.parse(week[0].ymd + "T12:00:00Z"), "UTC") + " – " + fmtDay(Date.parse(week[6].ymd + "T12:00:00Z"), "UTC");
  const todayYmd = ymdIn(Date.now(), MY_TZ);
  const today = list.filter((iv) => ymdIn(iv.start, MY_TZ) === todayYmd && iv.status === "scheduled").sort((a, b) => a.start - b.start);
  const upcoming = list.filter((iv) => iv.status === "scheduled" && iv.end >= Date.now()).sort((a, b) => a.start - b.start);
  const outcome = list.filter(needsOutcome).sort((a, b) => b.start - a.start);
  const unconfirmed = upcoming.filter((iv) => !iv.confirmed && iv.start - Date.now() < 48 * 3600e3);
  const gErr = upcoming.filter((iv) => iv.googleError);
  const clashList = upcoming.filter((iv) => clash.has(iv.id));
  const liveOpen = open ? all.find((x) => x.id === open.id) || open : null;
  const selSt = "rounded-lg border px-2 py-1.5 text-sm bg-white";
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="Interviews" sub={"Every client interview across your candidates. Times are in your time zone (" + tzLabel(MY_TZ) + ")."} />
        <div className="flex gap-2 flex-wrap items-center"><GoogleChip S={S} /><Btn kind="primary" icon={Plus} onClick={() => setSched({})}>Schedule interview</Btn></div>
      </div>
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <Tabs tabs={[{ key: "week", label: "Week" }, { key: "month", label: "Month" }, { key: "list", label: "Upcoming list" }]} active={view} setActive={setView} />
        {view !== "list" && <div className="flex items-center gap-2 text-sm">
          <button aria-label="Previous" onClick={() => step(-1)} className="w-8 h-8 rounded-lg border bg-white flex items-center justify-center" style={{ borderColor: C.line }}><ChevronLeft size={16} /></button>
          <span className="font-semibold min-w-[150px] text-center">{rangeLabel}</span>
          <button aria-label="Next" onClick={() => step(1)} className="w-8 h-8 rounded-lg border bg-white flex items-center justify-center" style={{ borderColor: C.line }}><ChevronRight size={16} /></button>
          <button onClick={() => setAnchor(Date.now())} className="rounded-lg border bg-white px-3 py-1.5" style={{ borderColor: C.line }}>Today</button>
        </div>}
        <div className="flex gap-2 flex-wrap">
          <label className="text-xs flex items-center gap-1.5" style={{ color: C.ink2 }}>Recruiter<select value={rec} onChange={(e) => setRec(e.target.value)} className={selSt} style={{ borderColor: C.line }}><option value="All">Everyone</option>{recs.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
          <label className="text-xs flex items-center gap-1.5" style={{ color: C.ink2 }}>Client<select value={client} onChange={(e) => setClient(e.target.value)} className={selSt} style={{ borderColor: C.line }}><option value="All">All clients</option>{clients.map((c) => <option key={c}>{c}</option>)}</select></label>
        </div>
      </div>
      <div className="flex flex-col xl:flex-row gap-5">
        <Card className="flex-1 min-w-0">
          {view === "week" && <WeekGrid days={days} list={list} clash={clash} onOpen={setOpen} />}
          {view === "month" && <MonthGrid anchor={anchor} list={list} clash={clash} onOpen={setOpen} />}
          {view === "list" && (
            <div className="flex flex-col gap-2">
              {upcoming.length ? upcoming.map((iv) => <IvRow key={iv.id} iv={iv} clash={clash.has(iv.id)} onOpen={setOpen} />) : <div className="text-sm" style={{ color: C.ink2 }}>No upcoming interviews.</div>}
            </div>
          )}
          {view !== "list" && <div className="flex flex-wrap gap-4 text-xs mt-3" style={{ color: C.ink2 }}>
            {[[C.emTint, "transparent", "Candidate confirmed"], [C.warnBg, "transparent", "Waiting for candidate"], ["#EFEBE1", "transparent", "Done"], ["#fff", C.dangerFg, "Clash"]].map(([bg, b, l]) => <span key={l} className="flex items-center gap-1.5"><span className="w-3 h-3 rounded" style={{ background: bg, border: `2px solid ${b}` }} />{l}</span>)}
          </div>}
        </Card>
        <div className="xl:w-[300px] shrink-0 flex flex-col gap-4">
          <Card>
            <SectionTitle title="Today" size="text-xl" />
            <div className="flex flex-col gap-2 mt-3">{today.length ? today.map((iv) => <IvRow key={iv.id} iv={iv} clash={clash.has(iv.id)} onOpen={setOpen} showDate={false} />) : <div className="text-sm" style={{ color: C.ink2 }}>No interviews today.</div>}</div>
          </Card>
          {(outcome.length + clashList.length + unconfirmed.length + gErr.length) > 0 && (
            <Card>
              <SectionTitle title="Needs attention" size="text-xl" />
              <div className="flex flex-col gap-2 mt-3 text-sm">
                {clashList.slice(0, 4).map((iv) => <button key={"c" + iv.id} onClick={() => setOpen(iv)} className="text-left rounded-lg px-3 py-2" style={{ background: C.dangerBg, color: "#8E3320" }}>Clash: {iv.candidateName}, {fmtDay(iv.start, MY_TZ)} {hmIn(iv.start, MY_TZ)}</button>)}
                {outcome.slice(0, 5).map((iv) => <button key={"o" + iv.id} onClick={() => setOpen(iv)} className="text-left rounded-lg px-3 py-2" style={{ background: C.neutralBg, color: "#3E4742" }}>{iv.candidateName}'s {iv.round.toLowerCase()} needs an outcome</button>)}
                {unconfirmed.slice(0, 4).map((iv) => <button key={"u" + iv.id} onClick={() => setOpen(iv)} className="text-left rounded-lg px-3 py-2" style={{ background: C.warnBg, color: "#7A4B05" }}>{iv.candidateName} hasn't confirmed {fmtDay(iv.start, MY_TZ)}</button>)}
                {gErr.slice(0, 3).map((iv) => <button key={"g" + iv.id} onClick={() => setOpen(iv)} className="text-left rounded-lg px-3 py-2" style={{ background: C.dangerBg, color: "#8E3320" }}>Not in Google Calendar: {iv.candidateName}</button>)}
              </div>
            </Card>
          )}
        </div>
      </div>
      {liveOpen && <InterviewModal iv={liveOpen} S={S} toast={toast} onClose={() => setOpen(null)} onReschedule={(iv) => { setOpen(null); setSched({ edit: iv }); }} onBookNext={(p) => { setOpen(null); setSched({ preset: p }); }} />}
      {sched && <ScheduleModal S={S} toast={toast} edit={sched.edit} preset={sched.preset} onClose={() => setSched(null)} />}
    </div>
  );
}

// Schedule or reschedule.
function ScheduleModal({ S, toast, onClose, edit, preset }) {
  const p = preset || {};
  const init = edit ? { candidateId: edit.candidateId, jobId: edit.jobId || "", round: edit.round, recruiterId: edit.recruiterId || S.me.id,
    tz: edit.schedulerTz || MY_TZ, date: ymdIn(edit.start, edit.schedulerTz || MY_TZ), time: hmIn(edit.start, edit.schedulerTz || MY_TZ), duration: edit.durationMin,
    candTz: edit.candidateTz || "", clientTz: edit.clientTz || "", where: edit.locationType, location: edit.location || "", notes: edit.notes || "", notify: edit.sendReminders !== false }
    : { candidateId: p.candidateId || "", jobId: p.jobId || "", round: p.round || "1st round", recruiterId: p.recruiterId || S.me.id, tz: MY_TZ, date: "", time: "", duration: 60,
      candTz: "", clientTz: "", where: p.where || "meet", location: p.location || "", notes: "", notify: true };
  const [f, setF] = useState(init);
  const [moveStage, setMoveStage] = useState(true);
  const [busy, setBusy] = useState(false);
  const [g, setG] = useState(null);
  const [gBusy, setGBusy] = useState([]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const cand = S.cands.find((c) => c.id === f.candidateId) || null;
  const links = cand ? cand.jobLinks.filter((l) => l.response !== "declined") : [];
  const job = S.jobs.find((j) => j.id === f.jobId) || null;
  const link = cand && f.jobId ? cand.jobLinks.find((l) => l.jobId === f.jobId) : null;
  React.useEffect(() => { S.ivQuiet("google_status", {}).then(setG).catch(() => setG(null)); }, []); // eslint-disable-line
  // Fill in likely time zones from the candidate's and the job's locations.
  React.useEffect(() => { if (cand && !edit) set("candTz", guessTz(cand.location) || ""); }, [f.candidateId]); // eslint-disable-line
  React.useEffect(() => { if (!edit) set("clientTz", job ? guessTz(job.location, job.country) || "" : ""); }, [f.jobId]); // eslint-disable-line
  React.useEffect(() => { if (cand && !f.jobId && links.length === 1 && !edit) set("jobId", links[0].jobId); }, [f.candidateId]); // eslint-disable-line
  const start = f.date && f.time ? zonedToUtc(f.date, f.time, f.tz) : null;
  const end = start ? start + Number(f.duration) * 60000 : null;
  // Busy times in the recruiter's Google Calendar that day.
  React.useEffect(() => {
    if (!start) { setGBusy([]); return; }
    const dayStart = zonedToUtc(f.date, "00:00", f.tz);
    S.ivQuiet("busy", { recruiterId: f.recruiterId, timeMin: new Date(dayStart).toISOString(), timeMax: new Date(dayStart + 864e5).toISOString() }).then((r) => setGBusy(r.busy || [])).catch(() => setGBusy([]));
  }, [f.date, f.recruiterId, f.tz]); // eslint-disable-line
  const others = (S.interviews || []).filter((iv) => iv.status === "scheduled" && (!edit || iv.id !== edit.id) && start && iv.start < end && iv.end > start);
  const clashes = [
    ...others.filter((iv) => iv.recruiterId === f.recruiterId).map((iv) => (f.recruiterId === S.me.id ? "You already have " : (S.users.find((u) => u.id === f.recruiterId) || {}).name + " already has ") + iv.candidateName + " (" + iv.round + ") " + hmIn(iv.start, MY_TZ) + "–" + hmIn(iv.end, MY_TZ) + ".")
    , ...others.filter((iv) => iv.candidateId === f.candidateId && iv.recruiterId !== f.recruiterId).map((iv) => iv.candidateName + " already has an interview " + hmIn(iv.start, MY_TZ) + "–" + hmIn(iv.end, MY_TZ) + "."),
    ...(start && gBusy.some((b) => Date.parse(b.start) < end && Date.parse(b.end) > start) && !others.length ? ["Busy in Google Calendar at that time."] : []),
  ];
  const staffUsers = (S.users || []).filter((u) => u.status === "Active" || !u.status);
  const meetNeedsGoogle = f.where === "meet" && g && !g.connected;
  const valid = cand && f.date && f.time && (f.where === "meet" || f.where === "phone" || (f.location || "").trim());
  const save = async () => {
    if (!valid) { toast(!cand ? "Pick a candidate" : !f.date || !f.time ? "Pick a date and time" : "Add the link or address"); return; }
    setBusy(true);
    const payload = { round: f.round, starts_at: new Date(start).toISOString(), duration_min: Number(f.duration), location_type: f.where, location: f.where === "meet" ? null : (f.location || "").trim() || null,
      notes: f.notes.trim() || null, recruiter_id: f.recruiterId, scheduler_tz: f.tz, candidate_tz: f.candTz || null, client_tz: f.clientTz || null, send_reminders: !!f.notify };
    try {
      const r = edit ? await S.iv("update", { id: edit.id, patch: payload, notifyCandidate: f.notify })
        : await S.iv("create", { ...payload, candidate_id: f.candidateId, job_id: f.jobId || null, link_id: link ? link.id : null, moveStage: moveStage && !!link, notifyCandidate: f.notify });
      const iv = r.interview || {};
      toast((edit ? "Interview updated" : "Interview scheduled") + (r.emailed ? ". " + cand.name.split(" ")[0] + " has been emailed." : "") + (iv.google_error ? " (Google Calendar: " + iv.google_error + ")" : ""));
      onClose();
    } catch (e) { S.error(e.message); }
    setBusy(false);
  };
  const inp = "w-full mt-1.5 rounded-lg border px-3 py-2.5 text-sm outline-none";
  const inpS = { borderColor: C.line, background: "#FAF8F3" };
  const lbl = "text-xs font-medium";
  const zoneRow = (label, tz) => tz ? <div><div className="text-[11px]" style={{ color: C.ink2 }}>{label}</div><div className="text-sm font-semibold">{start ? hmIn(start, tz) + " " + tzAbbr(start, tz) : "–"}</div></div> : null;
  return (
    <Modal open onClose={onClose} title={edit ? "Reschedule interview" : "Schedule an interview"} wide>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><label className={lbl} style={{ color: C.ink2 }}>Candidate</label>
            <select value={f.candidateId} disabled={!!edit} onChange={(e) => setF((x) => ({ ...x, candidateId: e.target.value, jobId: "" }))} className={inp} style={inpS}>
              <option value="">Choose a candidate…</option>
              {S.cands.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div><label className={lbl} style={{ color: C.ink2 }}>Role</label>
            <select value={f.jobId} disabled={!!edit} onChange={(e) => set("jobId", e.target.value)} className={inp} style={inpS}>
              <option value="">{cand ? (links.length ? "Choose a role…" : "No role linked yet") : "Pick a candidate first"}</option>
              {links.map((l) => { const j = S.jobs.find((x) => x.id === l.jobId); return j ? <option key={l.id} value={j.id}>{j.role} · {j.client}</option> : null; })}
            </select></div>
          <div><label className={lbl} style={{ color: C.ink2 }}>Round</label>
            <select value={f.round} onChange={(e) => set("round", e.target.value)} className={inp} style={inpS}>{(ROUNDS.includes(f.round) ? ROUNDS : [f.round, ...ROUNDS]).map((r) => <option key={r}>{r}</option>)}</select></div>
          <div><label className={lbl} style={{ color: C.ink2 }}>Recruiter</label>
            <select value={f.recruiterId} onChange={(e) => set("recruiterId", e.target.value)} className={inp} style={inpS}>
              {staffUsers.map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === S.me.id ? " (you)" : ""}</option>)}
              {!staffUsers.some((u) => u.id === f.recruiterId) && <option value={f.recruiterId}>{S.me.name}</option>}
            </select></div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div><label className={lbl} style={{ color: C.ink2 }}>Date</label><input type="date" value={f.date} onChange={(e) => set("date", e.target.value)} className={inp} style={inpS} /></div>
          <div><label className={lbl} style={{ color: C.ink2 }}>Start</label><input type="time" value={f.time} onChange={(e) => set("time", e.target.value)} className={inp} style={inpS} /></div>
          <div><label className={lbl} style={{ color: C.ink2 }}>Length</label><select value={f.duration} onChange={(e) => set("duration", e.target.value)} className={inp} style={inpS}>{[15, 30, 45, 60, 75, 90, 120, 180].map((m) => <option key={m} value={m}>{m < 60 ? m + " min" : m / 60 + (m === 60 ? " hour" : " hours")}</option>)}</select></div>
          <div><label className={lbl} style={{ color: C.ink2 }}>In time zone</label><select value={f.tz} onChange={(e) => set("tz", e.target.value)} className={inp} style={inpS}>{TZ_OPTIONS.map(([z, l]) => <option key={z} value={z}>{l}</option>)}</select></div>
        </div>
        <div className="rounded-xl p-3 grid grid-cols-1 sm:grid-cols-3 gap-3" style={{ background: C.canvas }}>
          {zoneRow("You · " + tzLabel(MY_TZ), MY_TZ)}
          <div><div className="text-[11px]" style={{ color: C.ink2 }}>Candidate{cand && cand.location ? " · " + cand.location : ""}</div>
            <select aria-label="Candidate's time zone" value={f.candTz} onChange={(e) => set("candTz", e.target.value)} className="text-xs rounded border bg-white px-1.5 py-1 mt-0.5 max-w-full" style={{ borderColor: C.line }}><option value="">Not sure</option>{TZ_OPTIONS.map(([z, l]) => <option key={z} value={z}>{l}</option>)}</select>
            {f.candTz && start && <div className="text-sm font-semibold mt-0.5">{hmIn(start, f.candTz)} {tzAbbr(start, f.candTz)}</div>}</div>
          <div><div className="text-[11px]" style={{ color: C.ink2 }}>Client{job && job.location ? " · " + job.location : ""}</div>
            <select aria-label="Client's time zone" value={f.clientTz} onChange={(e) => set("clientTz", e.target.value)} className="text-xs rounded border bg-white px-1.5 py-1 mt-0.5 max-w-full" style={{ borderColor: C.line }}><option value="">Not sure</option>{TZ_OPTIONS.map(([z, l]) => <option key={z} value={z}>{l}</option>)}</select>
            {f.clientTz && start && <div className="text-sm font-semibold mt-0.5">{hmIn(start, f.clientTz)} {tzAbbr(start, f.clientTz)}</div>}</div>
        </div>
        <div>
          <div className={lbl} style={{ color: C.ink2 }}>Where</div>
          <div className="flex gap-1.5 flex-wrap mt-1.5">{Object.entries(WHERE).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={f.where === k} onClick={() => set("where", k)} className="rounded-full px-3.5 py-2 text-sm" style={f.where === k ? { background: C.ink, color: "#fff" } : { border: "1px solid #D5D2C7", color: C.ink2, background: "#fff" }}>{k === "meet" ? "Google Meet (created for you)" : l}</button>
          ))}</div>
          {meetNeedsGoogle && <div className="text-xs mt-2 rounded-lg px-3 py-2" style={{ background: C.warnBg, color: "#7A4B05" }}>Connect Google Calendar on My profile to create Meet links automatically. Until then, pick "Client's video link" and paste one.</div>}
          {f.where !== "meet" && <input value={f.location} onChange={(e) => set("location", e.target.value)} placeholder={f.where === "link" ? "Paste the Zoom, Teams or Meet link" : f.where === "phone" ? "Who calls whom, and the number (optional)" : "Address"} className={inp} style={inpS} />}
        </div>
        <div><label className={lbl} style={{ color: C.ink2 }}>Client interviewers and notes (internal, never sent to the candidate)</label>
          <textarea rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inp + " resize-none"} style={inpS} /></div>
        <div className="flex flex-col gap-2 text-sm">
          {g && g.connected && <div className="flex items-center gap-2" style={{ color: C.ink2 }}><CheckCircle2 size={15} color={C.em} />Goes into {f.recruiterId === S.me.id ? "your" : "their"} Google Calendar ("ProNext interviews")</div>}
          <label className="flex items-center gap-2.5"><input type="checkbox" checked={f.notify} disabled={cand && !cand.emailAddr} onChange={(e) => set("notify", e.target.checked)} />
            {cand && !cand.emailAddr ? "No email on file, so the candidate can't be emailed" : "Email " + (cand ? cand.name.split(" ")[0] : "the candidate") + (edit ? " about any change" : " the invite") + ", with reminders 24 hours and 1 hour before"}</label>
          {!edit && link && <label className="flex items-center gap-2.5"><input type="checkbox" checked={moveStage} onChange={(e) => setMoveStage(e.target.checked)} />Move to the Interview stage for this role</label>}
        </div>
        {clashes.map((c, i) => <div key={i} className="text-sm rounded-lg px-3 py-2" style={{ background: C.dangerBg, color: "#8E3320" }}>Clash: {c}</div>)}
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={busy || !valid} onClick={save}>{busy ? <>Saving <InlineDots color="#fff" /></> : edit ? "Save changes" : "Schedule interview"}</Btn>
        </div>
      </div>
    </Modal>
  );
}

// One interview: details, actions, and the outcome form once it has happened.
function InterviewModal({ iv, S, toast, onClose, onReschedule, onBookNext }) {
  const [status, setStatus] = useState(iv.status === "scheduled" ? "done" : iv.status);
  const [decision, setDecision] = useState(iv.decision || "");
  const [feedback, setFeedback] = useState(iv.feedback || "");
  const [busy, setBusy] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [notify, setNotify] = useState(true);
  const upcoming = iv.status === "scheduled" && iv.end >= Date.now();
  const past = iv.start <= Date.now() || iv.status !== "scheduled";
  const cand = ivCandOf(iv, S);
  const first = (iv.candidateName || "").split(" ")[0];
  const run = (k, fn) => { setBusy(k); return fn().catch((e) => S.error(e.message)).finally(() => setBusy("")); };
  const [rejectOpen, setRejectOpen] = useState(false);
  const saveOutcome = (bookNext) => run("save", async () => {
    const r = await S.iv("outcome", { id: iv.id, status, decision: status === "done" ? decision || null : null, feedback });
    // A client reject records the reason and tells the candidate why, like any other reject.
    if (status === "done" && decision === "client_reject" && cand) { setRejectOpen(true); return; }
    toast("Saved" + (r.followup ? ". " + first + " has been sent the follow-up." : ""));
    if (bookNext) onBookNext({ candidateId: iv.candidateId, jobId: iv.jobId, round: status === "rescheduled" || status === "no_show" || status === "client_cancelled" ? iv.round : nextRound(iv.round), recruiterId: iv.recruiterId, where: iv.locationType, location: iv.locationType === "meet" ? "" : iv.location });
    else onClose();
  });
  const doCancel = () => run("cancel", () => S.iv("cancel", { id: iv.id, notifyCandidate: notify }).then((r) => { toast("Interview cancelled" + (r.emailed ? ". " + first + " has been told." : "")); setCancelOpen(false); onClose(); }));
  const copy = () => {
    const t = [iv.round + ": " + iv.candidateName + (iv.roleTitle ? " – " + iv.roleTitle : "") + (iv.client ? " (" + iv.client + ")" : ""),
      fmtDayLong(iv.start, MY_TZ) + ", " + hmIn(iv.start, MY_TZ) + "–" + hmIn(iv.end, MY_TZ) + " " + tzAbbr(iv.start, MY_TZ),
      iv.candidateTz && iv.candidateTz !== MY_TZ ? "Candidate: " + hmIn(iv.start, iv.candidateTz) + " " + tzAbbr(iv.start, iv.candidateTz) : "",
      iv.clientTz && iv.clientTz !== MY_TZ ? "Client: " + hmIn(iv.start, iv.clientTz) + " " + tzAbbr(iv.start, iv.clientTz) : "",
      WHERE[iv.locationType] + (iv.locationType === "meet" ? (iv.meetUrl ? ": " + iv.meetUrl : "") : iv.location ? ": " + iv.location : "")].filter(Boolean).join("\n");
    copyText(t, toast, "Details copied");
  };
  const pill = (on, label, onClick, tone) => <button key={label} type="button" aria-pressed={on} onClick={onClick} className="rounded-full px-3.5 py-2 text-sm" style={on ? { background: tone || C.ink, color: "#fff" } : { border: "1px solid #D5D2C7", color: C.ink2, background: "#fff" }}>{label}</button>;
  const joinUrl = iv.locationType === "meet" ? iv.meetUrl : iv.locationType === "link" ? iv.location : null;
  return (
    <Modal open onClose={onClose} title={iv.round + " · " + iv.candidateName} wide>
      <div className="flex flex-col gap-4">
        <div className="rounded-xl p-3.5 flex flex-col gap-1" style={{ background: C.canvas }}>
          <div className="text-sm font-semibold">{fmtDayLong(iv.start, MY_TZ)}, {hmIn(iv.start, MY_TZ)}–{hmIn(iv.end, MY_TZ)} {tzAbbr(iv.start, MY_TZ)}</div>
          {(iv.candidateTz && iv.candidateTz !== MY_TZ) || (iv.clientTz && iv.clientTz !== MY_TZ) ? <div className="text-xs" style={{ color: C.ink2 }}>{[iv.candidateTz && iv.candidateTz !== MY_TZ ? "Candidate " + hmIn(iv.start, iv.candidateTz) + " " + tzAbbr(iv.start, iv.candidateTz) : "", iv.clientTz && iv.clientTz !== MY_TZ ? "Client " + hmIn(iv.start, iv.clientTz) + " " + tzAbbr(iv.start, iv.clientTz) : ""].filter(Boolean).join(" · ")}</div> : null}
          <div className="text-sm" style={{ color: C.ink2 }}>{[iv.roleTitle, iv.client].filter(Boolean).join(" · ") || "No role linked"} · Recruiter {iv.recruiter || "–"}</div>
          <div className="text-sm" style={{ color: C.ink2 }}>{WHERE[iv.locationType]}{joinUrl ? <>: <a href={joinUrl} target="_blank" rel="noreferrer" style={{ color: C.em }} className="underline break-all">{joinUrl}</a></> : iv.locationType === "meet" ? " (link appears once Google Calendar is connected)" : iv.location ? ": " + iv.location : ""}</div>
          {iv.notes && <div className="text-sm mt-1" style={{ color: C.ink }}><span style={{ color: C.ink2 }}>Notes: </span>{iv.notes}</div>}
          <div className="flex flex-wrap gap-1.5 mt-1">
            {iv.status === "scheduled" && <Pill tone={iv.confirmed ? "em" : "warn"}>{iv.confirmed ? "Candidate confirmed" : "Candidate hasn't confirmed"}</Pill>}
            {iv.status !== "scheduled" && <Pill tone="neutral">{IV_STATUS[iv.status]}</Pill>}
            {iv.googleEventId && <Pill tone="info">In Google Calendar</Pill>}
            {iv.googleError && <Pill tone="danger">Google: {iv.googleError.slice(0, 60)}</Pill>}
            {iv.sendReminders && iv.status === "scheduled" && <Pill tone="neutral">Reminders on</Pill>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {cand && <Btn onClick={() => { onClose(); S.openCandidate(cand.id); }}>Open candidate</Btn>}
          <Btn icon={Copy} onClick={copy}>Copy details</Btn>
          {upcoming && <Btn onClick={() => onReschedule(iv)}>Reschedule</Btn>}
          {upcoming && <Btn onClick={() => setCancelOpen(true)}>Cancel interview</Btn>}
        </div>
        {past && (
          <div className="flex flex-col gap-3 pt-3" style={{ borderTop: `1px solid ${C.line}` }}>
            <div className="text-lg" style={{ ...SERIF }}>How did it go?</div>
            <div><div className="text-xs font-medium mb-1.5" style={{ color: C.ink2 }}>Did it happen?</div>
              <div className="flex flex-wrap gap-1.5">{pill(status === "done", "It went ahead", () => setStatus("done"))}{pill(status === "no_show", "Candidate no-show", () => setStatus("no_show"))}{pill(status === "client_cancelled", "Client cancelled", () => setStatus("client_cancelled"))}{pill(status === "rescheduled", "Rescheduled", () => setStatus("rescheduled"))}</div></div>
            {status === "no_show" && <div className="text-xs rounded-lg px-3 py-2" style={{ background: C.canvas, color: C.ink2 }}>{iv.noshowSent ? first + " was sent the follow-up on " + fdate(iv.noshowSent) + "." : "Saving sends " + first + " a short follow-up by email and on their candidate page: sorry we missed you, and if they'd like to reschedule, let us know."}</div>}
            {status === "done" && <div><div className="text-xs font-medium mb-1.5" style={{ color: C.ink2 }}>Client's decision</div>
              <div className="flex flex-wrap gap-1.5">{Object.entries(IV_DECISION).map(([k, l]) => pill(decision === k, l, () => setDecision(decision === k ? "" : k), k === "client_reject" ? C.dangerFg : C.em))}</div>
              {decision === "offer" && <div className="text-xs mt-1.5" style={{ color: C.ink2 }}>Moves them to Offer on this role.</div>}
              {decision === "client_reject" && <div className="text-xs mt-1.5" style={{ color: C.ink2 }}>Saving opens the reject form: record the client's reason and tell {first} why.</div>}
            </div>}
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Feedback</label>
              <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3 py-2.5 text-sm outline-none resize-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            <div className="flex justify-end gap-2 flex-wrap">
              <Btn disabled={!!busy} onClick={() => saveOutcome(false)}>{busy === "save" ? <>Saving <InlineDots /></> : "Save"}</Btn>
              {(decision === "next_round" || status === "rescheduled" || status === "client_cancelled") && <Btn kind="primary" disabled={!!busy} onClick={() => saveOutcome(true)}>{status === "done" ? "Save and book " + nextRound(iv.round).toLowerCase() : "Save and book a new time"}</Btn>}
            </div>
          </div>
        )}
      </div>
      {rejectOpen && cand && <RejectModal candidate={cand} kind="client" linkId={iv.linkId || undefined} S={S} toast={toast} onClose={() => { setRejectOpen(false); onClose(); }} />}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this interview?">
        <div className="flex flex-col gap-3">
          <div className="text-sm" style={{ color: C.ink2 }}>It's removed from Google Calendar and marked cancelled in ProNext.</div>
          <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Email {first} that it's cancelled</label>
          <div className="flex justify-end gap-2"><Btn onClick={() => setCancelOpen(false)}>Keep it</Btn><Btn kind="danger" disabled={!!busy} onClick={doCancel}>{busy === "cancel" ? <>Cancelling <InlineDots color="#fff" /></> : "Cancel interview"}</Btn></div>
        </div>
      </Modal>
    </Modal>
  );
}

// On the candidate's profile.
function CandidateInterviewsCard({ candidate, S, toast }) {
  const [open, setOpen] = useState(null);
  const [sched, setSched] = useState(null);
  const list = (S.interviews || []).filter((iv) => iv.candidateId === candidate.id && iv.status !== "cancelled").sort((a, b) => b.start - a.start);
  const up = list.filter((iv) => iv.status === "scheduled" && iv.end >= Date.now()).sort((a, b) => a.start - b.start);
  const rest = list.filter((iv) => !up.includes(iv));
  const clash = clashesOf(S.interviews || []);
  const liveOpen = open ? (S.interviews || []).find((x) => x.id === open.id) || open : null;
  const outcomeDue = rest.find(needsOutcome);
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <SectionTitle title="Interviews" sub={list.length ? up.length + " upcoming" : "None scheduled yet."} size="text-xl" />
        <Btn icon={Plus} className="shrink-0 text-xs px-3 py-1.5" onClick={() => setSched({ preset: { candidateId: candidate.id } })}>Schedule</Btn>
      </div>
      {outcomeDue && <button onClick={() => setOpen(outcomeDue)} className="w-full text-left text-sm rounded-lg px-3 py-2 mt-3" style={{ background: C.warnBg, color: "#7A4B05" }}>How did the {outcomeDue.round.toLowerCase()} on {fmtDay(outcomeDue.start, MY_TZ)} go? Record the outcome.</button>}
      <div className="flex flex-col gap-2 mt-3">{[...up, ...rest].slice(0, 8).map((iv) => <IvRow key={iv.id} iv={iv} clash={clash.has(iv.id)} onOpen={setOpen} />)}</div>
      {liveOpen && <InterviewModal iv={liveOpen} S={S} toast={toast} onClose={() => setOpen(null)} onReschedule={(iv) => { setOpen(null); setSched({ edit: iv }); }} onBookNext={(p) => { setOpen(null); setSched({ preset: p }); }} />}
      {sched && <ScheduleModal S={S} toast={toast} edit={sched.edit} preset={sched.preset} onClose={() => setSched(null)} />}
    </Card>
  );
}

// My profile > Calendar: connect your own Google account.
function GoogleCalendarTab({ S, toast }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState("");
  const load = () => S.ivQuiet("google_status", {}).then(setSt).catch((e) => setSt({ error: e.message }));
  React.useEffect(() => { load(); }, []); // eslint-disable-line
  const connect = () => { setBusy("connect"); S.ivQuiet("google_connect", { returnTo: window.location.origin + window.location.pathname + "?page=myProfile&tab=calendar" }).then((r) => { window.location.href = r.url; }).catch((e) => { S.error(e.message); setBusy(""); }); };
  const disconnect = () => { setBusy("off"); S.ivQuiet("google_disconnect", {}).then(() => { toast("Google Calendar disconnected"); load(); }).catch((e) => S.error(e.message)).finally(() => setBusy("")); };
  const saveSetting = (k, v) => { const settings = { ...(st.settings || {}), [k]: v }; setSt({ ...st, settings }); S.ivQuiet("google_settings", { settings }).then(() => toast("Saved")).catch((e) => S.error(e.message)); };
  if (!st) return <Card><div className="text-sm" style={{ color: C.ink2 }}>Loading<InlineDots /></div></Card>;
  const s = st.settings || {};
  return (
    <Card>
      <SectionTitle title="Google Calendar" sub="Connect your own Google account. Interviews you schedule in ProNext appear in your calendar with a Meet link, and moving or cancelling them in Google updates ProNext." size="text-lg" />
      {st.error && <div className="text-sm mt-3" style={{ color: C.dangerFg }}>{st.error}</div>}
      {!st.configured && !st.error && <div className="text-sm rounded-lg px-3 py-2.5 mt-4" style={{ background: C.warnBg, color: "#7A4B05" }}>Google sign-in isn't set up for ProNext yet. An admin needs to create the Google sign-in app and add its two keys (see supabase/INTERVIEWS_SETUP.md). Interviews still work without it; you just won't get Meet links or calendar sync.</div>}
      {st.configured && !st.connected && <Btn kind="primary" className="mt-4" disabled={!!busy} onClick={connect}>{busy === "connect" ? <>Opening Google <InlineDots color="#fff" /></> : "Connect Google Calendar"}</Btn>}
      {st.connected && (
        <div className="flex flex-col gap-3 mt-4">
          <div className="flex items-center justify-between gap-3 rounded-xl px-3.5 py-3" style={{ background: C.canvas }}>
            <div><div className="text-sm font-medium">Connected as {st.email || "your Google account"}</div><div className="text-xs" style={{ color: C.ink2 }}>Calendar: ProNext interviews{st.lastSync ? " · last synced " + ago(st.lastSync) : ""}</div></div>
            <Btn disabled={!!busy} onClick={disconnect} className="shrink-0">Disconnect</Btn>
          </div>
          {st.lastError && <div className="text-sm rounded-lg px-3 py-2" style={{ background: C.dangerBg, color: "#8E3320" }}>{st.lastError} <button className="underline" onClick={connect}>Reconnect</button></div>}
          <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" checked={s.clashCheck !== false} onChange={(e) => saveSetting("clashCheck", e.target.checked)} />Warn me about clashes with my other Google events</label>
          <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" checked={!!s.inviteCandidate} onChange={(e) => saveSetting("inviteCandidate", e.target.checked)} />Invite the candidate from Google too (they already get ProNext's email)</label>
        </div>
      )}
      <div className="text-xs mt-4" style={{ color: C.ink2 }}>ProNext only reads free/busy times and the events it created. It never reads the details of your other meetings.</div>
    </Card>
  );
}

// Candidate page: upcoming interviews and the no-show follow-up.
function PortalInterviews({ list, token, onChanged }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const confirm = (id) => { setBusy(id); setErr(""); sbFetch("/rest/v1/rpc/candidate_confirm_interview", { method: "POST", body: { p_token: token, p_interview_id: id } }).then(() => onChanged && onChanged()).catch((e) => setErr(e.message)).finally(() => setBusy("")); };
  const addToCal = (iv) => {
    const s = Date.parse(iv.startsAt), e = s + iv.durationMin * 60000;
    const f = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const clean = (t) => String(t || "").replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
    const loc = iv.locationType === "phone" ? "Phone" + (iv.location ? " " + iv.location : "") : iv.locationType === "in_person" ? iv.location || "In person" : iv.joinUrl || "Video call";
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ProNext//Interviews//EN", "BEGIN:VEVENT", "UID:" + iv.id + "@harbor", "DTSTAMP:" + f(Date.now()), "DTSTART:" + f(s), "DTEND:" + f(e),
      "SUMMARY:" + clean(iv.round + ": " + (iv.role || "Interview") + (iv.company ? " at " + iv.company : "")), "LOCATION:" + clean(loc), "DESCRIPTION:" + clean(window.location.href), "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    const a = document.createElement("a"); a.href = url; a.download = "interview.ics"; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };
  const openThread = (linkId) => { const el = document.getElementById("thread-" + linkId); if (el) { el.open = true; el.scrollIntoView({ behavior: "smooth", block: "center" }); } };
  const tz = MY_TZ;
  return (
    <>
      {err && <div className="text-sm rounded-xl px-3.5 py-2.5" style={{ background: C.dangerBg, color: C.dangerFg }}>{err}</div>}
      {list.map((iv) => {
        const s = Date.parse(iv.startsAt), e = s + iv.durationMin * 60000;
        if (iv.status === "no_show") return (
          <Card key={iv.id}>
            <Pill tone="warn">Missed interview</Pill>
            <div className="text-base font-semibold mt-2">{iv.role}</div>
            <div className="text-sm" style={{ color: C.ink2 }}>{iv.company}{iv.company ? " · " : ""}{fmtDayLong(s, tz)}, {hmIn(s, tz)} your time</div>
            <div className="text-sm mt-2" style={{ color: C.ink, lineHeight: 1.5 }}>Sorry we missed you at your interview. If you'd still like to be considered and want to reschedule, let us know and we'll ask the client for a new time.</div>
            {iv.linkId && <Btn kind="primary" full className="mt-3" onClick={() => openThread(iv.linkId)}>Message {iv.recruiter || "your recruiter"}</Btn>}
          </Card>
        );
        const days = Math.round((Date.UTC(...ymdIn(s, tz).split("-").map((x, i) => i === 1 ? x - 1 : +x)) - Date.UTC(...ymdIn(Date.now(), tz).split("-").map((x, i) => i === 1 ? x - 1 : +x))) / 864e5);
        return (
          <Card key={iv.id}>
            <div className="flex items-center justify-between gap-2"><Pill tone="em">{iv.round}</Pill><span className="text-xs" style={{ color: C.ink2 }}>{days <= 0 ? "today" : days === 1 ? "tomorrow" : "in " + days + " days"}</span></div>
            <div className="text-base font-semibold mt-2">{iv.role}</div>
            <div className="text-sm" style={{ color: C.ink2 }}>{iv.company}</div>
            <div className="rounded-xl p-3 mt-3" style={{ background: C.canvas }}>
              <div className="text-sm font-semibold">{fmtDayLong(s, tz)}</div>
              <div className="text-sm">{hmIn(s, tz)} – {hmIn(e, tz)} your time ({tzAbbr(s, tz)})</div>
              <div className="text-xs mt-1" style={{ color: C.ink2 }}>{iv.locationType === "phone" ? "Phone call" + (iv.location ? ": " + iv.location : "") : iv.locationType === "in_person" ? "In person" + (iv.location ? ": " + iv.location : "") : "Video call"}</div>
              {iv.joinUrl && <a href={iv.joinUrl} target="_blank" rel="noreferrer" className="text-sm underline break-all" style={{ color: C.em }}>Join the call</a>}
            </div>
            <div className="flex flex-col gap-2 mt-3">
              {iv.confirmed ? <div className="text-sm rounded-xl px-3.5 py-2.5 text-center" style={{ background: C.emTint, color: C.em }}>You've confirmed. See you there!</div>
                : <Btn kind="primary" full disabled={busy === iv.id} onClick={() => confirm(iv.id)}>{busy === iv.id ? <>Confirming <InlineDots color="#fff" /></> : "Yes, I'll be there"}</Btn>}
              <Btn full onClick={() => addToCal(iv)}>Add to calendar</Btn>
            </div>
            <div className="text-xs mt-3" style={{ color: C.ink2 }}>You'll get a reminder by email the day before and an hour before.{iv.linkId ? <> Questions? <button className="underline" onClick={() => openThread(iv.linkId)}>Message {iv.recruiter || "your recruiter"}</button>.</> : ""}</div>
          </Card>
        );
      })}
    </>
  );
}

/* ----------------------------------------------------------------------
   Outreach: sourcing outside ProNext (candidates) and the daily client-lead feed.
   Server side lives in the `sourcing` and `outreach-public` Edge Functions; nothing is
   sent until an email sender, a sender name and a postal address are set (Setup tab).
   ---------------------------------------------------------------------- */
const PROSPECT_TONE = { found: "info", approved: "warn", queued: "warn", contacted: "neutral", interested: "em", not_interested: "neutral", unsubscribed: "danger", bounced: "danger", rejected: "neutral", converted: "em" };
const PROSPECT_LABEL = { found: "Needs approval", approved: "Approved", queued: "Queued to send", contacted: "Emailed", interested: "Interested", not_interested: "Not interested", unsubscribed: "Unsubscribed", bounced: "Bounced", rejected: "Skipped", converted: "Converted" };
const LEAD_TONE = { new: "info", approved: "warn", queued: "warn", contacted: "neutral", replied: "em", meeting: "em", won: "em", lost: "neutral", ignored: "neutral", unsubscribed: "danger" };
const LEAD_LABEL = { new: "New", approved: "Approved", queued: "Queued to send", contacted: "Contacted", replied: "Replied", meeting: "Meeting booked", won: "Won", lost: "Lost", ignored: "Not a fit", unsubscribed: "Unsubscribed" };
const REGION_OPTIONS = [["US", "United States"], ["EU", "Europe (EU, UK, EEA, Switzerland)"], ["MY", "Malaysia"]];
const approvedMsg = (n) => (n || 0) + " email" + (n === 1 ? "" : "s") + " approved. They go out within about 10 minutes once a sender is connected.";
const copyText = (t, toast, label) => { try { navigator.clipboard.writeText(t); toast(label || "Copied"); } catch (e) { toast("Copy failed. Select and copy it manually."); } };

// Paid work (Apollo, TheirStack): an Admin confirms the cost before it runs.
function SpendConfirm({ c, onClose, busy }) {
  return (
    <Modal open={!!c} onClose={onClose} title="Approve this spend?">
      {c && <div className="flex flex-col gap-4">
        <div className="text-sm">{c.title}</div>
        <div className="text-sm rounded-lg px-3 py-2.5" style={{ background: C.warnBg, color: "#7A4B05" }}>Cost: {c.costText}. Nothing is spent until you approve.</div>
        <div className="flex gap-2 justify-end"><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn kind="primary" disabled={busy} onClick={c.go}>{busy ? <>Running <InlineDots color="#fff" /></> : "Approve and run"}</Btn></div>
      </div>}
    </Modal>
  );
}
// Runs a paid sourcing action: Admins confirm the cost first; anyone else's click goes to an
// Admin as an approval request.
function paidAction(S, toast, action, payload, setConfirm, onDone) {
  return S.sourcing(action, payload).then((r) => {
    if (r.needsConfirm) {
      setConfirm({ title: r.title, costText: r.costText, go: () => S.sourcing(action, { ...payload, confirmed: true }).then((x) => { setConfirm(null); toast(x.message || "Done"); onDone && onDone(); }).catch((e) => { setConfirm(null); S.error(e.message); }) });
      return;
    }
    toast(r.message || "Done"); onDone && onDone();
  });
}

function ApprovalsPanel({ S, toast, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const load = () => S.sourcing("list_requests", {}).then(setData).catch((e) => setData({ error: e.message }));
  React.useEffect(() => { load(); }, []); // eslint-disable-line
  const act = (id, action) => { setBusy(id + action); S.sourcing(action, { id }).then((r) => toast(r.message || (action === "approve_request" ? "Approved" : "Declined"))).catch((e) => S.error(e.message)).finally(() => { setBusy(""); load(); onChanged && onChanged(); }); };
  if (!data) return <Card><div className="text-sm" style={{ color: C.ink2 }}>Loading<InlineDots /></div></Card>;
  if (data.error) return <Card><div className="text-sm" style={{ color: C.dangerFg }}>{data.error}</div></Card>;
  const pending = data.requests.filter((r) => r.status === "pending"), done = data.requests.filter((r) => r.status !== "pending");
  const who = (id) => (S.users.find((u) => u.id === id) || {}).name || "";
  const tone = { approved: "info", done: "em", declined: "neutral", failed: "danger" };
  const label = { approved: "Running", done: "Done", declined: "Declined", failed: "Failed" };
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle title="Waiting for approval" sub={"Anything that uses paid credits (Apollo, TheirStack) waits here until an Admin approves it. Admins are emailed when a request comes in." + (data.canApprove ? "" : " Only an Admin can approve.")} size="text-xl" />
        <div className="flex flex-col gap-2 mt-3">
          {pending.length ? pending.map((r) => (
            <div key={r.id} className="rounded-xl border p-3 flex flex-col sm:flex-row sm:items-center gap-3" style={{ borderColor: C.line }}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{r.title}</div>
                <div className="text-xs mt-0.5" style={{ color: C.ink2 }}>Cost: {r.cost_text} · {r.requested_by ? "asked by " + who(r.requested_by) : "requested automatically"} · {ago(r.created_at)}</div>
              </div>
              {data.canApprove && <div className="flex gap-2 shrink-0">
                <Btn disabled={!!busy} onClick={() => act(r.id, "decline_request")}>{busy === r.id + "decline_request" ? "Declining…" : "Decline"}</Btn>
                <Btn kind="primary" disabled={!!busy} onClick={() => act(r.id, "approve_request")}>{busy === r.id + "approve_request" ? <>Running <InlineDots color="#fff" /></> : "Approve and run"}</Btn>
              </div>}
            </div>
          )) : <div className="text-sm" style={{ color: C.ink2 }}>Nothing waiting.</div>}
        </div>
      </Card>
      {done.length > 0 && (
        <Card>
          <SectionTitle title="History" size="text-xl" />
          <div className="flex flex-col mt-2">
            {done.slice(0, 30).map((r, i) => (
              <div key={r.id} className="py-2.5 flex items-start justify-between gap-3" style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
                <div className="min-w-0"><div className="text-sm">{r.title}</div>
                  <div className="text-xs" style={{ color: C.ink2 }}>{r.cost_text}{r.decided_by ? " · " + (r.status === "declined" ? "declined" : "approved") + " by " + who(r.decided_by) : ""}{r.decided_at ? " · " + ago(r.decided_at) : ""}{r.result && r.result.message ? " · " + r.result.message : ""}{r.error ? " · " + r.error : ""}</div></div>
                <Pill tone={tone[r.status] || "neutral"}>{label[r.status] || r.status}</Pill>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// "Send it myself": until an outreach sender is connected, open the finished email (links, sender
// details and unsubscribe included) in the recruiter's own mailbox, then record it as sent.
function ManualSend({ kind, id, S, toast, onDone, label }) {
  const [mail, setMail] = useState(null);
  const [busy, setBusy] = useState(false);
  const open = () => { setBusy(true); S.sourcing("manual_compose", { kind, id }).then(setMail).catch((e) => S.error(e.message)).finally(() => setBusy(false)); };
  const done = () => { setBusy(true); S.sourcing("manual_sent", { kind, id }).then(() => { setMail(null); toast("Marked as sent"); onDone && onDone(); }).catch((e) => S.error(e.message)).finally(() => setBusy(false)); };
  const enc = encodeURIComponent;
  const gmail = mail ? "https://mail.google.com/mail/?view=cm&fs=1&to=" + enc(mail.to) + "&su=" + enc(mail.subject) + "&body=" + enc(mail.body) : "";
  const outlook = mail ? "https://outlook.office.com/mail/deeplink/compose?to=" + enc(mail.to) + "&subject=" + enc(mail.subject) + "&body=" + enc(mail.body) : "";
  const mailto = mail ? "mailto:" + enc(mail.to) + "?subject=" + enc(mail.subject) + "&body=" + enc(mail.body) : "";
  return (
    <>
      <Btn icon={Send} onClick={open} disabled={busy}>{busy && !mail ? "Preparing…" : label || "Send it myself"}</Btn>
      <Modal open={!!mail} onClose={() => setMail(null)} title="Send it from your own email">
        {mail && (
          <div className="flex flex-col gap-3">
            <div className="text-sm" style={{ color: C.ink2 }}>Open it in your mailbox and press send there. Then come back and click <b>I've sent it</b> so ProNext records it. The "I'm interested" and unsubscribe links still work.</div>
            <div className="text-sm"><span style={{ color: C.ink3 }}>To </span>{mail.toName ? mail.toName + " · " : ""}{mail.to} <button className="text-xs underline ml-1" style={{ color: C.em }} onClick={() => copyText(mail.to, toast, "Address copied")}>Copy</button></div>
            <div className="text-sm"><span style={{ color: C.ink3 }}>Subject </span>{mail.subject} <button className="text-xs underline ml-1" style={{ color: C.em }} onClick={() => copyText(mail.subject, toast, "Subject copied")}>Copy</button></div>
            <textarea readOnly value={mail.body} rows={10} className="w-full rounded-lg border px-3 py-2 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
            <div className="flex flex-wrap gap-2">
              <a href={gmail} target="_blank" rel="noreferrer"><Btn kind="primary">Open in Gmail</Btn></a>
              <a href={outlook} target="_blank" rel="noreferrer"><Btn>Open in Outlook</Btn></a>
              <a href={mailto}><Btn>Mail app</Btn></a>
              <Btn onClick={() => copyText(mail.body, toast, "Email copied")}>Copy email</Btn>
            </div>
            {mail.body.length > 6000 && <div className="text-xs" style={{ color: C.warnFg }}>This email is long, so some mail apps may cut it short when opening. If that happens, use Copy email and paste it in.</div>}
            <div className="pt-3 flex justify-end" style={{ borderTop: `1px solid ${C.line}` }}><Btn kind="primary" onClick={done} disabled={busy}>{busy ? "Saving…" : "I've sent it"}</Btn></div>
          </div>
        )}
      </Modal>
    </>
  );
}

function ProspectCard({ p, jobLabel, selected, onSelect, onSave, onStatus, canEdit, S, toast, onChanged }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(p.subject || "");
  const [body, setBody] = useState(p.body || "");
  const dirty = subject !== (p.subject || "") || body !== (p.body || "");
  const editable = canEdit && ["found", "approved"].includes(p.status);
  const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown";
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: C.line }}>
      <div className="flex items-start gap-3">
        {editable && <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="mt-1.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="min-w-0"><div className="font-medium text-sm truncate">{name}</div><div className="text-xs truncate" style={{ color: C.ink2 }}>{[p.title, p.company, p.location].filter(Boolean).join(" · ")}</div></div>
            <div className="flex items-center gap-2 shrink-0">{p.fit != null && <span className="text-sm font-medium">{p.fit}%</span>}{p.verdict && <Pill tone={VERDICT_TONE[p.verdict] || "neutral"}>{p.verdict}</Pill>}<Pill tone={PROSPECT_TONE[p.status] || "neutral"}>{PROSPECT_LABEL[p.status] || p.status}</Pill></div>
          </div>
          {jobLabel && <div className="text-xs mt-1" style={{ color: C.ink3 }}>For {jobLabel}</div>}
          {p.fit_reason && <div className="text-xs mt-1.5" style={{ color: C.ink2 }}>{p.fit_reason}</div>}
          <div className="flex gap-3 mt-2 text-xs flex-wrap">
            <button onClick={() => setOpen((o) => !o)} style={{ color: C.em }}>{open ? "Hide email" : editable ? "Review email" : "View email"}</button>
            {p.linkedin_url && <a href={p.linkedin_url} target="_blank" rel="noreferrer" style={{ color: C.em }}>LinkedIn profile</a>}
            {p.email && <span style={{ color: C.ink3 }}>{p.email}</span>}
            {p.contacted_at && <span style={{ color: C.ink3 }}>Emailed {fdate(p.contacted_at)}</span>}
          </div>
          {open && (
            <div className="mt-2 flex flex-col gap-2">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!editable} className="w-full rounded-lg border px-3 py-2 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
              <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={!editable} rows={9} className="w-full rounded-lg border px-3 py-2 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
              <div className="text-xs" style={{ color: C.ink3 }}>{"{{INTERESTED_LINK}}"} becomes a one-click "I'm interested" link. The sender details, unsubscribe link and (outside the US) the privacy notice are added at the bottom when it's sent.</div>
              {editable && <div className="flex gap-2 justify-end">{dirty && <Btn onClick={() => { setSubject(p.subject || ""); setBody(p.body || ""); }}>Undo</Btn>}<Btn kind="primary" disabled={!dirty} onClick={() => onSave({ subject, body })}>Save email</Btn></div>}
            </div>
          )}
          {canEdit && (
            <div className="flex gap-2 mt-2 justify-end flex-wrap">
              {p.status === "found" && <Btn onClick={() => onStatus("rejected")}>Skip</Btn>}
              {S && p.email && ["found", "approved", "queued"].includes(p.status) && <ManualSend kind="p" id={p.id} S={S} toast={toast} onDone={onChanged} />}
              {["contacted", "queued"].includes(p.status) && <Btn onClick={() => onStatus("not_interested")}>Not interested</Btn>}
              {["contacted", "interested"].includes(p.status) && <Btn kind="primary" onClick={() => onStatus("converted")}>Mark converted</Btn>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Job page: parallel titles, the bench result, and outside candidates found for this job.
function JobSourcingCard({ job, S, toast }) {
  const [row, setRow] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [prospects, setProspects] = useState([]);
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState({});
  const canRun = S.role === "admin" || S.role === "recops";
  const load = () => Promise.all([
    S.sb("/rest/v1/jobs?id=eq." + job.id + "&select=parallel_titles,parallel_titles_at,sourcing").then((r) => setRow((r || [])[0] || {})),
    canRun ? S.sb("/rest/v1/prospects?job_id=eq." + job.id + "&select=*&order=fit.desc.nullslast&limit=200").then((r) => setProspects(r || [])) : Promise.resolve(),
  ]).catch(() => {});
  React.useEffect(() => { load(); }, [job.id]); // eslint-disable-line
  // Search area (commutable cities, or preferred time zones for remote roles) is worked out on
  // the server the first time it's needed; no credits are spent. Fetched once here if missing.
  const [areaOpen, setAreaOpen] = useState(false);
  const [areaAsked, setAreaAsked] = useState(false);
  React.useEffect(() => {
    if (!row || areaAsked || !canRun || (row.sourcing && row.sourcing.area)) return;
    setAreaAsked(true);
    S.sourcing("search_area", { jobId: job.id }).then(() => load()).catch(() => {});
  }, [row]); // eslint-disable-line
  if (!row) return null;
  const titles = Array.isArray(row.parallel_titles) ? row.parallel_titles : [];
  const src = row.sourcing || {};
  const internal = src.internal || null, external = src.external || null;
  const run = (key, fn) => { setBusy(key); return fn().catch((e) => S.error(e.message)).finally(() => { setBusy(""); load(); }); };
  const regen = () => run("titles", () => S.aiScreen("job_titles", { jobId: job.id }).then(() => toast("Parallel titles updated")));
  const outside = (force) => run("outside", async () => {
    if (!internal) await S.aiScreen("bench_fits", { jobId: job.id });
    await paidAction(S, toast, "search_external", { jobId: job.id, force }, (c) => setConfirm(c && { ...c, go: () => { setConfirmBusy(true); Promise.resolve(c.go()).finally(() => { setConfirmBusy(false); load(); }); } }), load);
  });
  const ids = Object.keys(sel).filter((k) => sel[k]);
  const approve = () => run("approve", () => S.sourcing("approve_prospects", { ids }).then((r) => { setSel({}); toast(approvedMsg(r.queued)); }));
  const patchP = (id, body, msg) => S.sb("/rest/v1/prospects?id=eq." + id, { method: "PATCH", body }).then(() => { toast(msg); load(); }).catch((e) => S.error(e.message));
  const waiting = prospects.filter((p) => p.status === "found");
  const state = src.state;
  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <SectionTitle title="Sourcing" sub="ProNext checks your own candidates first, using the job's parallel titles. Only when there aren't enough strong fits does it look outside ProNext for people with verified emails." size="text-xl" />
        {canRun && <div className="flex gap-2 shrink-0 flex-wrap">
          <Btn kind="primary" icon={Search} onClick={() => outside(!!external)} disabled={!!busy}>{busy === "outside" ? "Searching…" : external ? "Search outside again" : "Search outside ProNext"}</Btn>
        </div>}
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between gap-2"><div className="text-xs" style={{ color: C.ink3 }}>Parallel titles for this job</div>{canRun && !titles.length && <button onClick={regen} disabled={!!busy} className="text-xs" style={{ color: C.em }}>{busy === "titles" ? "Working out…" : "Generate"}</button>}</div>
        <div className="flex flex-wrap gap-1.5 mt-1.5">{titles.length ? titles.map((t) => <Pill key={t} tone="neutral">{t}</Pill>) : <span className="text-sm" style={{ color: C.ink2 }}>Not generated yet. They're created the first time the bench is checked.</span>}</div>
      </div>
      <div className="mt-3">
        <div className="text-xs" style={{ color: C.ink3 }}>Where ProNext looks outside</div>
        {src.area && src.area.locations ? (
          <div className="text-sm mt-1">
            <span>{src.area.summary || src.area.locations.join(", ")}</span>
            {src.area.locations.length > 1 && <button onClick={() => setAreaOpen((v) => !v)} className="text-xs ml-2 underline" style={{ color: C.ink2 }}>{areaOpen ? "Hide" : "Show " + src.area.locations.length + " places"}</button>}
            {areaOpen && <div className="flex flex-wrap gap-1.5 mt-1.5">{src.area.locations.map((l) => <Pill key={l} tone="neutral">{l}</Pill>)}</div>}
            <div className="text-xs mt-1" style={{ color: C.ink2 }}>{src.area.mode === "commute" ? "The job's office plus places within about an hour's commute." : src.area.mode === "region" ? "The job is located by state only, so the whole state." : src.area.mode === "timezone" ? "Remote role: only the states in the time zones the job description prefers." : "Remote role: no time zone preference in the job description, so the whole country."}</div>
          </div>
        ) : <div className="text-sm mt-1" style={{ color: C.ink2 }}>{canRun ? <>Working it out <InlineDots /></> : "Worked out when the job goes live."}</div>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <div className="rounded-xl px-3 py-2.5" style={{ background: C.canvas }}>
          <div className="text-xs" style={{ color: C.ink3 }}>In ProNext</div>
          <div className="text-sm mt-0.5">{internal ? <>{plural(internal.goodFits || 0, "strong fit")} on the bench · {internal.considered || 0} with a matching title{internal.onRole ? " · " + internal.onRole + " already submitted to this role (not counted)" : ""} · checked {fdate(internal.at)}</> : state === "pending" ? "Queued. The bench is checked automatically within about 10 minutes." : "Not checked yet"}</div>
        </div>
        <div className="rounded-xl px-3 py-2.5" style={{ background: C.canvas }}>
          <div className="text-xs" style={{ color: C.ink3 }}>Outside ProNext</div>
          <div className="text-sm mt-0.5">{src.state === "awaiting_approval" ? "Waiting for an Admin to approve the Apollo search (Outreach > Approvals)" : external ? (external.skipped || external.error || (plural(external.found || 0, "person", "people") + " found · " + fdate(external.at))) : "Not searched yet"}</div>
        </div>
      </div>
      {canRun && prospects.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
            <div className="text-sm font-medium">People found outside ProNext <span style={{ color: C.ink3 }}>· {waiting.length} waiting for approval</span></div>
            {waiting.length > 0 && <div className="flex gap-2">
              <Btn onClick={() => setSel(ids.length === waiting.length ? {} : Object.fromEntries(waiting.map((p) => [p.id, true])))}>{ids.length === waiting.length ? "Clear" : "Select all"}</Btn>
              <Btn kind="primary" icon={Send} disabled={!ids.length || !!busy} onClick={approve}>{busy === "approve" ? "Approving…" : "Approve " + (ids.length || "") + " email" + (ids.length === 1 ? "" : "s")}</Btn>
            </div>}
          </div>
          <div className="flex flex-col gap-2">
            {prospects.map((p) => <ProspectCard key={p.id} p={p} canEdit selected={!!sel[p.id]} onSelect={(v) => setSel((m) => ({ ...m, [p.id]: v }))}
              onSave={(b) => patchP(p.id, b, "Email saved")} onStatus={(st) => patchP(p.id, { status: st }, PROSPECT_LABEL[st] || "Updated")} S={S} toast={toast} onChanged={load} />)}
          </div>
        </div>
      )}
      <SpendConfirm c={confirm} busy={confirmBusy} onClose={() => setConfirm(null)} />
    </Card>
  );
}

function LeadCard({ l, S, toast, selected, onSelect, onChanged }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ pitch_subject: l.pitch_subject || "", pitch_body: l.pitch_body || "", linkedin_message: l.linkedin_message || "", notes: l.notes || "" });
  const dirty = ["pitch_subject", "pitch_body", "linkedin_message", "notes"].some((k) => f[k] !== (l[k] || ""));
  const patch = (body, msg) => S.sb("/rest/v1/leads?id=eq." + l.id, { method: "PATCH", body }).then(() => { toast(msg); onChanged(); }).catch((e) => S.error(e.message));
  const matches = Array.isArray(l.matches) ? l.matches : [];
  const emailable = l.channel === "email" && ["new", "approved"].includes(l.status);
  const inp = "w-full rounded-lg border px-3 py-2 text-sm outline-none";
  const inpS = { borderColor: C.line, background: "#FAF8F3" };
  const convert = () => S.sourcing("convert_lead", { leadId: l.id }).then(() => { toast("Draft job created. Find it under Jobs."); onChanged(); S.reload && S.reload(); }).catch((e) => S.error(e.message));
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: C.line }}>
      <div className="flex items-start gap-3">
        {emailable && <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="mt-1.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <div className="font-medium text-sm">{l.job_title}</div>
              <div className="text-xs" style={{ color: C.ink2 }}>{[l.company, l.location, l.posted_at ? "posted " + fdate(l.posted_at) : null].filter(Boolean).join(" · ")}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Pill tone={l.channel === "email" ? "em" : l.channel === "linkedin" ? "info" : "neutral"}>{l.channel === "email" ? "Email" : l.channel === "linkedin" ? "LinkedIn" : "No contact"}</Pill>
              <select value={l.status} onChange={(e) => patch({ status: e.target.value, ...(e.target.value === "contacted" && !l.contacted_at ? { contacted_at: new Date().toISOString() } : {}) }, "Moved to " + (LEAD_LABEL[e.target.value] || e.target.value))} className="text-xs rounded-lg border px-2 py-1 bg-white" style={{ borderColor: C.line }}>
                {Object.keys(LEAD_LABEL).map((k) => <option key={k} value={k}>{LEAD_LABEL[k]}</option>)}
              </select>
            </div>
          </div>
          <div className="text-xs mt-1.5" style={{ color: C.ink2 }}>
            {l.contact_name ? <>Contact: <span className="font-medium" style={{ color: C.ink }}>{l.contact_name}</span>{l.contact_role ? ", " + l.contact_role : ""}{l.contact_email ? " · " + l.contact_email : ""}</> : "No hiring contact listed on the posting."}
          </div>
          {matches.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {matches.map((m, i) => { const c = S.cands.find((x) => x.id === m.candidate_id); return (
                <div key={i} className="rounded-lg px-3 py-2 text-xs" style={{ background: C.canvas }}>
                  <div className="flex items-center justify-between gap-2"><button className="font-medium truncate text-left" onClick={() => c && S.openCandidate(c.id)} style={{ color: c ? C.em : C.ink }}>{c ? c.name : "Candidate"}</button><span className="shrink-0">{m.fit}% · {m.verdict}</span></div>
                  {(m.bullets || []).length > 0 && <div className="mt-1" style={{ color: C.ink2 }}>{m.bullets.join(" · ")}</div>}
                </div>
              ); })}
            </div>
          )}
          {l.status === "ignored" && l.notes && <div className="text-xs mt-1.5" style={{ color: C.ink3 }}>{l.notes}</div>}
          <div className="flex gap-3 mt-2 text-xs flex-wrap">
            <button onClick={() => setOpen((o) => !o)} style={{ color: C.em }}>{open ? "Hide messages" : "Messages and notes"}</button>
            {l.url && <a href={l.url} target="_blank" rel="noreferrer" style={{ color: C.em }}>Job posting</a>}
            {l.contact_linkedin && <a href={l.contact_linkedin} target="_blank" rel="noreferrer" style={{ color: C.em }}>Contact's LinkedIn</a>}
            {l.contacted_at && <span style={{ color: C.ink3 }}>Contacted {fdate(l.contacted_at)}</span>}
          </div>
          {open && (
            <div className="mt-2 flex flex-col gap-2">
              <label className="text-xs font-medium" style={{ color: C.ink2 }}>Email subject</label>
              <input value={f.pitch_subject} onChange={(e) => setF({ ...f, pitch_subject: e.target.value })} className={inp} style={inpS} />
              <label className="text-xs font-medium" style={{ color: C.ink2 }}>Email</label>
              <textarea rows={8} value={f.pitch_body} onChange={(e) => setF({ ...f, pitch_body: e.target.value })} className={inp} style={inpS} />
              <label className="text-xs font-medium" style={{ color: C.ink2 }}>LinkedIn message <span style={{ color: C.ink3 }}>({f.linkedin_message.length}/300, you send this yourself)</span></label>
              <textarea rows={3} value={f.linkedin_message} onChange={(e) => setF({ ...f, linkedin_message: e.target.value })} className={inp} style={inpS} />
              <label className="text-xs font-medium" style={{ color: C.ink2 }}>Notes</label>
              <textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className={inp} style={inpS} />
              {dirty && <div className="flex justify-end"><Btn kind="primary" onClick={() => patch(f, "Saved")}>Save</Btn></div>}
            </div>
          )}
          <div className="flex gap-2 mt-2 justify-end flex-wrap">
            {l.channel === "email" && l.contact_email && ["new", "approved", "queued"].includes(l.status) && <ManualSend kind="l" id={l.id} S={S} toast={toast} onDone={onChanged} />}
            {l.channel === "linkedin" && ["new", "approved"].includes(l.status) && <>
              <Btn icon={Copy} onClick={() => { copyText(f.linkedin_message, toast, "Message copied. Paste it on LinkedIn."); if (l.contact_linkedin) window.open(l.contact_linkedin, "_blank"); }}>Copy and open LinkedIn</Btn>
              <Btn kind="primary" onClick={() => patch({ status: "contacted", contacted_at: new Date().toISOString() }, "Marked as sent on LinkedIn")}>I sent it</Btn>
            </>}
            {["replied", "meeting", "won"].includes(l.status) && !l.converted_job_id && <Btn kind="primary" icon={Briefcase} onClick={convert}>Create job from this</Btn>}
            {l.converted_job_id && <Pill tone="em">Job created</Pill>}
          </div>
        </div>
      </div>
    </div>
  );
}

function OutreachSetup({ S, toast, status, onSaved }) {
  const s0 = (status && status.settings) || {};
  const [f, setF] = useState(() => ({ ...s0, leads: { ...(s0.leads || {}) } }));
  const [busy, setBusy] = useState(false);
  const isAdmin = S.role === "admin";
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setL = (k, v) => setF((x) => ({ ...x, leads: { ...x.leads, [k]: v } }));
  const inp = "w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none";
  const inpS = { borderColor: C.line, background: "#FAF8F3" };
  const save = () => {
    setBusy(true);
    const regions = (f.regions || []).filter(Boolean);
    const body = { outreach: { ...f, regions: regions.length ? regions : ["US", "EU", "MY"], minInternalFits: Number(f.minInternalFits) || 0, prospectsPerJob: Number(f.prospectsPerJob) || 20, dailyCap: Number(f.dailyCap) || 40, retentionDays: Number(f.retentionDays) || 90, leads: { ...f.leads, postingsPerDay: Number(f.leads.postingsPerDay) || 25, maxAgeDays: Number(f.leads.maxAgeDays) || 1 } } };
    S.sb("/rest/v1/agency_settings?id=eq.1", { method: "PATCH", body }).then(() => { toast("Outreach settings saved"); onSaved(); }).catch((e) => S.error(e.message)).finally(() => setBusy(false));
  };
  const conn = (status && status.connections) || {};
  const q = (status && status.queue) || {};
  const Row = ({ ok, label, hint }) => (
    <div className="flex items-start gap-2.5 py-2">
      {ok ? <CheckCircle2 size={16} color={C.em} className="shrink-0 mt-0.5" /> : <AlertTriangle size={16} color={C.warnFg} className="shrink-0 mt-0.5" />}
      <div><div className="text-sm font-medium">{label}</div><div className="text-xs" style={{ color: C.ink2 }}>{hint}</div></div>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle title="Connections" sub="Keys are stored as Supabase secrets, never in the app. See supabase/SOURCING_SETUP.md." size="text-xl" />
        <div className="mt-2">
          <Row ok={conn.anthropic} label="AI (Claude)" hint={conn.anthropic ? "Connected" : "Add ANTHROPIC_API_KEY"} />
          <Row ok={conn.apollo} label="Apollo: finds candidates outside ProNext and hiring managers' emails" hint={conn.apollo ? "Connected" : "Add APOLLO_API_KEY. Until then, jobs only check your own bench."} />
          <Row ok={conn.theirstack} label="TheirStack: daily feed of new job postings" hint={conn.theirstack ? "Connected" : "Add THEIRSTACK_API_KEY. Until then, no client leads are fetched."} />
          <Row ok={conn.sender && conn.sender !== "none"} label="Email sender" hint={conn.sender === "instantly" ? "Instantly" : conn.sender === "gmail" ? "Gmail (Google Workspace)" : "Not connected. Needs a separate outreach domain and mailboxes, then Instantly or Gmail keys. Approved emails wait in the queue until then."} />
          <Row ok={!(status && status.blockers && status.blockers.length)} label="Sender details" hint={status && status.blockers && status.blockers.length ? "Missing: " + status.blockers.join(", ") + ". Required by anti-spam law in every email." : "Set"} />
        </div>
        <div className="flex items-center justify-between gap-3 mt-3 pt-3 flex-wrap" style={{ borderTop: `1px solid ${C.line}` }}>
          <div className="text-sm" style={{ color: C.ink2 }}>{q.queued || 0} queued · {q.sentToday || 0} sent today · {q.failed || 0} failed</div>
          <div className="flex gap-2">
            {(q.failed || 0) > 0 && <Btn onClick={() => S.sourcing("retry_failed", {}).then((r) => { toast(r.message || "Retried"); onSaved(); }).catch((e) => S.error(e.message))}>Retry failed</Btn>}
            <Btn kind="primary" icon={Send} disabled={!(q.queued > 0)} onClick={() => S.sourcing("send_now", {}).then((r) => { toast(r.message || (r.sent || 0) + " sent"); onSaved(); }).catch((e) => S.error(e.message))}>Send queued now</Btn>
          </div>
        </div>
      </Card>
      <Card>
        <SectionTitle title="Outreach settings" sub={isAdmin ? "Applies to both candidate outreach and client leads." : "Only an Admin can change these."} size="text-xl" />
        <fieldset disabled={!isAdmin} className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Sender name</label><input value={f.senderName || ""} onChange={(e) => set("senderName", e.target.value)} placeholder="e.g. Ahmed Sanni" className={inp} style={inpS} /></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Sender title</label><input value={f.senderTitle || ""} onChange={(e) => set("senderTitle", e.target.value)} placeholder="e.g. Senior Recruiter" className={inp} style={inpS} /></div>
          <div className="md:col-span-2"><label className="text-xs font-medium" style={{ color: C.ink2 }}>Business postal address (shown in every email)</label><input value={f.businessAddress || ""} onChange={(e) => set("businessAddress", e.target.value)} className={inp} style={inpS} /></div>
          <div>
            <label className="text-xs font-medium" style={{ color: C.ink2 }}>Sending</label>
            <select value={f.approval || "manual"} onChange={(e) => set("approval", e.target.value)} className={inp} style={inpS}>
              <option value="manual">A person approves every email first</option>
              <option value="auto">Send automatically once drafted</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium" style={{ color: C.ink2 }}>Target regions</label>
            <div className="flex flex-col gap-1.5 mt-2">{REGION_OPTIONS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={(f.regions || []).includes(k)} onChange={(e) => set("regions", e.target.checked ? [...new Set([...(f.regions || []), k])] : (f.regions || []).filter((x) => x !== k))} />{label}</label>
            ))}</div>
          </div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Search outside ProNext when the bench has fewer strong fits than</label><input type="number" min="0" value={f.minInternalFits ?? 3} onChange={(e) => set("minInternalFits", e.target.value)} className={inp} style={inpS} /></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Most outside candidates per job (each costs an Apollo credit)</label><input type="number" min="1" value={f.prospectsPerJob ?? 20} onChange={(e) => set("prospectsPerJob", e.target.value)} className={inp} style={inpS} /></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Most outreach emails per day</label><input type="number" min="1" value={f.dailyCap ?? 40} onChange={(e) => set("dailyCap", e.target.value)} className={inp} style={inpS} /></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Delete outside contacts who never engaged after (days)</label><input type="number" min="14" value={f.retentionDays ?? 90} onChange={(e) => set("retentionDays", e.target.value)} className={inp} style={inpS} /></div>
          <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" checked={f.includePay !== false} onChange={(e) => set("includePay", e.target.checked)} />Mention the job's pay range in candidate emails</label>
          <div className="md:col-span-2 pt-3" style={{ borderTop: `1px solid ${C.line}` }}>
            <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={!!f.leads.enabled} onChange={(e) => setL("enabled", e.target.checked)} />Fetch new job postings every morning (client leads)</label>
            <div className="text-xs mt-1" style={{ color: C.ink2 }}>Postings are matched to candidates who agreed to be presented anonymously (they opt in on their candidate page).</div>
          </div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Postings per day (each costs a TheirStack credit)</label><input type="number" min="1" value={f.leads.postingsPerDay ?? 25} onChange={(e) => setL("postingsPerDay", e.target.value)} className={inp} style={inpS} /></div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Only postings from the last (days)</label><input type="number" min="1" max="14" value={f.leads.maxAgeDays ?? 1} onChange={(e) => setL("maxAgeDays", e.target.value)} className={inp} style={inpS} /></div>
        </fieldset>
        {isAdmin && <div className="flex justify-end mt-4"><Btn kind="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save settings"}</Btn></div>}
      </Card>
    </div>
  );
}

function CampaignsPage({ toast, S }) {
  const [tab, setTab] = useState(() => (new URLSearchParams(window.location.search).get("tab") === "approvals" ? "approvals" : "candidates"));
  const [confirm, setConfirm] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [prospects, setProspects] = useState(null);
  const [leads, setLeads] = useState(null);
  const [pendingLeads, setPendingLeads] = useState(0);
  const [pf, setPf] = useState("found");
  const [lf, setLf] = useState("new");
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState("");
  const canRun = S.role === "admin" || S.role === "recops";
  const load = () => {
    S.sourcing("status", {}).then(setStatus).catch(() => setStatus({ error: true }));
    S.sb("/rest/v1/prospects?select=*&order=created_at.desc&limit=500").then(setProspects).catch(() => setProspects([]));
    S.sb("/rest/v1/leads?select=*&status=neq.pending&order=created_at.desc&limit=500").then(setLeads).catch(() => setLeads([]));
    S.sb("/rest/v1/leads?select=id&status=eq.pending").then((r) => setPendingLeads((r || []).length)).catch(() => {});
  };
  React.useEffect(() => { if (canRun) load(); }, []); // eslint-disable-line
  if (!canRun) return (
    <div className="flex flex-col gap-5">
      <SectionTitle size="text-3xl md:text-4xl" title="Outreach" sub="Rec Ops and Admins run candidate outreach and client leads." />
      <Card><div className="text-sm" style={{ color: C.ink2 }}>Ask your Rec Ops manager if you'd like a role sourced outside ProNext.</div></Card>
    </div>
  );
  const jobLabel = (id) => { const j = S.jobs.find((x) => x.id === id); return j ? j.role + ", " + j.client : ""; };
  const ids = Object.keys(sel).filter((k) => sel[k]);
  const run = (key, fn) => { setBusy(key); return fn().catch((e) => S.error(e.message)).finally(() => { setBusy(""); load(); }); };
  const pGroups = { found: ["found"], sending: ["approved", "queued"], contacted: ["contacted"], interested: ["interested", "converted"], closed: ["not_interested", "unsubscribed", "bounced", "rejected"] };
  const lGroups = { new: ["new"], sending: ["approved", "queued"], contacted: ["contacted"], active: ["replied", "meeting"], won: ["won"], closed: ["lost", "ignored", "unsubscribed"] };
  const pList = (prospects || []).filter((p) => pGroups[pf].includes(p.status));
  const lList = (leads || []).filter((l) => lGroups[lf].includes(l.status));
  const cnt = (list, g) => (list || []).filter((x) => g.includes(x.status)).length;
  const conn = (status && status.connections) || {};
  const notice = status && !status.error && ((status.blockers || []).length || conn.sender === "none");
  const patchP = (id, body, msg) => S.sb("/rest/v1/prospects?id=eq." + id, { method: "PATCH", body }).then(() => { toast(msg); load(); }).catch((e) => S.error(e.message));
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="Outreach" sub="Candidates found outside ProNext for your live jobs, and hiring managers whose new postings fit your candidates." />
      </div>
      {notice ? (
        <div className="rounded-xl px-4 py-3 text-sm flex items-start gap-2.5" style={{ background: C.warnBg, color: C.warnFg }}>
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>Nothing is being sent yet. {conn.sender === "none" ? "No email sender is connected. " : ""}{(status.blockers || []).length ? "Missing: " + status.blockers.join(", ") + ". " : ""}Approved emails wait in the queue{conn.sender === "none" && !(status.blockers || []).length ? ", or use Send it myself on any email to send it from your own mailbox" : ""}. <button className="underline" onClick={() => setTab("setup")}>Open Setup</button></div>
        </div>
      ) : null}
      <Tabs tabs={[{ key: "candidates", label: "Candidate outreach" }, { key: "leads", label: "Client leads" }, { key: "approvals", label: "Approvals" + (status && status.approvals ? " " + status.approvals : "") }, { key: "setup", label: "Setup" }]} active={tab} setActive={(t) => { setTab(t); setSel({}); }} />

      {tab === "candidates" && (
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <Tabs tabs={[["found", "Needs approval"], ["sending", "Sending"], ["contacted", "Emailed"], ["interested", "Interested"], ["closed", "Closed"]].map(([k, label]) => ({ key: k, label: label + " " + cnt(prospects, pGroups[k]) }))} active={pf} setActive={(k) => { setPf(k); setSel({}); }} />
            {pf === "found" && pList.length > 0 && <div className="flex gap-2 shrink-0">
              <Btn onClick={() => setSel(ids.length === pList.length ? {} : Object.fromEntries(pList.map((p) => [p.id, true])))}>{ids.length === pList.length ? "Clear" : "Select all"}</Btn>
              <Btn kind="primary" icon={Send} disabled={!ids.length || !!busy} onClick={() => run("approve", () => S.sourcing("approve_prospects", { ids }).then((r) => { setSel({}); toast(approvedMsg(r.queued)); }))}>Approve {ids.length || ""}</Btn>
            </div>}
          </div>
          <div className="text-xs mt-3" style={{ color: C.ink2 }}>When a job goes live, ProNext checks your bench first. If there are fewer strong fits than your setting, it searches Apollo for people with a verified email and drafts a personal email for each. Open a job to search again or regenerate its titles.</div>
          <div className="flex flex-col gap-2 mt-3">
            {prospects == null ? <div className="text-sm" style={{ color: C.ink2 }}>Loading<InlineDots /></div> : pList.length ? pList.map((p) => (
              <ProspectCard key={p.id} p={p} jobLabel={jobLabel(p.job_id)} canEdit selected={!!sel[p.id]} onSelect={(v) => setSel((m) => ({ ...m, [p.id]: v }))}
                onSave={(b) => patchP(p.id, b, "Email saved")} onStatus={(st) => patchP(p.id, { status: st }, PROSPECT_LABEL[st] || "Updated")} S={S} toast={toast} onChanged={load} />
            )) : <div className="text-sm" style={{ color: C.ink2 }}>{pf === "found" ? "No one waiting for approval." : "Nothing here yet."}</div>}
          </div>
        </Card>
      )}

      {tab === "leads" && (
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <Tabs tabs={[["new", "New"], ["sending", "Sending"], ["contacted", "Contacted"], ["active", "In talks"], ["won", "Won"], ["closed", "Closed"]].map(([k, label]) => ({ key: k, label: label + " " + cnt(leads, lGroups[k]) }))} active={lf} setActive={(k) => { setLf(k); setSel({}); }} />
            <div className="flex gap-2 shrink-0 flex-wrap">
              {lf === "new" && ids.length > 0 && <Btn kind="primary" icon={Send} disabled={!!busy} onClick={() => run("approve", () => S.sourcing("approve_leads", { ids }).then((r) => { setSel({}); toast(approvedMsg(r.queued)); }))}>Approve {ids.length} email{ids.length === 1 ? "" : "s"}</Btn>}
              {pendingLeads > 0 && <Btn disabled={!!busy} onClick={() => run("process", () => S.sourcing("process_leads", {}).then((r) => toast("Checked " + (r.processed || 0) + ", kept " + (r.kept || 0))))}>{busy === "process" ? "Checking…" : "Check " + pendingLeads + " waiting"}</Btn>}
              <Btn icon={Download} disabled={!!busy || !conn.theirstack} onClick={() => run("fetch", () => paidAction(S, toast, "fetch_leads", {}, (c) => setConfirm(c && { ...c, go: () => { setConfirmBusy(true); Promise.resolve(c.go()).finally(() => { setConfirmBusy(false); load(); }); } }), load))}>{busy === "fetch" ? "Fetching…" : "Fetch today's jobs"}</Btn>
            </div>
          </div>
          <div className="text-xs mt-3" style={{ color: C.ink2 }}>{conn.theirstack ? "" : "TheirStack isn't connected yet, so no postings are fetched. "}Each morning ProNext pulls new postings in your target regions for titles your candidates hold, keeps the ones where a candidate who opted in is a strong fit, and drafts an anonymous pitch to the hiring contact: by email when Apollo finds a verified address, otherwise a LinkedIn message for you to send.</div>
          <div className="flex flex-col gap-2 mt-3">
            {leads == null ? <div className="text-sm" style={{ color: C.ink2 }}>Loading<InlineDots /></div> : lList.length ? lList.map((l) => (
              <LeadCard key={l.id + l.status} l={l} S={S} toast={toast} onChanged={load} selected={!!sel[l.id]} onSelect={(v) => setSel((m) => ({ ...m, [l.id]: v }))} />
            )) : <div className="text-sm" style={{ color: C.ink2 }}>Nothing here yet.</div>}
          </div>
        </Card>
      )}

      {tab === "approvals" && <ApprovalsPanel S={S} toast={toast} onChanged={load} />}
      <SpendConfirm c={confirm} busy={confirmBusy} onClose={() => setConfirm(null)} />
      {tab === "setup" && (status ? (status.error ? <Card><div className="text-sm" style={{ color: C.dangerFg }}>Couldn't load outreach status. Try again in a moment.</div></Card> : <OutreachSetup key={JSON.stringify(status.settings)} S={S} toast={toast} status={status} onSaved={load} />) : <Card><div className="text-sm" style={{ color: C.ink2 }}>Loading<InlineDots /></div></Card>)}
    </div>
  );
}

// Candidate page: the Yes/No pitching buttons and the "click here" unsubscribe link in our emails
// land here (?pitch=yes|no, ?unsub=1). The choice is recorded straight away and confirmed in a
// short note; these settings aren't shown on the candidate page otherwise.
function EmailChoiceNote({ token, onChanged }) {
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const pitch = q.get("pitch"), unsub = q.get("unsub") === "1";
    const clear = () => { const u = new URL(window.location.href); u.searchParams.delete("pitch"); u.searchParams.delete("unsub"); window.history.replaceState({}, "", u.toString()); };
    const fail = () => setMsg({ err: true, text: "We couldn't record that. Please try the link in the email again." });
    if (unsub) {
      sbFetch("/rest/v1/rpc/candidate_email_prefs", { method: "POST", body: { p_token: token, p_out: true } })
        .then(() => { clear(); setMsg({ text: "You've been unsubscribed. We won't send you any more emails." }); }).catch(fail);
    } else if (pitch === "yes" || pitch === "no") {
      sbFetch("/rest/v1/rpc/candidate_set_pitch_consent", { method: "POST", body: { p_token: token, p_consent: pitch === "yes" } })
        .then(() => { clear(); setMsg({ text: pitch === "yes" ? "Thanks. We'll pitch your profile anonymously for roles that fit you, and only share your details once you say yes to a specific role." : "No problem. We won't pitch your profile to other employers." }); if (onChanged) onChanged(); }).catch(fail);
    }
  }, [token]);
  if (!msg) return null;
  return <div className="text-sm rounded-xl px-3.5 py-2.5" style={msg.err ? { background: C.dangerBg, color: C.dangerFg } : { background: C.emTint, color: C.em }}>{msg.text}</div>;
}

// Public page behind the links in outreach emails: /?u=<token>&k=p|l&a=interested|unsubscribe|delete
function OutreachLinkPage({ token, kind, action }) {
  const [info, setInfo] = useState(null);
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const call = async (a) => {
    const r = await fetch(SB_URL + "/functions/v1/outreach-public", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ token, kind, action: a }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || "Something went wrong. Please try again."); return j;
  };
  React.useEffect(() => { call("info").then(setInfo).catch((e) => setErr(e.message)); }, []); // eslint-disable-line
  const go = (a) => { setBusy(true); setErr(""); call(a).then((j) => setDone(j.done || a)).catch((e) => setErr(e.message)).finally(() => setBusy(false)); };
  const role = info && info.role;
  const what = kind === "l" ? "about candidates for your " + (role || "open role") + (info && info.company ? " at " + info.company : "") : "about the " + (role || "role") + (info && info.location ? " in " + info.location : "");
  let bodyEl;
  if (err && !info) bodyEl = <div className="text-sm" style={{ color: C.dangerFg }}>{err}</div>;
  else if (!info) bodyEl = <div className="text-sm" style={{ color: C.ink2 }}>Loading<InlineDots /></div>;
  else if (info.gone) bodyEl = <div className="text-sm" style={{ color: C.ink2 }}>We no longer hold any details for this link. You won't hear from us again.</div>;
  else if (done === "interested") bodyEl = <div className="text-sm">Thanks{info.firstName ? ", " + info.firstName : ""}. {kind === "l" ? "We'll be in touch shortly with an anonymised profile." : "A recruiter will be in touch shortly about the " + (role || "role") + "."}</div>;
  else if (done === "closed") bodyEl = <div className="text-sm">Sorry, this role has just been filled. We'll keep you in mind for similar ones.</div>;
  else if (done === "unsubscribed") bodyEl = <div className="text-sm">You're unsubscribed. We won't email you again.</div>;
  else if (done === "deleted") bodyEl = <div className="text-sm">Done. We've deleted your details and won't contact you again.</div>;
  else if (action === "job" && kind === "p") {
    // The job description page linked from a candidate email (the client's name is taken out).
    const facts = [info.location, info.setup, info.employment, info.pay].filter(Boolean);
    bodyEl = info.closed ? <div className="text-sm">Sorry, this role has just been filled. We'll keep you in mind for similar ones.</div> : (
      <>
        <div className="text-xs mb-1" style={{ color: C.ink3 }}>{info.firstName ? "For " + info.firstName : "Job description"}</div>
        <div className="text-2xl md:text-3xl" style={{ ...SERIF }}>{role || "The role"}</div>
        {facts.length > 0 && <div className="flex flex-wrap gap-1.5 mt-2">{facts.map((f) => <Pill key={f} tone="neutral">{f}</Pill>)}</div>}
        {info.description && <div className="text-sm mt-5 whitespace-pre-wrap leading-relaxed" style={{ color: C.ink }}>{info.description}</div>}
        <div className="mt-6 pt-5 flex flex-col sm:flex-row sm:items-center gap-3" style={{ borderTop: `1px solid ${C.line}` }}>
          <div className="text-sm flex-1" style={{ color: C.ink2 }}>Feels like a good fit? Let us know and a recruiter will be in touch.</div>
          <Btn kind="primary" disabled={busy} onClick={() => go("interested")}>{busy ? "One moment…" : "I'm interested"}</Btn>
        </div>
        <div className="text-xs mt-4" style={{ color: C.ink3 }}>Not for you? <button className="underline" disabled={busy} onClick={() => go("unsubscribe")}>Unsubscribe</button> · <button className="underline" disabled={busy} onClick={() => go("delete")}>Delete my details</button></div>
        {err && <div className="text-xs mt-3" style={{ color: C.dangerFg }}>{err}</div>}
      </>
    );
  }
  else {
    const labels = { interested: "Yes, I'm interested", unsubscribe: "Unsubscribe", delete: "Delete my details" };
    const main = labels[action] ? action : "interested";
    bodyEl = (
      <>
        <div className="text-sm mb-4" style={{ color: C.ink2 }}>{info.firstName ? "Hi " + info.firstName + ". " : ""}This is about our email {what}.</div>
        {main === "delete" && <div className="text-sm mb-4" style={{ color: C.ink2 }}>We found your professional contact details through Apollo, a business contact database. Deleting them removes everything we hold about you and stops all further emails.</div>}
        <div className="flex flex-col gap-2">
          <Btn kind={main === "interested" ? "primary" : "danger"} full disabled={busy} onClick={() => go(main)}>{busy ? "One moment…" : labels[main]}</Btn>
          {main !== "unsubscribe" && <Btn full disabled={busy} onClick={() => go("unsubscribe")}>Unsubscribe instead</Btn>}
          {main !== "delete" && <button className="text-xs mt-1" style={{ color: C.ink3 }} disabled={busy} onClick={() => go("delete")}>Delete my details</button>}
        </div>
        {err && <div className="text-xs mt-3" style={{ color: C.dangerFg }}>{err}</div>}
      </>
    );
  }
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: C.canvas }}>
      <div className={"w-full rounded-2xl border p-6 " + (action === "job" && kind === "p" && !done ? "max-w-2xl md:p-8" : "max-w-sm")} style={{ background: "#fff", borderColor: C.line }}>
        <div className="mb-4"><BrandLogo height={30} /></div>
        {bodyEl}
      </div>
    </div>
  );
}

// Public page behind the blind-profile link shared with a client: /?t=<client_token>.
// Blind until the recruiter reveals it -- same link, same token, no second link to send.
function ClientViewPage({ token }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState("");
  const [resumeBusy, setResumeBusy] = useState(false);
  React.useEffect(() => {
    sbFetch("/rest/v1/rpc/client_view", { method: "POST", body: { p_token: token } }).then((j) => { if (!j) throw new Error("not found"); setInfo(j); }).catch(() => setErr("not found"));
  }, [token]); // eslint-disable-line
  const openResume = () => {
    setResumeBusy(true);
    fetch(SB_URL + "/functions/v1/client-view", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error); window.open(j.url, "_blank"); })
      .catch((e) => setErr(e.message)).finally(() => setResumeBusy(false));
  };
  let bodyEl;
  if (err) bodyEl = <div className="text-sm" style={{ color: C.dangerFg }}>{err === "not found" ? "This link is not valid." : err}</div>;
  else if (!info) bodyEl = <div className="text-sm" style={{ color: C.ink2 }}>Loading<InlineDots /></div>;
  else {
    const Row = ({ label, value }) => value ? <div className="flex gap-2 text-sm"><span className="font-medium shrink-0" style={{ color: C.ink2, width: 90 }}>{label}</span><span>{value}</span></div> : null;
    const chips = (list, tone) => !!(list && list.length) && (
      <div className="flex flex-wrap gap-1.5 mt-1.5">{list.map((x, i) => <span key={i} className="rounded-full px-2.5 py-1 text-xs" style={{ background: TONE[tone].bg, color: TONE[tone].fg }}>{x}</span>)}</div>
    );
    bodyEl = (
      <>
        <div className="text-xs font-semibold mb-1" style={{ color: C.ink3 }}>{info.role}{info.client ? ", " + info.client : ""}</div>
        <div className="text-xl mb-3" style={{ ...SERIF }}>{info.revealed ? info.name : "Candidate profile"}</div>
        {!info.revealed && <div className="text-xs rounded-lg px-3 py-2 mb-4" style={{ background: C.neutralBg, color: C.ink2 }}>Presented anonymously. Your recruiter will share full contact details once you'd like to move forward.</div>}
        {info.score != null && <div className="flex items-center gap-2 mb-3"><div className="text-2xl" style={{ ...SERIF }}>{info.score}%</div>{info.verdict && <Pill tone={VERDICT_TONE[info.verdict] || "neutral"}>{info.verdict}</Pill>}</div>}
        {info.summary && <div className="text-sm leading-relaxed mb-4">{info.summary}</div>}
        <div className="flex flex-col gap-1.5 mb-3">
          <Row label="Title" value={info.currentTitle} />
          <Row label="Experience" value={info.experience} />
          <Row label="Location" value={info.location} />
          <Row label="Notice" value={info.notice} />
          {info.revealed && <Row label="Employer" value={info.currentCompany} />}
          {info.revealed && <Row label="Email" value={info.email} />}
          {info.revealed && <Row label="Phone" value={info.phone} />}
          {info.revealed && info.linkedin && <Row label="LinkedIn" value={<a href={info.linkedin} target="_blank" rel="noreferrer" className="underline" style={{ color: C.em }}>{info.linkedin}</a>} />}
        </div>
        {!!(info.skills && info.skills.length) && <div className="mb-3"><div className="text-xs font-semibold" style={{ color: C.ink3 }}>SKILLS</div>{chips(info.skills, "neutral")}</div>}
        {!!(info.strengths && info.strengths.length) && <div className="mb-3"><div className="text-xs font-semibold" style={{ color: C.ink3 }}>STRENGTHS</div>{chips(info.strengths, "em")}</div>}
        {!!(info.industries && info.industries.length) && <div className="mb-3"><div className="text-xs font-semibold" style={{ color: C.ink3 }}>INDUSTRIES</div>{chips(info.industries, "info")}</div>}
        {info.revealed && info.hasResume && <Btn kind="primary" full disabled={resumeBusy} onClick={openResume} className="mt-2">{resumeBusy ? "Opening…" : "View resume"}</Btn>}
      </>
    );
  }
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: C.canvas }}>
      <div className="w-full max-w-sm rounded-2xl border p-6" style={{ background: "#fff", borderColor: C.line }}>
        <div className="mb-4"><BrandLogo height={30} /></div>
        {bodyEl}
      </div>
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
    } catch (e) { S.error(e.message || "Could not create billing entry"); }
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
    } catch (e) { S.error(e.message); }
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
    } catch (e) { S.error(e.message); }
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
    S.deletePlacement(delTarget.id).then(() => { toast("Billing entry deleted"); setDelTarget(null); }).catch((e) => S.error(e.message || "Could not delete")).finally(() => setDelBusy(false));
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
  const [viewUser, setViewUser] = useState(null);
  const ROLE_OPTIONS = [["recruiter", "Recruiter"], ["recops", "Rec Ops manager"], ["admin", "Admin"]];
  const adminCount = users.filter((u) => u.roleKey === "admin" && u.status === "Active").length;
  const transferCandidates = users.filter((u) => !u.isOwner && u.status === "Active");
  const openEdit = (u) => { setEditUser(u); setEditName(u.name); setEditPhone(u.phone || ""); };
  const saveEdit = () => {
    if (!editName.trim()) { toast("Enter their name"); return; }
    setEditBusy(true);
    S.editUser(editUser.id, { name: editName.trim(), phone: editPhone.trim() })
      .then(() => { toast("Details updated"); setEditUser(null); }).catch((e) => S.error(e.message)).finally(() => setEditBusy(false));
  };
  const savePassword = () => {
    if (pwValue.length < 8) { toast("Password must be at least 8 characters"); return; }
    setPwBusy(true);
    S.setUserPassword(pwUser.id, pwValue)
      .then(() => { toast("Password set for " + pwUser.name); setPwUser(null); setPwValue(""); }).catch((e) => S.error(e.message)).finally(() => setPwBusy(false));
  };
  const confirmDeleteUser = () => {
    setDelBusy(true);
    S.deleteUser(delUser.id)
      .then(() => { toast(delUser.name + " deleted"); setDelUser(null); }).catch((e) => S.error(e.message)).finally(() => setDelBusy(false));
  };
  const invite = async () => {
    if (!name.trim()) { toast("Enter their name"); return; }
    if (!email.includes("@")) { toast("Enter a valid email"); return; }
    if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) { toast("That email already has an account"); return; }
    if (pass.length < 8) { toast("Password must be at least 8 characters"); return; }
    setBusy(true);
    try { await S.createAccount({ email, password: pass, full_name: name, role: roleKey }); setName(""); setEmail(""); setPass(""); setOpen(false); toast("Account created for " + name + " — activate it so they can sign in"); }
    catch (e) { S.error(e.message || "Could not create account"); }
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
      .catch((e) => S.error(e.message || "Could not transfer ownership")).finally(() => setTransferBusy(false));
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
            { key: "name", label: "USER", render: (u) => <button onClick={() => setViewUser(u)} className="text-left"><div className="font-medium flex items-center gap-1.5" style={{ color: C.ink }}>{u.name}{u.isOwner && <Pill tone="em">Owner</Pill>}</div><div className="text-xs" style={{ color: C.ink2 }}>{u.email}</div></button> },
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
      <UserDetailModal user={viewUser} onClose={() => setViewUser(null)} S={S} />
    </div>
  );
}

function UserDetailModal({ user, onClose, S }) {
  if (!user) return null;
  const sec = user.security || {};
  const activity = (S.auditLog || []).filter((a) => a.actorId === user.id).slice(0, 40);
  const row = (label, value) => (
    <div className="flex items-start justify-between gap-3 py-2" style={{ borderTop: `1px solid ${C.line}` }}>
      <span className="text-xs" style={{ color: C.ink2 }}>{label}</span>
      <span className="text-sm text-right" style={{ color: C.ink }}>{value || <span style={{ color: C.ink3 }}>&mdash;</span>}</span>
    </div>
  );
  return (
    <Modal open={!!user} onClose={onClose} title={user.name}>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-medium shrink-0" style={{ background: C.emTint, color: C.em }}>{initialsOf(user.name)}</div>
        <div>
          <div className="font-medium flex items-center gap-1.5">{user.name}{user.isOwner && <Pill tone="em">Owner</Pill>}</div>
          <div className="text-xs" style={{ color: C.ink2 }}>{user.email}</div>
        </div>
      </div>
      <div className="mb-5">
        {row("Role", user.role)}
        {row("Status", <StatusPill status={user.status} />)}
        {row("Phone", user.phone)}
        {row("Last IP address", sec.lastIp)}
        {row("Last known location", sec.lastLocation)}
        {row("Last sign-in", sec.lastLoginAt ? ago(sec.lastLoginAt) : "")}
      </div>
      <div className="text-xs mb-3" style={{ color: C.ink3 }}>IP address and location are captured automatically at sign-in and are only visible to admins.</div>
      <SectionTitle title="Activity" sub="Recent actions on this account." size="text-lg" />
      <div className="mt-2">
        {activity.length === 0 ? <div className="text-sm" style={{ color: C.ink3 }}>No activity recorded yet.</div> : (
          <div className="flex flex-col max-h-72 overflow-y-auto">
            {activity.map((a) => (
              <div key={a.id} className="py-2 flex items-start justify-between gap-3" style={{ borderTop: `1px solid ${C.line}` }}>
                <div>
                  <div className="text-sm">{a.action}{a.entityType ? <span style={{ color: C.ink2 }}> &middot; {a.entityType}</span> : null}</div>
                  {a.detail && <div className="text-xs" style={{ color: C.ink3 }}>{a.detail}</div>}
                </div>
                <span className="text-xs whitespace-nowrap" style={{ color: C.ink2 }}>{a.when}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
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
      <div>
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Logo (shown at the top of every email; your agency name is used when there's no logo)</label>
        <div className="flex items-center gap-3 mt-1.5">
          {company.logoUrl ? <img src={company.logoUrl} alt="Agency logo" className="h-9 max-w-[160px] object-contain rounded" style={{ background: C.canvas }} /> : <div className="rounded-lg border" style={{ borderColor: C.line }}><BrandMark size={36} /></div>}
          <label className="text-sm rounded-lg border px-3 py-2 cursor-pointer" style={{ borderColor: C.line }}>{company.logoUrl ? "Change logo" : "Upload logo"}<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={(e) => { const f = e.target.files && e.target.files[0]; if (!f) return; S.uploadLogo(f).then((url) => { setCompany({ ...company, logoUrl: url }); toast("Logo uploaded. Save changes to use it."); }).catch(() => {}); }} /></label>
          {company.logoUrl && <button type="button" className="text-xs underline" style={{ color: C.ink2 }} onClick={() => setCompany({ ...company, logoUrl: "" })}>Remove</button>}
        </div>
      </div>
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
  // Rejects (client or otherwise) and "not a fit" candidates all land on Active file now
  // rather than a dead-end "Rejected" status, so staleness here means sitting untouched on
  // Active file, not a status that nothing sets anymore.
  const eligible = days ? S.cands.filter((c) => c.status === "Active file" && c.updatedAt < Date.now() - days * 864e5) : [];
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
  const [idle, setIdle] = useState(String(S.settings.idleMinutes || 30));
  const [idleBusy, setIdleBusy] = useState(false);
  const saveIdle = () => {
    setIdleBusy(true);
    S.saveSettings({ ...S.settings, idleMinutes: Number(idle) }).then(() => toast("Automatic sign-out saved. It applies to everyone from their next page load.")).catch(() => {}).finally(() => setIdleBusy(false));
  };
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionTitle title="Automatic sign-out" sub="Signs people out of ProNext after a period with no activity, so an unattended computer doesn't stay logged in. They get a 2-minute warning first, and need to sign in again afterwards." size="text-lg" />
        <div className="flex flex-col sm:flex-row sm:items-end gap-3 mt-4">
          <div className="sm:w-64"><label className="text-xs font-medium" style={{ color: C.ink2 }}>Sign out after no activity for</label>
            <select value={idle} onChange={(e) => setIdle(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }}>
              {[[15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [480, "8 hours"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          <Btn kind="primary" disabled={idleBusy || Number(idle) === (S.settings.idleMinutes || 30)} onClick={saveIdle}>{idleBusy ? <>Saving <InlineDots color="#fff" /></> : "Save"}</Btn>
        </div>
      </Card>
      <Card>
        <SectionTitle title="Export data" sub="Download a CSV for your own records or another system." size="text-lg" />
        <div className="flex flex-wrap gap-2 mt-4"><Btn icon={Download} onClick={exportCandidates}>Export candidates</Btn><Btn icon={Download} onClick={exportPlacements}>Export placements</Btn></div>
      </Card>
      <Card>
        <SectionTitle title="Data retention" sub="Automatically clean up candidates on Active file who've sat untouched for a while." size="text-lg" />
        <div className="flex flex-col gap-3 mt-4 md:max-w-sm">
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Delete inactive Active-file candidates after (days)</label><input value={retention} onChange={(e) => setRetention(e.target.value)} placeholder="Never" className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
          <Btn kind="primary" disabled={busy} onClick={saveRetention}>{busy ? <>Saving <InlineDots color="#fff" /></> : "Save"}</Btn>
        </div>
        {days > 0 && (
          <div className="mt-4 pt-4 flex flex-wrap items-center justify-between gap-3" style={{ borderTop: `1px solid ${C.line}` }}>
            <div className="text-sm" style={{ color: C.ink2 }}>{eligible.length} inactive Active-file candidate{eligible.length === 1 ? "" : "s"} past {days} days right now.</div>
            <Btn kind="danger" disabled={!eligible.length} onClick={() => setPurgeOpen(true)}>Purge now</Btn>
          </div>
        )}
      </Card>
      <ConfirmModal open={purgeOpen} onClose={() => setPurgeOpen(false)} title="Delete these candidates?" body={"This permanently deletes " + eligible.length + " inactive Active-file candidate(s) past your retention window. This can't be undone."} onConfirm={confirmPurge} busy={purgeBusy} />
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
      <SectionTitle title="Integrations" sub="Turn on the channels and tools your team can use elsewhere in ProNext." size="text-lg" />
      <div className="flex flex-col gap-1 mt-4">
        {INTEGRATIONS_LIST.map((i) => (
          <button key={i.key} onClick={() => toggle(i.key)} className="py-3 flex items-center justify-between gap-3 text-left" style={{ borderTop: `1px solid ${C.line}` }}>
            <div><div className="text-sm font-medium">{i.label}</div><div className="text-xs" style={{ color: C.ink2 }}>{i.sub}</div></div>
            <div className="w-10 h-6 rounded-full flex items-center px-0.5 shrink-0" style={{ background: enabled[i.key] ? C.em : "#D5D2C7" }}><div className={`w-5 h-5 rounded-full bg-white ${enabled[i.key] ? "ml-auto" : ""}`} /></div>
          </button>
        ))}
      </div>
      <div className="text-xs mt-3" style={{ color: C.ink3 }}>LinkedIn and Google for Jobs post through your ad campaigns, tracked here in ProNext — a real posting connection to either platform isn't wired up yet.</div>
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
  const openJobs = S.jobs.filter(takesCandidates);
  // Coming from a specific job's page pre-selects it here; opened from the Candidates
  // page directly (initialJobId null), the recruiter picks the job themselves below.
  const [jobId, setJobId] = useState(initialJobId && openJobs.some((j) => j.id === initialJobId) ? initialJobId : "");
  const heldJob = initialJobId ? S.jobs.find((j) => j.id === initialJobId && !takesCandidates(j)) : null;
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
  // Email check: the same person can be submitted to different jobs, but only once to the same
  // job, so two recruiters can't dispute one application.
  const [dup, setDup] = useState({ state: "idle" }); // idle | checking | ok | taken | error
  const emailOk = EMAIL_RE.test(emailAddr.trim());
  useEffect(() => {
    if (candId) return;
    const em = emailAddr.trim();
    if (!EMAIL_RE.test(em)) { setDup({ state: "idle" }); return; }
    let live = true;
    setDup((d) => ({ ...d, state: "checking" }));
    const t = setTimeout(() => {
      S.checkCandidateEmail(em, name.trim(), jobId)
        .then((r) => { if (live) setDup({ state: r && r.match ? "taken" : "ok", match: r && r.match, elsewhere: ((r && r.elsewhere) || []).filter((x) => x.jobs && x.jobs.length), similar: (r && r.similar) || [] }); })
        .catch(() => { if (live) setDup({ state: "error" }); });
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [emailAddr, name, jobId, candId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Nothing is created until the email is valid and not already registered.
  const emailBlock = () => {
    if (candId) return false;
    if (!emailAddr.trim()) { toast("Enter the candidate's email"); return true; }
    if (!emailOk) { toast("That email doesn't look right"); return true; }
    if (dup.state === "checking") { toast("Still checking the email. Try again in a second."); return true; }
    if (dup.state === "taken") { toast(dup.match.mine ? "You've already submitted this candidate to this job" : "This candidate is already on this job, submitted by " + dup.match.recruiter); return true; }
    return false;
  };

  const setA = (i, v) => setAnswers((arr) => { const next = arr.slice(); next[i] = v; return next; });

  // Creates the draft candidate row the first time it's needed (Check fit or Submit),
  // then reuses the same row for the rest of this flow.
  const ensureDraft = async () => {
    if (candId) return candId;
    if (!name.trim()) { toast("Enter the candidate's name"); return null; }
    const c = newCandidate({ name: name.trim(), role: job ? job.role : "Unspecified", recruiter: S.me.name, recruiterId: S.me.id, recruiterInit: S.me.init, ai: 0, emailAddr, phone, isDraft: true, timeline: [{ t: "Added by " + S.me.first, d: todayStr(), done: true }] });
    await S.insertCandidateAwait(c);
    setCandId(c.id);
    return c.id;
  };

  const checkFit = async () => {
    if (!jobId) { toast("Pick a job first"); return; }
    if (emailBlock()) return;
    if (!file && !candId) { toast("Upload a resume first"); return; }
    setChecking(true);
    try {
      const id = await ensureDraft();
      if (!id) { setChecking(false); return; }
      if (file) { await S.uploadResume(id, file); setFile(null); }
      const r = await S.checkFit(id, jobId, job);
      setFit(r);
    } catch (e) { S.error(e.message || "Could not check fit"); }
    setChecking(false);
  };

  const submit = async () => {
    if (!jobId) { toast("Pick a job first"); return; }
    if (emailBlock()) return;
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
    } catch (e) { S.error(e.message || "Could not add candidate"); }
    setSubmitting(false);
  };

  const startOver = () => { setJobId(""); setAnswers([]); setName(""); setEmailAddr(""); setPhone(""); setFileName(""); setFile(null); setCandId(null); setFit(null); setDup({ state: "idle" }); };

  const FIT_TONE = { "Perfect fit": "em", "Good fit": "em", "Possible fit": "warn", "Possible reject": "danger", "Not a fit": "danger" };

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <button onClick={() => setPage("candidates")} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Candidates</button>
      <SectionTitle size="text-3xl md:text-4xl" title="Add candidate" sub="Pick the job, then their resume and (if you're ready) the screening answers." />
      <Card className="md:max-w-xl flex flex-col gap-4">
        {heldJob && <div className="rounded-lg px-3 py-2.5 text-sm" style={{ background: C.warnBg, color: "#7A4B05" }}>{heldJob.role} is {heldJob.status === "Closed" ? "closed" : holdText(heldJob).replace("On hold", "on hold")} and isn't taking new candidates. Pick another job below.</div>}
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
            <div className="text-xs font-medium mb-1.5" style={{ color: C.ink2 }}>Email</div>
            <input type="email" className="w-full text-sm rounded-lg border px-3 py-2 bg-white" style={{ borderColor: dup.state === "taken" ? C.dangerFg : C.line, color: C.ink }} value={emailAddr} onChange={(e) => setEmailAddr(e.target.value)} disabled={!!candId} placeholder="name@example.com" aria-describedby="email-check" />
            <div id="email-check" className="text-xs mt-1 min-h-[16px]" style={{ color: dup.state === "ok" ? TONE.em.fg : C.ink3 }} aria-live="polite">
              {candId ? "" : !emailAddr.trim() ? "Checked so the same person isn't submitted to one job twice." : !emailOk ? "Enter a full email address." : dup.state === "checking" ? "Checking…" : dup.state === "ok" ? (job ? "✓ Not on this job yet" : "✓ Pick a job to finish the check") : dup.state === "error" ? "Couldn't check the email right now. It's checked again when you submit." : ""}
            </div>
          </div>
        </div>
        {!candId && dup.state === "taken" && (
          <div className="rounded-xl p-3 text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2" style={{ background: TONE.danger.bg }} role="alert">
            <span>
              <span className="font-semibold" style={{ color: TONE.danger.fg }}>{dup.match.mine ? "You've already submitted " + dup.match.name + " to this job." : dup.match.name + " is already on this job."}</span>{" "}
              <span style={{ color: C.ink }}>{dup.match.mine ? "Submitted " + fdate(dup.match.since) + ". Use their existing profile." : "Submitted by " + dup.match.recruiter + " on " + fdate(dup.match.since) + ". A candidate can only be submitted once per job, so this would be a disputed application. Ask Rec Ops if you think this is wrong."}</span>
            </span>
            {dup.match.candidateId && <Btn onClick={() => S.openCandidate(dup.match.candidateId)} className="shrink-0 text-xs px-3 py-1.5">Open their profile</Btn>}
          </div>
        )}
        {!candId && dup.state === "ok" && (dup.elsewhere || []).length > 0 && (
          <div className="rounded-xl p-3 text-sm" style={{ background: TONE.info.bg }}>
            <span className="font-semibold" style={{ color: TONE.info.fg }}>Already in ProNext for other jobs. </span>
            <span style={{ color: C.ink }}>{dup.elsewhere.map((x) => x.name + " (" + (x.mine ? "yours" : x.recruiter) + "): " + x.jobs.join(", ")).join("; ")}. {job ? "You can still submit them for this job." : ""}</span>
          </div>
        )}
        {!candId && dup.state !== "taken" && (dup.similar || []).length > 0 && (
          <div className="rounded-xl p-3 text-sm" style={{ background: TONE.warn.bg }}>
            <span className="font-semibold" style={{ color: TONE.warn.fg }}>Possible duplicate. </span>
            <span style={{ color: C.ink }}>Someone with the same name is already in ProNext under a different email: {dup.similar.map((x) => x.name + " (" + (x.mine ? "yours" : x.recruiter) + ", added " + fdate(x.since) + ")").join("; ")}. Make sure it isn't the same person before you submit.</span>
          </div>
        )}
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

/* Candidate page (secure link /?c=<portal token>, no login and no dashboard behind it).
   Top to bottom: their photo and name with a Message button (opens the full-screen chat),
   anything waiting on them (interviews, roles to accept, questions to answer), every role
   they've applied for with its progress, and other roles they might fit. Accepting and
   answering go straight to the ai-screen function, which rescreens them. */

// Candidate-facing progress for one application.
const APP_STEPS = ["Applied", "In review", "Sent to employer", "Interview", "Offer", "Hired"];
const STAGE_STEP = { Sourced: 0, "In review": 1, Screening: 1, Submitted: 2, Interview: 3, Offer: 4, Placed: 5 };
function appStatus(a) {
  if (a.response === "pending") return { label: "Awaiting your reply", tone: "warn" };
  if (a.response === "declined") return { label: "You declined", tone: "neutral" };
  if (a.stage === "Withdrawn") return { label: "Withdrawn", tone: "neutral" };
  if (a.stage === "Rejected") return { label: "Not selected", tone: "danger" };
  if (a.stage === "Placed") return { label: "Hired", tone: "em" };
  if (a.stage === "Offer") return { label: "Offer", tone: "em" };
  if (a.stage === "Interview") return { label: "Interviewing", tone: "info" };
  if (a.stage === "Submitted") return { label: "With the employer", tone: "info" };
  return { label: "In review", tone: "warn" };
}
function appSteps(a) {
  const iv = (a.interviews || [])[0];
  const dates = [a.createdAt, a.respondedAt || null, a.submittedAt, iv ? iv.startsAt : null, null, a.stage === "Placed" ? a.outcomeAt : null];
  const ended = a.stage === "Rejected" || a.stage === "Withdrawn" || a.response === "declined";
  let reached = a.response === "pending" ? 0 : STAGE_STEP[a.stage] != null ? STAGE_STEP[a.stage] : 1;
  if (ended) reached = a.response === "declined" ? 0 : (a.interviews || []).length ? 3 : a.submittedAt ? 2 : 1;
  const steps = APP_STEPS.slice(0, ended ? reached + 1 : APP_STEPS.length).map((label, i) => ({
    label, date: i <= reached ? dates[i] : null, state: i < reached || (i === reached && (ended || a.stage === "Placed")) ? "done" : i === reached ? "current" : "todo",
  }));
  if (a.response === "pending") steps[0] = { label: "Your recruiter put you forward for this role", date: a.createdAt, state: "current" };
  if (ended) steps.push({ label: a.response === "declined" ? "You declined this role" : a.stage === "Withdrawn" ? "Withdrawn" : "Not selected", date: a.outcomeAt || a.respondedAt, state: "ended" });
  return steps;
}

// "Company · Lagos · Hybrid", without repeating "Remote" when the location already says it.
const placeLine = (x) => [x.company, x.location, x.workSetup && !String(x.location || "").toLowerCase().includes(String(x.workSetup).toLowerCase()) ? x.workSetup : ""].filter(Boolean).join(" · ");

function ProgressSteps({ steps }) {
  return (
    <div className="flex flex-col">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const color = s.state === "done" ? C.em : s.state === "current" ? C.warnFg : s.state === "ended" ? C.dangerFg : C.line;
        return (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center" style={{ width: 18 }}>
              <div className="w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0"
                style={{ background: s.state === "todo" ? "#fff" : color, border: `2px solid ${color}` }}>
                {s.state === "done" && <Check size={11} color="#fff" strokeWidth={3} />}
                {s.state === "ended" && <X size={11} color="#fff" strokeWidth={3} />}
                {s.state === "current" && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#fff" }} />}
              </div>
              {!last && <div className="flex-1 w-0.5 my-0.5" style={{ background: s.state === "done" ? C.em : C.line, minHeight: 18 }} />}
            </div>
            <div className={"flex-1 min-w-0 " + (last ? "" : "pb-3")}>
              <div className="text-sm" style={{ color: s.state === "todo" ? C.ink3 : C.ink, fontWeight: s.state === "current" ? 600 : 400 }}>{s.label}</div>
              {s.date && <div className="text-xs" style={{ color: C.ink3 }}>{fdate(s.date)}{s.state === "current" && s.label === "Interview" && new Date(s.date) > new Date() ? " · upcoming" : ""}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Resize in the browser (max 512px, JPEG) so uploads are small and quick on mobile data.
const shrinkImage = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const max = 512, s = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    resolve(cv.toDataURL("image/jpeg", 0.85));
  };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a picture we can open. Try a JPG or PNG.")); };
  img.src = url;
});

function PortalPhoto({ src, name, token, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const fileRef = React.useRef(null);
  const call = async (body) => {
    setBusy(true); onError("");
    try {
      const r = await fetch(SB_URL + "/functions/v1/candidate-photo", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Couldn't save your photo. Please try again.");
      if (onChanged) await onChanged();
    } catch (e) { onError(e.message); }
    setBusy(false);
  };
  const pick = async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    try { await call({ action: "set", image: await shrinkImage(f) }); } catch (err) { onError(err.message); }
  };
  return (
    <div className="flex flex-col items-center gap-1.5 shrink-0">
      <button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy} aria-label={src ? "Change photo" : "Add photo"}
        className="relative w-24 h-24 rounded-full" style={{ background: C.neutralBg }}>
        {src
          ? <img src={src} alt={name} className="w-24 h-24 rounded-full object-cover" />
          : <span className="w-24 h-24 rounded-full flex items-center justify-center" style={{ color: C.ink3 }}><UserRound size={44} /></span>}
        <span className="absolute bottom-0 right-0 w-8 h-8 rounded-full flex items-center justify-center border-2" style={{ background: C.em, color: "#fff", borderColor: "#fff" }}>
          {busy ? <InlineDots color="#fff" /> : <Camera size={15} />}
        </span>
      </button>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pick} />
      <div className="flex items-center gap-2 text-xs">
        <button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy} className="font-medium" style={{ color: C.em }}>{src ? "Change photo" : "Add photo"}</button>
        {src && <><span style={{ color: C.line }}>|</span><button onClick={() => call({ action: "remove" })} disabled={busy} style={{ color: C.ink3 }}>Remove</button></>}
      </div>
    </div>
  );
}

// Full-screen messages: the list of conversations (one per role), then the chat itself.
function PortalChat({ token, convos, recruiter, startId, onClose }) {
  const [openId, setOpenId] = useState(startId || (convos.length === 1 ? convos[0].linkId : null));
  const open = convos.find((c) => c.linkId === openId) || null;
  const recName = (recruiter && recruiter.name) || "Your recruiter";
  useEffect(() => {
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex justify-center" style={{ background: "rgba(20,32,27,0.45)" }}>
      <div className="w-full md:max-w-2xl flex flex-col" style={{ height: "100dvh", background: "#fff" }}>
        {open ? (
          <ChatRoom key={open.linkId} linkId={open.linkId} mine="candidate" api={candidateChatApi(token, open.linkId)} className="flex-1"
            title={recName} subtitle={open.role + (open.company ? " · " + open.company : "")}
            avatarSrc={recruiter && recruiter.photo} avatarInit={initialsOf(recName)}
            onBack={() => (convos.length > 1 && !startId ? setOpenId(null) : onClose())} peerName={recName}
            emptyText={"Send " + recName + " a message about " + open.role + ". They'll get it straight away."} />
        ) : (
          <>
            <div className="flex items-center gap-2.5 px-3 py-3 shrink-0" style={{ background: C.side, color: "#fff" }}>
              <button onClick={onClose} aria-label="Close" className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center"><ArrowLeft size={20} /></button>
              <div className="text-base font-semibold">Messages</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {convos.map((c) => (
                <button key={c.linkId} onClick={() => setOpenId(c.linkId)} className="w-full text-left px-4 py-3 flex items-center gap-3" style={{ borderBottom: `1px solid ${C.line}` }}>
                  <Avatar init={initialsOf(recName)} tone="em" size={46} src={(recruiter && recruiter.photo) || undefined} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[15px] font-medium truncate">{c.role}</span>
                      {c.lastMessage && <span className="text-xs shrink-0" style={{ color: c.unread ? C.em : C.ink3 }}>{chatDay(c.lastMessage.createdAt) === "Today" ? chatTime(c.lastMessage.createdAt) : chatDay(c.lastMessage.createdAt)}</span>}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm truncate" style={{ color: C.ink2 }}>{c.lastMessage ? (c.lastMessage.sender === "candidate" ? "You: " : "") + (c.lastMessage.body || "📎 Sent a file") : c.company + " · with " + recName}</span>
                      {c.unread > 0 && <span className="min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0" style={{ background: C.em, color: "#fff" }}>{c.unread}</span>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CandidatePortal({ data, token, onChanged }) {
  const c = { name: "", endorsements: [], matches: [], routed: [], questions: [], answered: [], applications: [], ...(data || {}) };
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [chat, setChat] = useState(null); // null | { startId }
  const [openApps, setOpenApps] = useState({});
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

  // Opening the page counts as delivery of messages waiting for them; the page refreshes
  // itself every 20 seconds so new messages and progress show up without a reload.
  useEffect(() => {
    if (!token) return;
    sbFetch("/rest/v1/rpc/candidate_mark_delivered", { method: "POST", body: { p_token: token } }).catch(() => {});
    const t = setInterval(() => { if (document.visibilityState === "visible" && onChanged) onChanged(); }, 20000);
    return () => clearInterval(t);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const apps = c.applications || [];
  // Older applications recorded before roles were linked, shown if they aren't already listed.
  const pastOnly = (c.endorsements || []).filter((e) => !apps.some((a) => a.role === e.role && a.company === e.company));
  const convos = apps.filter((a) => a.response !== "declined");
  const unread = convos.reduce((n, a) => n + (a.unread || 0), 0);
  const recName = c.recruiter && c.recruiter.name;

  return (
    <div className="min-h-screen" style={{ background: C.canvas }}>
      <div className="max-w-2xl mx-auto p-4 md:p-8 flex flex-col gap-4">
        <div className="mb-1"><BrandLogo height={30} /></div>
        {token && <EmailChoiceNote token={token} onChanged={onChanged} />}

        <Card>
          <div className="flex flex-col sm:flex-row items-center sm:items-center gap-4 sm:gap-5 text-center sm:text-left">
            {token
              ? <PortalPhoto src={c.photoUrl} name={c.name} token={token} onChanged={onChanged} onError={setErr} />
              : <span className="w-24 h-24 rounded-full flex items-center justify-center shrink-0" style={{ background: C.neutralBg, color: C.ink3 }}><UserRound size={44} /></span>}
            <div className="flex-1 min-w-0">
              <div className="text-3xl md:text-4xl leading-tight" style={{ ...SERIF }}>{c.name || "Welcome"}</div>
              <div className="text-sm mt-1" style={{ color: C.ink2 }}>
                {recName ? <>Your recruiter is <b style={{ color: C.ink }}>{recName}</b>.</> : "Here is where your applications stand."}
              </div>
              <div className="mt-3 flex justify-center sm:justify-start">
                <button onClick={() => convos.length && setChat({})} disabled={!convos.length}
                  className="relative inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold"
                  style={{ background: C.em, color: "#fff", opacity: convos.length ? 1 : 0.55 }}>
                  <MessageCircle size={17} /> Message{recName ? " " + recName : " your recruiter"}
                  {unread > 0 && <span className="absolute -top-2 -right-2 min-w-5 h-5 px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center" style={{ background: C.dangerFg, color: "#fff" }}>{unread}</span>}
                </button>
              </div>
              {!convos.length && <div className="text-xs mt-2" style={{ color: C.ink3 }}>You can message your recruiter once you're on a role.</div>}
            </div>
          </div>
        </Card>

        {note && <div className="text-sm rounded-xl px-3.5 py-2.5" style={{ background: C.emTint, color: C.em }}>{note}</div>}
        {err && <div className="text-sm rounded-xl px-3.5 py-2.5" style={{ background: C.dangerBg, color: C.dangerFg }}>{err}</div>}

        {token && (c.interviews || []).length > 0 && <PortalInterviews list={c.interviews} token={token} onChanged={onChanged} />}

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
          <SectionTitle title="Your applications" sub={apps.length + pastOnly.length ? "Tap a role to see where it's at." : ""} size="text-xl" />
          {apps.length + pastOnly.length === 0 && <div className="text-sm py-4" style={{ color: C.ink3 }}>You haven't applied for any roles yet.</div>}
          <div className="flex flex-col gap-2.5 mt-3">
            {apps.map((a) => {
              const st = appStatus(a);
              const isOpen = !!openApps[a.linkId];
              return (
                <div key={a.linkId} className="rounded-xl border" style={{ borderColor: isOpen ? C.em : C.line }}>
                  <button onClick={() => setOpenApps((m) => ({ ...m, [a.linkId]: !m[a.linkId] }))} aria-expanded={isOpen}
                    className="w-full text-left flex items-center gap-3 px-3.5 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-semibold leading-snug">{a.role}</div>
                      <div className="text-xs mt-0.5" style={{ color: C.ink2 }}>{placeLine(a)}</div>
                    </div>
                    <Pill tone={st.tone}>{st.label}</Pill>
                    {a.unread > 0 && <span className="min-w-5 h-5 px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center" style={{ background: C.dangerFg, color: "#fff" }} title="Unread messages">{a.unread}</span>}
                    <ChevronDown size={18} color={C.ink3} style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
                  </button>
                  {isOpen && (
                    <div className="px-3.5 pb-3.5 pt-1" style={{ borderTop: `1px solid ${C.line}` }}>
                      <div className="pt-3"><ProgressSteps steps={appSteps(a)} /></div>
                      {a.jobStatus === "On hold" && !["Rejected", "Withdrawn", "Placed"].includes(a.stage) && (
                        <div className="text-xs rounded-lg px-3 py-2 mt-3" style={{ background: C.warnBg, color: C.warnFg }}>The employer has paused this role for now. We'll update you when it moves again.</div>
                      )}
                      {a.stage === "Rejected" && a.rejectMessage && (
                        <div className="text-sm rounded-lg px-3 py-2.5 mt-3" style={{ background: C.canvas, color: C.ink2 }}>{a.rejectMessage}</div>
                      )}
                      {a.response !== "declined" && (
                        <button onClick={() => setChat({ startId: a.linkId })} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: C.em }}>
                          <MessageCircle size={15} /> Message {recName || "your recruiter"} about this role
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {pastOnly.map((e, i) => (
              <div key={"p" + i} className="rounded-xl border flex items-center gap-3 px-3.5 py-3" style={{ borderColor: C.line }}>
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] font-semibold leading-snug">{e.role}</div>
                  <div className="text-xs truncate" style={{ color: C.ink2 }}>{e.company}{e.createdAt ? " · " + fdate(e.createdAt) : ""}</div>
                </div>
                <StatusPill status={e.status} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle title="Other roles you might be a good fit for" size="text-xl" />
          {c.matches.length === 0 ? (
            <div className="text-sm py-4" style={{ color: C.ink3 }}>No other roles at the moment. We'll let you know when one comes up.</div>
          ) : (
            <div className="mt-2">
              {c.matches.map((m, i) => (
                <div key={i} className="flex items-center justify-between py-3 gap-3" style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{m.role}</div>
                    <div className="text-xs" style={{ color: C.ink2 }}>{placeLine(m)}</div>
                  </div>
                  <Pill tone="em">{m.fit}% match</Pill>
                </div>
              ))}
              {convos.length > 0 && <div className="text-xs mt-1" style={{ color: C.ink3 }}>Interested in one of these? Message {recName || "your recruiter"}.</div>}
            </div>
          )}
        </Card>
      </div>
      {chat && token && <PortalChat token={token} convos={convos} recruiter={c.recruiter} startId={chat.startId} onClose={() => { setChat(null); if (onChanged) onChanged(); }} />}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* App root                                                                 */
/* ---------------------------------------------------------------------- */
function ForgotPassword({ onDone, initialEmail }) {
  const [step, setStep] = useState("request"); // request | verify | done
  const [email, setEmail] = useState(initialEmail || "");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const call = async (body) => {
    const r = await fetch(SB_URL + "/functions/v1/forgot-password", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || "Something went wrong");
    return j;
  };

  const requestCode = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    if (!email || !email.includes("@")) { setErr("Enter your email"); return; }
    setBusy(true); setErr("");
    try { const j = await call({ action: "request", email }); setMsg(j.message || "If that email has a ProNext account, a code has been sent to it."); setStep("verify"); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const verifyCode = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    if (!otp.trim()) { setErr("Enter the code from your email"); return; }
    if (password.length < 8) { setErr("Password must be at least 8 characters"); return; }
    if (password !== password2) { setErr("Passwords don't match"); return; }
    setBusy(true); setErr("");
    try { await call({ action: "verify", email, otp: otp.trim(), newPassword: password }); setStep("done"); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: C.canvas }}>
      <form onSubmit={step === "request" ? requestCode : verifyCode} className="w-full max-w-sm rounded-2xl border p-6" style={{ background: "#fff", borderColor: C.line }}>
        <div className="flex items-center gap-2.5 mb-6">
          <BrandLogo height={34} />
        </div>
        {step === "request" && (<>
          <div className="text-sm font-medium mb-1">Forgot your password?</div>
          <div className="text-xs mb-4" style={{ color: C.ink2 }}>Enter your ProNext email and we'll send you a one-time code to reset it. Your admin is notified too, for visibility.</div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
          {err && <div className="text-xs mb-3" style={{ color: C.dangerFg }}>{err}</div>}
          <Btn type="submit" kind="primary" full className="mt-1" onClick={requestCode}>{busy ? <>Sending <InlineDots color="#fff" /></> : "Send code"}</Btn>
        </>)}
        {step === "verify" && (<>
          <div className="text-sm font-medium mb-1">Check your email</div>
          <div className="text-xs mb-4" style={{ color: C.ink2 }}>{msg}</div>
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>6-digit code</label>
          <input inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none tracking-[0.3em]" style={{ borderColor: C.line, background: "#FAF8F3" }} />
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>New password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Confirm new password</label>
          <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} className="w-full mt-1.5 mb-2 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
          {err && <div className="text-xs mb-3" style={{ color: C.dangerFg }}>{err}</div>}
          <Btn type="submit" kind="primary" full className="mt-1" onClick={verifyCode}>{busy ? <>Resetting <InlineDots color="#fff" /></> : "Reset password"}</Btn>
          <button type="button" onClick={() => { setStep("request"); setErr(""); }} className="w-full text-xs mt-3 text-center" style={{ color: C.ink3 }}>Didn't get a code? Try again</button>
        </>)}
        {step === "done" && (<>
          <div className="text-sm font-medium mb-1">Password reset</div>
          <div className="text-xs mb-4" style={{ color: C.ink2 }}>You can now sign in with your new password.</div>
          <Btn kind="primary" full onClick={onDone}>Back to sign in</Btn>
        </>)}
        {step !== "done" && <button type="button" onClick={onDone} className="w-full text-xs mt-4 text-center" style={{ color: C.ink3 }}>Back to sign in</button>}
      </form>
    </div>
  );
}

function SignIn({ onSignedIn, notice }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const submit = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    if (!email || !password) { setErr("Enter your email and password"); return; }
    setBusy(true); setErr("");
    try { const s = await signIn(email.trim(), password); store.set(s); onSignedIn(s); }
    catch (e) { setErr(e.message === "Invalid login credentials" ? "Wrong email or password" : e.message); }
    setBusy(false);
  };
  if (forgot) return <ForgotPassword initialEmail={email} onDone={() => setForgot(false)} />;
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: C.canvas }}>
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border p-6" style={{ background: "#fff", borderColor: C.line }}>
        <div className="flex items-center gap-2.5 mb-6">
          <BrandLogo height={34} />
        </div>
        {notice && <div className="text-sm rounded-lg px-3 py-2.5 mb-4 flex items-start gap-2" style={{ background: C.warnBg, color: "#7A4B05" }}><Lock size={15} className="shrink-0 mt-0.5" />{notice}</div>}
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full mt-1.5 mb-3 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium" style={{ color: C.ink2 }}>Password</label>
          <button type="button" onClick={() => setForgot(true)} className="text-xs" style={{ color: C.ink2, textDecoration: "underline" }}>Forgot password?</button>
        </div>
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
        <div className="text-sm mb-5" style={{ color: C.ink2 }}>Your account is signed in but not active yet. Ask your ProNext admin to activate it.</div>
        <Btn onClick={onSignOut}>Sign out</Btn>
      </div>
    </div>
  );
}

const FETCH_PATH = "/rest/v1/candidates?select=*,candidate_endorsements(*),candidate_comments(*),candidate_timeline(*),candidate_jobs(*,candidate_job_messages(*))&order=created_at.desc";
async function loadAll(token) {
  // Reaching a recruiter's app is what "delivered" means for candidate messages (two grey ticks).
  await sbFetch("/rest/v1/rpc/staff_mark_delivered", { method: "POST", token }).catch(() => {});
  const [profiles, candidates, jobs, applications, placements, campaigns, ads, settingsRows, jobEngagements, auditLog, profileSecurity, interviews] = await Promise.all([
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
    sbFetch("/rest/v1/profile_security?select=*", { token }).catch(() => []), // admin-or-self only (RLS); IP/location per user
    sbFetch("/rest/v1/interviews?select=*&order=starts_at.asc", { token }).catch(() => []), // RLS: same reach as candidates
  ]);
  return mapAll({ profiles, candidates, jobs, applications, placements, campaigns, ads, settings: settingsRows[0], jobEngagements, auditLog, profileSecurity, interviews });
}

export default function App() {
  // A saved session that's been idle past the limit is thrown away before anything loads.
  const [signedOutReason, setSignedOutReason] = useState(() => (store.get() && idleExpired() ? "idle" : ""));
  const [session, setSession] = useState(() => { const s = store.get(); if (s && idleExpired()) { endServerSession(s); store.set(null); return null; } return s; });
  const [idleLeft, setIdleLeft] = useState(null);
  const [me, setMe] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | signedout | pending | ready | error
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);
  const [errMsg, setErrMsg] = useState("");
  const [page, setPageRaw] = useState(() => new URLSearchParams(window.location.search).get("page") || "overview");
  const [query, setQueryRaw] = useState("");
  const [candId, setCandId] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [addCandidateJobId, setAddCandidateJobId] = useState(null);
  const [billFor, setBillFor] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toastText, setToastText] = useState("");
  const [errorModalMsg, setErrorModalMsg] = useState("");
  const [promote, setPromote] = useState({ open: false, job: "" });
  const [profileTab, setProfileTab] = useState(() => new URLSearchParams(window.location.search).get("tab") || "account");
  const [portalToken] = useState(() => new URLSearchParams(window.location.search).get("c"));
  const [outreachLink] = useState(() => { const q = new URLSearchParams(window.location.search); return q.get("u") ? { token: q.get("u"), kind: q.get("k") === "l" ? "l" : "p", action: q.get("a") || "interested" } : null; });
  const [clientToken] = useState(() => new URLSearchParams(window.location.search).get("t"));
  const [portalData, setPortalData] = useState(null);

  const toast = (t) => { setToastText(t); setTimeout(() => setToastText(""), 2600); };
  // Errors get a modal the person has to dismiss, instead of a toast that can be missed.
  const showError = (msg) => setErrorModalMsg(String(msg || "Something went wrong."));
  const signOut = (reason) => {
    if (session) endServerSession(session);
    store.set(null); idleStore.clear(); setIdleLeft(null);
    setSignedOutReason(typeof reason === "string" ? reason : "");
    setSession(null); setMe(null); setData(null); setStatus("signedout");
  };
  // Automatic sign-out after inactivity. Activity in any ProNext tab counts (shared in
  // localStorage); signing out in one tab signs out the others.
  React.useEffect(() => {
    if (status !== "ready") return;
    const limitMs = () => idleStore.minutes() * 60000;
    let lastWrite = 0;
    const touch = () => { const n = Date.now(); if (n - lastWrite > 5000) { lastWrite = n; idleStore.touch(n); } };
    const check = () => {
      const idleMs = Date.now() - (idleStore.last() || Date.now());
      if (idleMs >= limitMs()) { signOut("idle"); return; }
      setIdleLeft(idleMs >= limitMs() - IDLE_WARN_MS ? Math.ceil((limitMs() - idleMs) / 1000) : null);
    };
    const onStorage = (e) => { if (e.key === "harbor.session" && !e.newValue) { setSignedOutReason("elsewhere"); setSession(null); setMe(null); setData(null); setStatus("signedout"); } else if (e.key === IDLE_KEY) check(); };
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    const events = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "wheel"];
    if (!idleStore.last()) idleStore.touch(Date.now());
    events.forEach((ev) => window.addEventListener(ev, touch, { passive: true }));
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(check, 5000); check();
    return () => { events.forEach((ev) => window.removeEventListener(ev, touch)); window.removeEventListener("storage", onStorage); document.removeEventListener("visibilitychange", onVis); clearInterval(t); };
  }, [status]); // eslint-disable-line
  React.useEffect(() => { if (data && data.settings) idleStore.setMinutes(data.settings.idleMinutes || 30); }, [data && data.settings && data.settings.idleMinutes]); // eslint-disable-line

  const loadPortal = () => sbFetch("/rest/v1/rpc/candidate_portal", { method: "POST", body: { p_token: portalToken } }).then(setPortalData).catch(() => setPortalData({ error: true }));
  React.useEffect(() => { if (portalToken) loadPortal(); }, [portalToken]); // eslint-disable-line

  const boot = async (s) => {
    try {
      let sess = s;
      if (sess.exp < Date.now() + 30000) { sess = await refreshSession(sess); store.set(sess); }
      const profile = (await sbFetch("/rest/v1/profiles?select=*&id=eq." + sess.uid, { token: sess.token }))[0];
      if (!profile || profile.status !== "Active") { setSession(sess); setMe(profile ? mapUser(profile) : null); setStatus("pending"); return; }
      setSession(sess); setMe(mapUser(profile));
      // Records this device's IP/location on the profile and logs a "login" activity entry --
      // once per browser tab session, so refreshing the page doesn't spam the activity log.
      try {
        if (!sessionStorage.getItem("harbor.recordedLogin")) {
          sessionStorage.setItem("harbor.recordedLogin", "1");
          fetch(SB_URL + "/functions/v1/record-login", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + sess.token, "Content-Type": "application/json" } }).catch(() => {});
        }
      } catch (e) {}
      const d = await loadAll(sess.token);
      setData(d); setStatus("ready");
    } catch (e) { setErrMsg(e.message); setStatus("error"); }
  };

  React.useEffect(() => { if (session) boot(session); else setStatus("signedout"); }, []); // eslint-disable-line

  React.useEffect(() => {
    const f = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); const el = document.getElementById("harbor-search"); if (el) el.focus(); } };
    window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f);
  }, []);

  // Keep the URL's ?page= in sync with in-app navigation, so the browser back/forward
  // buttons move between ProNext's own pages instead of leaving the app, and refreshing
  // reloads the page the person was on instead of bouncing to Overview.
  const routeSkipPush = React.useRef(true); // true on first run: URL already matches, don't push a duplicate entry
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("page") === page) return;
    url.searchParams.set("page", page);
    if (routeSkipPush.current) { routeSkipPush.current = false; window.history.replaceState({ page }, "", url); }
    else window.history.pushState({ page }, "", url);
  }, [page]);
  React.useEffect(() => {
    const onPop = () => setPageRaw(new URLSearchParams(window.location.search).get("page") || "overview");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (outreachLink) return <OutreachLinkPage {...outreachLink} />;
  if (clientToken) return <ClientViewPage token={clientToken} />;
  if (portalToken) {
    if (!portalData) return <div className="min-h-screen flex items-center justify-center" style={{ background: C.canvas }}><div style={{ color: C.ink2 }}>Loading&hellip;</div></div>;
    if (portalData.error || !portalData.name) return <div className="min-h-screen flex items-center justify-center p-4 text-center" style={{ background: C.canvas }}><div style={{ color: C.ink2 }}>This link is not valid.</div></div>;
    return <CandidatePortal data={portalData} token={portalToken} onChanged={loadPortal} />;
  }

  const retry = () => { setStatus("loading"); setErrMsg(""); if (session) boot(session); else setStatus("signedout"); };
  if (status === "loading") return <Loader key={"load" + errMsg} label="Loading your workspace…" onRetry={() => window.location.reload()} />;
  if (status === "signedout") return <SignIn notice={signedOutReason === "idle" ? "You were signed out after " + idleStore.label() + " without activity. Sign in again to continue." : signedOutReason === "elsewhere" ? "You were signed out in another tab." : ""} onSignedIn={(s) => { idleStore.touch(Date.now()); setSignedOutReason(""); setSession(s); setStatus("loading"); boot(s); }} />;
  if (status === "pending") return <AwaitingAccess onSignOut={signOut} />;
  if (status === "error") return (
    <div className="min-h-screen flex items-center justify-center p-4 text-center" style={{ background: C.canvas }}>
      <div className="max-w-sm"><div className="text-sm mb-4" style={{ color: C.dangerFg }}>Could not load ProNext: {errMsg}</div><div className="flex gap-2 justify-center flex-wrap"><Btn kind="primary" onClick={retry}>Try again</Btn><Btn onClick={signOut}>Sign out</Btn></div></div>
    </div>
  );

  const role = me.roleKey;
  const setPage = (p) => { setCandId(null); setPageRaw(p); };
  const setQuery = (v) => { setQueryRaw(v); if (v && page !== "candidates" && page !== "jobs") setPage("candidates"); };
  const myMe = { name: me.name, label: me.role, init: initialsOf(me.name), first: me.name.split(" ")[0], id: me.id, email: me.email, phone: me.phone, avatarUrl: me.avatarUrl, roleKey: me.roleKey, notificationPrefs: me.notificationPrefs, isOwner: me.isOwner };
  const reload = () => { setRefreshing(true); return loadAll(session.token).then(setData).catch((e) => S.error(e.message)).finally(() => setRefreshing(false)); };
  const call = async (path, opts) => { try { await sbFetch(path, { ...opts, token: session.token }); reload(); } catch (e) { S.error(e.message); throw e; } };
  const aiCall = async (action, payload) => {
    const r = await fetch(SB_URL + "/functions/v1/ai-screen", { method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "AI request failed"); reload(); return j;
  };
  // Interviews (interviews Edge Function): ivCall refreshes ProNext's data after a change; ivQuiet
  // is for lookups (Google status, busy times) that change nothing.
  const ivQuiet = async (action, payload) => {
    const r = await fetch(SB_URL + "/functions/v1/interviews", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || "Request failed"); return j;
  };
  const ivCall = async (action, payload) => { const j = await ivQuiet(action, payload); reload(); return j; };
  // Sourcing and outreach (sourcing Edge Function). Pages refresh their own lists, so no reload here.
  const srcCall = async (action, payload) => {
    const r = await fetch(SB_URL + "/functions/v1/sourcing", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || "Request failed"); return j;
  };
  // Recruiter -> candidate messaging (candidate_job_messages, one thread per candidate_jobs
  // link). Sending goes through the send-message edge function rather than a plain insert
  // because it also emails the candidate; reading is just the messages already embedded on
  // each jobLink, and marking a thread read is a plain PATCH (RLS-scoped, no edge function).
  const msgQuiet = async (action, payload) => {
    const r = await fetch(SB_URL + "/functions/v1/send-message", { method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Request failed"); return j;
  };
  const msgCall = async (action, payload) => {
    const r = await fetch(SB_URL + "/functions/v1/send-message", { method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Could not send"); reload(); return j;
  };
  // Fire-and-forget entry in the admin-only audit log. Never blocks or fails the action it's logging.
  const logAudit = (action, entityType, entityId, detail) => {
    sbFetch("/rest/v1/audit_log", { method: "POST", token: session.token, body: { actor_id: session.uid, action, entity_type: entityType, entity_id: entityId != null ? String(entityId) : null, detail: detail || null } }).catch(() => {});
  };

  // Local candidate field -> candidates table column, for the fields a person can actually edit.
  const CAND_FIELD_MAP = { status: "status", name: "name", role: "role_title", location: "location", emailAddr: "email", phone: "phone", linkedin: "linkedin_url", experience: "experience", notice: "notice", pay: "pay", skills: "skills", strengths: "strengths", gaps: "gaps", ai: "ai_score", recruiterId: "recruiter_id", ai_locked: "ai_locked" };
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
      } catch (e) { S.error(e.message); reload(); }
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
      .catch((e) => { showError(e.message); reload(); throw e; });
  };

  const S = {
    role, me: myMe, query, toast, error: showError, go: setPage,
    cands: data.cands, updateCand,
    deleteCandidate: (id) => { const c = data.cands.find((x) => x.id === id); return call("/rest/v1/candidates?id=eq." + id, { method: "DELETE" }).then(() => logAudit("deleted", "candidate", id, c ? c.name : "")); },
    setCands: (fn) => { const list = typeof fn === "function" ? fn(data.cands) : fn; const added = list.filter((c) => !data.cands.some((x) => x.id === c.id));
      setData((d) => ({ ...d, cands: list })); added.forEach((c) => call("/rest/v1/candidates", { method: "POST", body: { id: c.id, name: c.name, role_title: c.role, location: c.location || "", recruiter_id: c.recruiterId, status: c.status, ai_score: c.ai || null, email: c.emailAddr || null, phone: c.phone || null, source: c.source || null } })); },
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
        // The role they were placed on moves to Placed too, so the role card and status agree.
        const lk = c && p.jobId ? (c.jobLinks || []).find((l) => l.jobId === p.jobId) : null;
        if (lk && lk.stage !== "Placed") await sbFetch("/rest/v1/candidate_jobs?id=eq." + lk.id, { method: "PATCH", token: session.token, body: { stage: "Placed" } }).catch(() => {});
        if (c && c.status !== "Placed") {
          updateCand(c.id, (cc) => ({ status: "Placed", timeline: [...cc.timeline, { t: "Status set to Placed", d: todayStr(), done: true }] }));
        }
        reload();
      } catch (e) { showError(e.message); setData((d) => ({ ...d, placements: d.placements.filter((x) => x.id !== row.id) })); throw e; }
    },
    setPlacementStatus: (id, status) => { const pl = data.placements.find((x) => x.id === id);
      return call("/rest/v1/placements?id=eq." + id, { method: "PATCH", body: { status } })
        .then(() => {
          setData((d) => ({ ...d, placements: d.placements.map((p) => (p.id === id ? { ...p, status } : p)) }));
          logAudit("status changed", "placement", id, (pl ? pl.name : "") + ": " + (pl ? pl.status : "?") + " → " + status);
        })
        .catch((e) => showError(e.message)); },
    updatePlacement: (id, patch) => { const pl = data.placements.find((x) => x.id === id);
      return call("/rest/v1/placements?id=eq." + id, { method: "PATCH", body: patch })
        .then(() => logAudit("updated", "placement", id, (pl ? pl.name : "") + ": " + Object.keys(patch).join(", "))); },
    claimInvoiceNumber: () => sbFetch("/rest/v1/rpc/claim_invoice_number", { method: "POST", token: session.token, body: {} }),
    checkCandidateEmail: (email, name, jobId) => sbFetch("/rest/v1/rpc/check_candidate_email", { method: "POST", token: session.token, body: { p_email: email || "", p_name: name || "", p_job_id: jobId || null } }),
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
    saveSettings: (v) => call("/rest/v1/agency_settings?id=eq.1", { method: "PATCH", body: { agency_name: v.name, guarantee_days: v.guaranteeDays, ai_screening: v.ai, default_currency: v.defaultCurrency, default_country: v.defaultCountry, retention_days: v.retentionDays || null, integrations: v.integrations || {}, company: v.company || {}, invoice_prefix: v.invoicePrefix || "INV", idle_timeout_minutes: Math.min(480, Math.max(5, Number(v.idleMinutes) || 30)) } }).then(() => logAudit("updated", "agency_settings", "1", "Agency settings changed")),
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
    updateNotificationPrefs: (prefs) => { setMe((m) => ({ ...m, notificationPrefs: prefs })); return sbFetch("/rest/v1/profiles?id=eq." + session.uid, { method: "PATCH", token: session.token, body: { notification_prefs: prefs } }).catch((e) => showError(e.message)); },
    team: buildTeam(data.users, data.cands, data.placements),
    openCandidate: (id) => setCandId(id),
    // Opens Billing with the new billing entry form ready for this candidate.
    startBilling: (id) => { setCandId(null); setBillFor(id); setPage("billing"); },
    billFor, clearBillFor: () => setBillFor(null),
    insertCandidateAwait: (c) => call("/rest/v1/candidates", { method: "POST", body: { id: c.id, name: c.name, role_title: c.role, location: c.location || "", recruiter_id: c.recruiterId, status: c.status, ai_score: c.ai || null, email: c.emailAddr || null, phone: c.phone || null, is_draft: !!c.isDraft } }),
    logAudit,
    // On hold takes an optional reason and end date (the role reopens by itself on that date).
    setJobStatus: (id, status, hold) => { const j = data.jobs.find((x) => x.id === id);
      const body = { status, ...(status === "On hold" ? { hold_reason: (hold && hold.reason) || null, hold_until: (hold && hold.until) || null } : {}) };
      return call("/rest/v1/jobs?id=eq." + id, { method: "PATCH", body }).then(() => {
        setData((d) => ({ ...d, jobs: d.jobs.map((x) => (x.id === id ? { ...x, status, holdReason: status === "On hold" ? body.hold_reason || "" : "", holdUntil: status === "On hold" ? body.hold_until : null } : x)) }));
        logAudit("status changed", "job", id, (j ? j.role + ", " + j.client : "") + ": " + (j ? j.status : "?") + " → " + (status === "On hold" ? holdText({ holdReason: body.hold_reason, holdUntil: body.hold_until }) : status));
      }); },
    /* Candidate <-> job pipeline (candidate_jobs table). screeningAnswers: [{q,a}] answered by the
       recruiter right when they attach the candidate to a job that has screening_questions. */
    /* Submitting a candidate to a job opens their company card; the first AI screening
       (resume + application answers + anything they've answered for other jobs) starts right away. */
    linkJob: async (candidateId, jobId, fit, screeningAnswers) => {
      let rows;
      try { rows = await sbFetch("/rest/v1/candidate_jobs?on_conflict=candidate_id,job_id", { method: "POST", token: session.token, prefer: "resolution=ignore-duplicates,return=representation", body: { candidate_id: candidateId, job_id: jobId, fit: fit || null, stage: "In review", screening_answers: screeningAnswers || [] } }); }
      catch (e) { showError(e.message); throw e; }
      reload();
      const row = rows && rows[0];
      // Screening starts on the server the moment the row exists (no button to press).
      if (row) msgCall("invite", { linkId: row.id }).catch(() => {});
      return row;
    },
    /* Routing: the role shows on the candidate's page; their company card appears once they accept. */
    routeToJob: async (candidateId, jobId) => {
      let rows;
      try { rows = await sbFetch("/rest/v1/candidate_jobs?on_conflict=candidate_id,job_id", { method: "POST", token: session.token, prefer: "resolution=ignore-duplicates,return=representation", body: { candidate_id: candidateId, job_id: jobId, stage: "Sourced", candidate_response: "pending" } }); }
      catch (e) { showError(e.message); throw e; }
      reload();
      const row = rows && rows[0];
      if (row) msgCall("invite", { linkId: row.id }).catch(() => {});
      return row;
    },
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
      catch (e) { showError(e.message); throw e; }
      reload();
      const row = rows && rows[0];
      if (row) msgCall("invite", { linkId: row.id }).catch(() => {});
      logAudit("added candidate", "candidate", candidateId, job ? job.role + " – " + job.client : "");
      return row;
    },
    setStage: (linkId, stage) => call("/rest/v1/candidate_jobs?id=eq." + linkId, { method: "PATCH", body: { stage } }),
    setScreeningAnswers: (linkId, screeningAnswers) => call("/rest/v1/candidate_jobs?id=eq." + linkId, { method: "PATCH", body: { screening_answers: screeningAnswers } }),
    unlinkJob: (linkId) => call("/rest/v1/candidate_jobs?id=eq." + linkId, { method: "DELETE" }),
    deleteEndorsement: (id) => call("/rest/v1/candidate_endorsements?id=eq." + id, { method: "DELETE" }),
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
      if (!r.ok) { const t = await r.text(); showError("Upload failed: " + t); throw new Error(t); }
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
      } catch (e) { if (w) w.close(); showError(e.message); }
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
    interviews: data.interviews || [],
    iv: ivCall,
    ivQuiet: ivQuiet,
    goProfile: (tab) => { setProfileTab(tab || "account"); setPage("myProfile"); },
    sourcing: srcCall,
    sb: (path, opts) => sbFetch(path, { ...(opts || {}), token: session.token }),
    reload,
    // Recruiter's side of candidate messaging (see msgCall above).
    sendMessage: (linkId, body) => msgCall("reply", { linkId, body }),
    // The chat screen refreshes itself, so it sends without reloading the whole workspace.
    sendMessageQuiet: (linkId, body, attachment) => msgQuiet("reply", { linkId, body: body || "", ...(attachment ? { attachment } : {}) }),
    // Rejections: draft/preview change nothing; reject records it and tells the candidate.
    msgQuiet: msgQuiet,
    rejectCandidate: (payload) => msgCall("reject", payload),
    inviteToMessage: (linkId) => msgCall("invite", { linkId }).catch(() => {}), // best-effort, never blocks the action that triggered it
    markThreadRead: (linkId) => call("/rest/v1/candidate_job_messages?link_id=eq." + linkId + "&sender=eq.candidate&recruiter_read_at=is.null", { method: "PATCH", body: { recruiter_read_at: new Date().toISOString() } }),
    /* Your own account: name/phone update straight to your profiles row, avatar via the public `avatars` bucket. */
    updateMyProfile: (patch) => {
      const body = {}; if ("name" in patch) body.full_name = patch.name; if ("phone" in patch) body.phone = patch.phone;
      setMe((m) => ({ ...m, ...("name" in patch ? { name: patch.name } : {}), ...("phone" in patch ? { phone: patch.phone } : {}) }));
      return sbFetch("/rest/v1/profiles?id=eq." + session.uid, { method: "PATCH", token: session.token, body })
        .then(reload)
        .catch((e) => { showError(e.message); reload(); throw e; });
    },
    // Agency logo for emails: the public avatars bucket, in the uploader's own folder.
    uploadLogo: async (file) => {
      const path = session.uid + "/agency-logo-" + Date.now() + "-" + file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      const r = await fetch(SB_URL + "/storage/v1/object/avatars/" + path, { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + session.token, "Content-Type": file.type || "image/png", "x-upsert": "true" }, body: file });
      if (!r.ok) { const t = await r.text(); showError("Upload failed: " + t); throw new Error(t); }
      return SB_URL + "/storage/v1/object/public/avatars/" + path;
    },
    uploadAvatar: async (file) => {
      const path = session.uid + "/" + Date.now() + "-" + file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      const r = await fetch(SB_URL + "/storage/v1/object/avatars/" + path, { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + session.token, "Content-Type": file.type || "image/png", "x-upsert": "true" }, body: file });
      if (!r.ok) { const t = await r.text(); showError("Upload failed: " + t); throw new Error(t); }
      const url = SB_URL + "/storage/v1/object/public/avatars/" + path;
      setMe((m) => ({ ...m, avatarUrl: url }));
      await sbFetch("/rest/v1/profiles?id=eq." + session.uid, { method: "PATCH", token: session.token, body: { avatar_url: url } }).catch((e) => showError(e.message));
      reload();
      return url;
    },
  };
  const onPromote = (job) => setPromote({ open: true, job });
  const pendingQ = countFollowups(data.cands, "draft");


  const scope = role === "recruiter" ? "recruiter" : "all";
  const candData = role === "recruiter" ? data.cands.filter((c) => c.recruiterId === session.uid) : data.cands;
  const candidate = data.cands.find((c) => c.id === candId);

  let content;
  if (candidate) content = <CandidateDetail key={candidate.id} candidate={candidate} onBack={() => setCandId(null)} toast={toast} S={S} />;
  else if (page === "overview") content = role === "recruiter" ? <OverviewRecruiter S={S} /> : <OverviewRecOps S={S} />;
  else if (page === "candidates") content = <CandidatesList scope={scope} data={candData} openCandidate={(c) => setCandId(c.id)} setPage={setPage} onAddCandidate={() => { setAddCandidateJobId(null); setPage("uploadCandidates"); }} S={S} toast={toast} />;
  else if (page === "uploadCandidates") content = <AddCandidate setPage={setPage} toast={toast} S={S} initialJobId={addCandidateJobId} />;
  else if (page === "inbox") content = <InboxPage toast={toast} S={S} />;
  else if (page === "messages") content = <MessagesPage toast={toast} S={S} />;
  else if (page === "jobs") content = <JobsPage setPage={setPage} onPromote={onPromote} S={S} onOpenJob={(id) => { setJobId(id); setPageRaw("jobDetail"); }} />;
  else if (page === "postJob") content = <PostJobForm setPage={setPage} toast={toast} onPromote={onPromote} S={S} onOpenJob={(id) => { setJobId(id); setPageRaw("jobDetail"); }} />;
  else if (page === "editJob") content = <PostJobForm setPage={setPage} toast={toast} onPromote={onPromote} S={S} onOpenJob={(id) => { setJobId(id); setPageRaw("jobDetail"); }} editJob={data.jobs.find((j) => j.id === jobId)} />;
  else if (page === "jobDetail") content = <JobDetail job={data.jobs.find((j) => j.id === jobId)} S={S} toast={toast} onBack={() => setPage("jobs")} onPromote={onPromote} onEdit={() => setPage("editJob")} onDeleted={() => setPage("jobs")} onAddCandidate={() => { setAddCandidateJobId(jobId); setPage("uploadCandidates"); }} />;
  else if (page === "campaigns") content = <CampaignsPage toast={toast} S={S} />;
  else if (page === "interviews") content = <InterviewsPage toast={toast} S={S} />;
  else if (page === "billing") content = <BillingPage role={role} toast={toast} S={S} />;
  else if (page === "ads") content = <AdsPage role={role} toast={toast} onPromote={onPromote} S={S} />;
  else if (page === "users") content = role === "admin" ? <UsersPage toast={toast} S={S} /> : <OverviewRecOps S={S} />;
  else if (page === "settings") content = role === "admin" ? <SettingsPage toast={toast} S={S} /> : <OverviewRecOps S={S} />;
  else if (page === "myProfile") content = <MyProfilePage key={profileTab} initialTab={profileTab} S={S} toast={toast} onBack={() => setPage("overview")} />;
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
      <ErrorModal message={errorModalMsg} onClose={() => setErrorModalMsg("")} />
      <Modal open={idleLeft != null} onClose={() => { idleStore.touch(Date.now()); setIdleLeft(null); }} title="Are you still there?">
        <div className="text-sm mb-5" style={{ color: C.ink2 }}>For security, ProNext signs you out after {idleStore.label()} without activity. You'll be signed out in <span className="font-semibold" style={{ color: C.ink }}>{idleLeft != null ? Math.floor(idleLeft / 60) + ":" + String(idleLeft % 60).padStart(2, "0") : ""}</span>.</div>
        <div className="flex gap-2 justify-end"><Btn onClick={() => signOut()}>Sign out now</Btn><Btn kind="primary" onClick={() => { idleStore.touch(Date.now()); setIdleLeft(null); }}>Stay signed in</Btn></div>
      </Modal>
    </div>
  );
}
