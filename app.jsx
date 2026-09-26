import React, { useState } from "react";
import {
  LayoutDashboard, Users, Inbox as InboxIcon, Briefcase, TrendingUp, Send,
  CreditCard, Megaphone, Search, Bell, ChevronDown, ChevronRight, ChevronLeft,
  Plus, Download, Filter, Upload, Check, X, Lock, Copy, MessageSquare,
  Sparkles, AlertTriangle, Mail, MapPin, Clock, Settings, Shield,
  Phone, CheckCircle2, MoreHorizontal, UserPlus, Pencil,
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
  "Active file": "neutral", Placed: "em", Rejected: "danger",
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

const ROLE_KEY_LABEL = { admin: "Admin, owner", recops: "Rec Ops manager", recruiter: "Recruiter" };
const initialsOf = (n) => (n || "?").split(/[ @.]/).filter(Boolean).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
const fdate = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const ago = (d) => { const m = (Date.now() - new Date(d)) / 60000; return m < 60 ? Math.max(1, Math.round(m)) + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : m < 10080 ? Math.round(m / 1440) + "d ago" : fdate(d); };
const naira = (n) => "\u20A6" + Number(n || 0).toLocaleString("en-NG");
const num = (x) => Number(String(x || "").replace(/[^0-9.]/g, "")) || 0;
const mapUser = (p) => ({ id: p.id, name: p.full_name || p.email, role: ROLE_KEY_LABEL[p.role] || p.level, roleKey: p.role, email: p.email, status: p.status });

function mapAll(d) {
  const pm = {}; d.profiles.forEach((p) => (pm[p.id] = p));
  const pname = (id) => (pm[id] ? pm[id].full_name || pm[id].email : "");
  const cands = d.candidates.map((c) => ({
    id: c.id, name: c.name, role: c.role_title, location: c.location, recruiterId: c.recruiter_id,
    recruiter: c.recruiter_id ? pname(c.recruiter_id) : null, recruiterInit: c.recruiter_id ? initialsOf(pname(c.recruiter_id)) : "",
    status: c.status, ai: c.ai_score || 0, email: c.email_verified ? "Verified" : "Unverified", emailAddr: c.email || "", phone: c.phone || "", opens: c.opens,
    activity: ago(c.updated_at), createdAt: new Date(c.created_at).getTime(), experience: c.experience || "-", notice: c.notice || "-", pay: c.pay || "-",
    skills: c.skills || [], strengths: c.strengths || [], gaps: c.gaps || [], screening: c.screening || { state: "pending" }, matches: c.matches || [], portal: c.portal_token, source: c.source, cv: c.cv_path || null,
    endorsed: (c.candidate_endorsements || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((e) => ({ company: e.company, role: e.role_title, by: fdate(e.created_at) + " by " + pname(e.endorsed_by).split(" ")[0], status: e.status, next: e.next_step || "" })),
    comments: (c.candidate_comments || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((m) => ({ who: pname(m.author_id).split(" ")[0], role: ROLE_KEY_LABEL[(pm[m.author_id] || {}).role] || "", init: initialsOf(pname(m.author_id)), tone: "info", when: fdate(m.created_at), text: m.body })),
    timeline: (c.candidate_timeline || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((t) => ({ t: t.title, d: fdate(t.created_at), done: t.done })),
  }));
  const ends = d.candidates.flatMap((c) => c.candidate_endorsements || []);
  const jobs = d.jobs.map((j) => { const en = ends.filter((e) => e.company === j.client && e.role_title === j.role_title); return { id: j.id, role: j.role_title, client: j.client, description: j.description || "", location: j.location || "", minPay: j.min_pay, maxPay: j.max_pay, recruiters: (j.job_recruiters || []).map((r) => initialsOf(pname(r.recruiter_id))), submitted: en.length, interview: en.filter((e) => e.status === "Interview").length, days: Math.floor((Date.now() - new Date(j.created_at)) / 864e5), status: j.status, link: "harbor.link/j/" + j.link_slug }; });
  const inbox = d.applications.map((a) => ({ id: a.id, name: a.name, role: a.role_title, source: a.source || "-", ai: a.ai_score || 0, when: ago(a.created_at), assigned: a.assigned_to ? initialsOf(pname(a.assigned_to)) : null, assignedId: a.assigned_to, candidateId: a.candidate_id }));
  const today = new Date();
  const placements = d.placements.map((p) => ({ id: p.id, name: p.candidate_name, role: p.role_desc, recruiterId: p.recruiter_id, recruiter: initialsOf(pname(p.recruiter_id)), fee: naira(p.fee), guarantee: p.guarantee_ends ? (new Date(p.guarantee_ends) > today ? "Ends " : "Cleared ") + fdate(p.guarantee_ends) : "-", status: p.status, feeNum: Number(p.fee) }));
  const campaigns = d.campaigns.map((c) => ({ id: c.id, name: c.name, meta: pname(c.created_by).split(" ")[0] + " \u00b7 " + fdate(c.created_at), audience: c.audience ? c.audience.toLocaleString() : "-", delivered: c.delivered ? c.delivered.toLocaleString() : "-", opened: c.opened_pct || 0, status: c.status }));
  const ads = d.ads.map((a) => ({ id: a.id, job: a.job_title, client: a.client || "", channels: a.channels, payerType: a.payer_type, payer: a.payer_type === "agency" ? "Agency" : pname(a.created_by) + " (recruiter)", budget: naira(a.budget), spent: naira(a.spent), apps: a.applicants, status: a.status }));
  const set = d.settings || {};
  return { cands, jobs, inbox, placements, campaigns, ads, users: d.profiles.map(mapUser), settings: { name: set.agency_name || "Harbor Agency", guaranteeDays: set.guarantee_days || 60, ai: set.ai_screening !== false } };
}
function buildTeam(users, cands, placements) {
  return users.filter((u) => u.status === "Active" && (u.roleKey === "recruiter" || u.roleKey === "recops")).map((u) => {
    const mine = cands.filter((c) => c.recruiterId === u.id); const placed = mine.filter((c) => c.status === "Placed").length;
    const billed = placements.filter((p) => p.recruiterId === u.id && ["Ready", "Invoiced", "Paid"].includes(p.status)).reduce((a, p) => a + (p.feeNum || 0), 0);
    return { id: u.id, init: initialsOf(u.name), name: u.name, level: u.role, submissions: mine.length, interviews: mine.filter((c) => c.status === "Interview").length, placed, conv: mine.length ? Math.round((placed / mine.length) * 100) : 0, billed: naira(billed) };
  }).sort((a, b) => b.placed - a.placed).map((r, i) => ({ ...r, top: i === 0 && r.placed > 0 }));
}
const weekly = (cands) => { const b = Array(12).fill(0); cands.forEach((c) => { const w = Math.floor((Date.now() - c.createdAt) / 6048e5); if (w >= 0 && w < 12) b[11 - w]++; }); return b; };

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
function Avatar({ init, tone = "neutral", size = 36 }) {
  const t = TONE[tone] || TONE.neutral;
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
function KPIGrid({ children }) {
  return <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">{children}</div>;
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

function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center">
      <div className="absolute inset-0" style={{ background: "rgba(20,32,27,0.45)" }} onClick={onClose} />
      <div className="relative w-full md:max-w-lg rounded-t-2xl md:rounded-2xl p-5 md:p-6 overflow-y-auto" style={{ background: "#fff", maxHeight: "85vh" }}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-xl" style={{ ...SERIF }}>{title}</div>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: C.canvas }}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
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
  { key: "hiringTracker", label: "Hiring tracker", icon: TrendingUp },
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
  { key: "hiringTracker", label: "Hiring tracker", icon: TrendingUp },
  { key: "campaigns", label: "Campaigns", icon: Send },
  { key: "billing", label: "Billing", icon: CreditCard },
];
const MOBILE_TABS = {
  recops: [NAV_RECOPS[0], NAV_RECOPS[1], NAV_RECOPS[2], NAV_RECOPS[3]],
  recruiter: [NAV_RECRUITER[0], NAV_RECRUITER[1], NAV_RECRUITER[2], NAV_RECRUITER[4]],
  admin: [NAV_RECOPS[0], NAV_RECOPS[1], NAV_RECOPS[2], NAV_RECOPS[3]],
};
const ROLE_LABEL = { recops: "Rec Ops manager", recruiter: "Recruiter", admin: "Admin, owner" };
const ROLE_NAME = { recops: "Maya Okoye", recruiter: "Adaeze Nwosu", admin: "Ade Balogun" };
const ROLE_INIT = { recops: "MO", recruiter: "AN", admin: "AB" };

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
            <div className="text-xs" style={{ color: "#A9BBB1" }}>{pendingQ} candidates have screening questions ready to send.</div>
          </div>
          <button onClick={onSignOut} className="w-full text-left text-xs rounded-lg px-2 py-2" style={{ color: "#A9BBB1", border: "1px solid rgba(255,255,255,0.12)" }}>Sign out</button>
        </div>
      )}
      <div className="px-4 pb-5 pt-2 flex items-center gap-2.5">
        <Avatar init={me.init} tone="em" />
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white truncate">{me.name}</div>
            <div className="text-xs truncate" style={{ color: "#8FA69A" }}>{me.label}</div>
          </div>
        )}
      </div>
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
          <div className="text-xs px-3 pb-1" style={{ color: C.ink3 }}>{me.name} \u00b7 {me.label}</div>
          <button onClick={() => { onSignOut(); onClose(); }} className="w-full text-left text-sm rounded-xl px-3 py-2.5" style={{ color: C.dangerFg }}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

function TopBar({ query, setQuery }) {
  const desktop = useDesktop();
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
      <button className="w-10 h-10 md:w-11 md:h-11 rounded-xl border flex items-center justify-center relative shrink-0" style={{ borderColor: C.line, background: "#fff" }}>
        <Bell size={18} color={C.ink} />
        <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full" style={{ background: "#D9573B" }} />
      </button>
    </div>
  );
}

function MiniBars({ data, tone = C.em }) {
  const max = Math.max(1, ...data);
  return (
    <div className="flex items-end gap-1 h-9">
      {data.map((v, i) => <div key={i} className="rounded-sm flex-1" style={{ height: `${(v / max) * 100}%`, background: i === data.length - 1 ? tone : "#D4E9DE" }} />)}
    </div>
  );
}
const TREND = [8, 11, 9, 13, 12, 10, 14, 16, 13, 15, 14, 18];

/* Overview pages */
function statsOf(S) {
  const c = S.cands; const billable = S.placements.filter((p) => ["Ready", "Invoiced", "Paid"].includes(p.status));
  return { placed: c.filter((x) => x.status === "Placed").length, total: c.length, interviews: c.filter((x) => x.status === "Interview").length, billed: naira(billable.reduce((a, p) => a + (p.feeNum || 0), 0)), ready: S.placements.filter((p) => p.status === "Ready").length, month: new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" }).toUpperCase() };
}

function OverviewRecOps({ S }) {
  const [period, setPeriod] = useState("Monthly");
  const st = statsOf(S);
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <div className="text-xs font-semibold tracking-widest mb-1" style={{ color: C.ink3 }}>OVERVIEW &middot; {st.month}</div>
          <div className="text-3xl md:text-5xl mb-1" style={{ ...SERIF, color: C.ink }}>Good morning, {S.me.first}</div>
          <div className="text-sm" style={{ color: C.ink2 }}>Here is how the agency is performing this month.</div>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex rounded-xl border p-1" style={{ borderColor: C.line, background: "#fff" }}>
            {["Daily", "Weekly", "Monthly", "Yearly"].map((p) => (
              <button key={p} onClick={() => setPeriod(p)} className="rounded-lg px-3 py-2 text-xs font-medium" style={period === p ? { background: C.ink, color: "#fff" } : { color: C.ink2 }}>{p}</button>
            ))}
          </div>
          <Btn icon={Download} kind="dark" onClick={() => S.toast(downloadCSV("recruiter-performance.csv", S.team) ? "Exported recruiter-performance.csv" : "Nothing to export")}>Export</Btn>
        </div>
      </div>
      <KPIGrid>
        <KPI dark label="Placements" value={st.placed} foot="all time" />
        <KPI label="Candidates" value={st.total} foot="on file" />
        <KPI label="Interviews" value={st.interviews} foot="in interview now" />
        <KPI label="Billed" value={st.billed} foot={st.ready + " invoices ready"} />
      </KPIGrid>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <SectionTitle title="Submissions and placements" sub="New candidates per week, last 12 weeks" />
          <div className="mt-4"><MiniBars data={weekly(S.cands)} /></div>
        </Card>
        <Card>
          <SectionTitle title="Needs attention" />
          <div className="mt-3 flex flex-col">
            {[
              { icon: Sparkles, t: "AI screening questions", s: S.cands.filter((c) => c.screening.state === "pending").length + " sets waiting for approval", tone: "em", go: "candidates" },
              { icon: Clock, t: "Awaiting review", s: S.cands.filter((c) => c.status === "In review").length + " candidates in review", tone: "warn", go: "candidates" },
              { icon: InboxIcon, t: "Unassigned applications", s: S.inbox.filter((x) => !x.assigned).length + " in the inbox", tone: "info", go: "inbox" },
              { icon: AlertTriangle, t: "Placements in guarantee", s: S.placements.filter((p) => p.status === "Guarantee").length + " placements", tone: "danger", go: "billing" },
            ].map((r, i) => (
              <div key={i} className="flex items-center gap-3 py-3 cursor-pointer" onClick={() => S.go(r.go)} style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: TONE[r.tone].bg }}><r.icon size={17} color={TONE[r.tone].fg} /></div>
                <div className="flex-1 min-w-0"><div className="text-sm font-medium">{r.t}</div><div className="text-xs" style={{ color: C.ink2 }}>{r.s}</div></div>
                <ChevronRight size={16} color={C.ink3} className="shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card>
        <SectionTitle title="Recruiter performance" sub="September 2026, ranked by placements" />
        <div className="mt-3">
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
  const st = statsOf(S);
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <div className="text-xs font-semibold tracking-widest mb-1" style={{ color: C.ink3 }}>MY OVERVIEW &middot; {st.month}</div>
          <div className="text-3xl md:text-5xl mb-1" style={{ ...SERIF, color: C.ink }}>Good morning, {S.me.first}</div>
          <div className="text-sm" style={{ color: C.ink2 }}>Here is how your candidates are doing.</div>
        </div>
        <Btn icon={Download} kind="dark" onClick={() => S.toast(downloadCSV("recruiter-performance.csv", S.team) ? "Exported recruiter-performance.csv" : "Nothing to export")}>Export</Btn>
      </div>
      <KPIGrid>
        <KPI dark label="My placements" value={st.placed} foot="all time" />
        <KPI label="My candidates" value={st.total} foot="on file" />
        <KPI label="My interviews" value={st.interviews} foot="in interview now" />
        <KPI label="My billed" value={st.billed} foot="after guarantee" />
      </KPIGrid>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <SectionTitle title="My submissions and placements" sub="New candidates per week, last 12 weeks" />
          <div className="mt-4"><MiniBars data={weekly(S.cands)} /></div>
        </Card>
        <Card>
          <SectionTitle title="Your next steps" />
          <div className="mt-3 flex flex-col">
            {[
              { icon: Sparkles, t: "Role matches", s: S.cands.filter((c) => c.matches.length > 0).length + " candidates match other roles", tone: "em", go: "candidates" },
              { icon: InboxIcon, t: "Waiting on candidates", s: S.cands.filter((c) => c.screening.state === "sent").length + " awaiting screening replies", tone: "warn", go: "candidates" },
              { icon: Mail, t: "Answers to review", s: S.cands.filter((c) => c.screening.state === "answered").length + " sets of screening answers", tone: "info", go: "candidates" },
            ].map((r, i) => (
              <div key={i} className="flex items-center gap-3 py-3 cursor-pointer" onClick={() => S.go(r.go)} style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: TONE[r.tone].bg }}><r.icon size={17} color={TONE[r.tone].fg} /></div>
                <div className="flex-1 min-w-0"><div className="text-sm font-medium">{r.t}</div><div className="text-xs" style={{ color: C.ink2 }}>{r.s}</div></div>
                <ChevronRight size={16} color={C.ink3} className="shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* Candidates list */
function CandidatesList({ scope, data, openCandidate, setPage, S, toast }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("All");
  const [showF, setShowF] = useState(false);
  const [recF, setRecF] = useState("All");
  const [minAi, setMinAi] = useState(0);
  const gq = (S.query || "").toLowerCase();
  const hit = (c, t) => c.name.toLowerCase().includes(t) || c.role.toLowerCase().includes(t);
  const filtered = data.filter((c) => (tab === "All" || c.status === tab) && hit(c, q.toLowerCase()) && hit(c, gq) && (recF === "All" || c.recruiter === recF) && c.ai >= minAi);
  const tabs = ["All", "In review", "With client", "Interview", "Active file", "Placed", "Rejected"].map((t) => ({ key: t, label: t === "All" ? `All ${data.length}` : `${t} ${data.filter((c) => c.status === t).length}` }));
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title={scope === "recruiter" ? "Your candidate bench" : "All candidates"} sub={scope === "recruiter" ? "Every applicant you have sourced, and active file candidates ready to reuse." : `${data.length} candidates across every recruiter, client, and source.`} />
        <div className="flex gap-2.5">
          <Btn icon={Filter} onClick={() => setShowF((v) => !v)} className="flex-1 md:flex-none justify-center">Filter</Btn>
          <Btn icon={Download} onClick={() => toast(downloadCSV("candidates.csv", filtered.map(flat)) ? "Exported candidates.csv" : "Nothing to export")} className="flex-1 md:flex-none justify-center">Export</Btn>
          <Btn icon={Upload} kind="dark" className="flex-1 md:flex-none justify-center" onClick={() => setPage("uploadCandidates")}>Upload</Btn>
        </div>
      </div>
      <Card>
        {showF && (
          <div className="flex flex-wrap gap-3 mb-3 rounded-xl p-3" style={{ background: "#F6F3EC" }}>
            <select value={recF} onChange={(e) => setRecF(e.target.value)} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line }}>
              <option value="All">All recruiters</option>
              {S.team.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
            </select>
            <select value={minAi} onChange={(e) => setMinAi(Number(e.target.value))} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line }}>
              <option value={0}>Any AI score</option><option value={70}>AI 70+</option><option value={80}>AI 80+</option><option value={90}>AI 90+</option>
            </select>
            <button onClick={() => { setRecF("All"); setMinAi(0); }} className="text-xs" style={{ color: C.em }}>Clear</button>
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
            { key: "ai", label: "AI", render: (c) => <Pill tone={!c.ai ? "neutral" : c.ai >= 80 ? "em" : c.ai >= 70 ? "warn" : "danger"}>{c.ai || "-"}</Pill> },
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
  const [msg, setMsg] = useState("");
  const [reply, setReply] = useState("");
  const [fee, setFee] = useState("");
  const sug = S.jobs.find((j) => j.status === "Open" && !candidate.endorsed.some((e) => e.role === j.role && e.company === j.client));
  const [fwd, setFwd] = useState(S.jobs[0] ? S.jobs[0].id : 0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reassign, setReassign] = useState(null);
  const qaState = candidate.screening.state;
  const qaQuestions = candidate.screening.questions || [];
  const comments = candidate.comments;
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const candidateJobs = S.jobs.filter((j) => j.status !== "Closed");
  const [draftJobId, setDraftJobId] = useState(candidate.screening.jobId || (candidateJobs[0] ? candidateJobs[0].id : null));
  const draftQuestions = async () => {
    if (!draftJobId) { setAiErr("Pick a role first"); return; }
    setAiBusy(true); setAiErr("");
    try { await S.aiScreen("draft_questions", { candidateId: candidate.id, jobId: draftJobId }); toast("Screening questions drafted"); }
    catch (e) { setAiErr(e.message); }
    setAiBusy(false);
  };
  const reviewReply = async () => {
    if (!reply.trim()) { toast("Paste the candidate's reply first"); return; }
    setAiBusy(true); setAiErr("");
    try { await S.aiScreen("review_answer", { candidateId: candidate.id, jobId: draftJobId, answerText: reply.trim() }); setReply(""); toast("AI reviewed the reply"); }
    catch (e) { setAiErr(e.message); }
    setAiBusy(false);
  };
  const attachCv = async (file) => {
    setAiBusy(true); setAiErr("");
    try { const b64 = await fileToBase64(file); await S.aiScreen("score_cv", { candidateId: candidate.id, fileBase64: b64, mediaType: "application/pdf", jobId: draftJobId }); toast("CV scored"); }
    catch (e) { setAiErr(e.message); }
    setAiBusy(false);
  };
  const rescoreCv = async () => {
    setAiBusy(true); setAiErr("");
    try { await S.aiScreen("score_cv", { candidateId: candidate.id, jobId: draftJobId }); toast("Re-scored"); }
    catch (e) { setAiErr(e.message); }
    setAiBusy(false);
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
    else if (opt === "Mark placed") { setPanel("placed"); }
    else { setStatus("In review"); toast("Status set to hold"); }
  };
  const setQa = (x) => patch((c) => ({ screening: { ...c.screening, ...x } }));
  const approveQ = () => { setQa({ state: "sent" }); toast("Marked as sent. Send the questions to " + candidate.name.split(" ")[0] + " by email or WhatsApp."); };
  const markPlaced = () => {
    const amt = num(fee); if (!amt) { toast("Enter the placement fee"); return; }
    const e = candidate.endorsed[candidate.endorsed.length - 1];
    S.setPlacements((l) => [{ id: uid(), name: candidate.name, role: e ? e.role + ", " + e.company : candidate.role, recruiterId: candidate.recruiterId, recruiter: candidate.recruiterInit, fee: naira(amt), feeNum: amt, guarantee: "Guarantee " + S.settings.guaranteeDays + " days", status: "Guarantee" }, ...l]);
    setStatus("Placed"); setPanel(null); setFee(""); toast("Marked as placed");
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
              <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Pay</label><input value={editForm.pay} onChange={(e) => setEditForm((f) => ({ ...f, pay: e.target.value }))} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
            </div>
            <Btn kind="primary" full onClick={saveEdit}>Save changes</Btn>
          </div>
        )}
      </Modal>
      <Modal open={panel === "placed"} onClose={() => setPanel(null)} title="Mark as placed">
        <label className="text-xs font-medium" style={{ color: C.ink2 }}>Placement fee (₦)</label>
        <input value={fee} onChange={(e) => setFee(e.target.value)} placeholder="e.g. 1,500,000" className="w-full mt-1.5 mb-4 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} />
        <Btn kind="primary" full onClick={markPlaced}>Confirm placement</Btn>
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
                <div className="text-sm flex items-center gap-1" style={{ color: C.ink2 }}><MapPin size={13} />{candidate.location}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
              <Btn icon={Pencil} onClick={openEdit} className="flex-1 sm:flex-none justify-center">Edit</Btn>
              <Btn icon={MessageSquare} onClick={() => setPanel("msg")} className="flex-1 sm:flex-none justify-center">Message</Btn>
              {S.role !== "recruiter" && <Btn onClick={() => setPanel("fwd")} className="flex-1 sm:flex-none justify-center">Forward</Btn>}
              <div className="relative flex-1 sm:flex-none">
                <Btn kind="primary" className="w-full justify-center" onClick={() => setMenuOpen((m) => !m)}>Update status</Btn>
                {menuOpen && (
                  <div className="absolute right-0 top-11 rounded-xl border shadow-lg z-10 w-56 py-1" style={{ background: "#fff", borderColor: C.line }}>
                    {["Hold", ...(S.role !== "recruiter" ? ["Approve, forward to client"] : []), "Not a fit for this role", ...(S.role !== "recruiter" ? ["Mark placed"] : []), "Reject"].map((o) => (
                      <button key={o} onClick={() => doStatus(o)} className="w-full text-left px-3.5 py-2.5 text-sm" style={{ color: o === "Reject" ? C.dangerFg : C.ink }}>{o}</button>
                    ))}
                  </div>
                )}
              </div>
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              {[["Experience", candidate.experience], ["Notice", candidate.notice], ["Pay", candidate.pay], ["Skills", candidate.skills.slice(0, 2).join(", ")]].map(([l, v]) => (
                <div key={l} className="min-w-0"><div className="text-xs" style={{ color: C.ink3 }}>{l}</div><div className="text-sm font-medium mt-0.5 truncate">{v}</div></div>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 pt-4 text-sm" style={{ borderTop: `1px solid ${C.line}` }}>
              <div className="flex items-center gap-2 min-w-0" style={{ color: C.ink2 }}><Mail size={15} className="shrink-0" /><span className="truncate">{candidate.emailAddr || "No email on file"}</span></div>
              <div className="flex items-center gap-2" style={{ color: C.ink2 }}><Phone size={15} />{candidate.phone || "No phone on file"}</div>
            </div>
          </Card>

          <Card>
            <div className="overflow-x-auto"><Tabs tabs={[{ key: "companies", label: "Companies" }, { key: "discussion", label: "Discussion" }, { key: "timeline", label: "Timeline" }]} active={tab} setActive={setTab} /></div>
            {tab === "companies" && (
              <div className="mt-4">
                {candidate.endorsed.length === 0 && <div className="text-sm py-6 text-center" style={{ color: C.ink3 }}>Not yet endorsed to a company.</div>}
                {candidate.endorsed.map((e, i) => (
                  <div key={i} className="flex items-center gap-3 py-3" style={{ borderTop: i ? `1px solid ${C.line}` : "none" }}>
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center font-semibold shrink-0" style={{ background: C.canvas }}>{e.company[0]}</div>
                    <div className="flex-1 min-w-0"><div className="font-medium text-sm">{e.company}</div><div className="text-xs" style={{ color: C.ink2 }}>{e.role}</div></div>
                    <div className="text-right shrink-0"><StatusPill status={e.status} /><div className="text-xs mt-1" style={{ color: C.ink3 }}>{e.next}</div></div>
                  </div>
                ))}
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
          <Card>
            <div className="flex justify-between items-center mb-3 gap-2"><SectionTitle title="AI review" size="text-xl" /><Pill tone="warn">Internal</Pill></div>
            <div className="flex items-center gap-4 mb-4"><div className="text-3xl" style={{ ...SERIF }}>{candidate.ai || "-"}</div><div className="text-sm font-medium">Match for {candidate.role}</div></div>
            {candidate.strengths.length > 0 && (<><div className="text-xs font-semibold mb-1.5" style={{ color: C.ink3 }}>STRENGTHS</div>{candidate.strengths.map((s, i) => <div key={i} className="flex gap-2 text-sm mb-1"><Check size={15} color={C.em} className="mt-0.5 shrink-0" />{s}</div>)}</>)}
            {candidate.gaps.length > 0 && (<><div className="text-xs font-semibold mb-1.5 mt-3" style={{ color: C.ink3 }}>GAPS</div>{candidate.gaps.map((s, i) => <div key={i} className="flex gap-2 text-sm mb-1"><AlertTriangle size={15} color={C.warnFg} className="mt-0.5 shrink-0" />{s}</div>)}</>)}
            {aiErr && <div className="text-xs mt-3 rounded-lg p-2" style={{ background: C.dangerBg, color: C.dangerFg }}>{aiErr}</div>}
            <div className="rounded-xl p-3.5 mt-3" style={{ background: "#F6F3EC" }}>
              {candidate.cv ? (
                <><div className="flex items-center justify-between gap-2 text-sm"><span style={{ color: C.ink2 }}>CV on file</span><Btn onClick={rescoreCv} disabled={aiBusy} className="text-xs px-3 py-1.5">{aiBusy ? <>Scoring <InlineDots color="#fff" /></> : "Re-score"}</Btn></div><label className="text-xs mt-2 inline-block cursor-pointer" style={{ color: C.infoFg }}>Replace CV<input type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files[0] && attachCv(e.target.files[0])} /></label></>
              ) : (
                <><div className="text-sm font-medium mb-1">No CV on file</div><label className="inline-flex items-center gap-2 text-xs px-3 py-2 rounded-lg border cursor-pointer" style={{ borderColor: C.line }}><Upload size={13} />Attach a PDF to score<input type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files[0] && attachCv(e.target.files[0])} /></label></>
              )}
            </div>
            <div className="rounded-xl p-3.5 mt-3" style={{ background: "#F6F3EC" }}>
              {qaState === "pending" && qaQuestions.length === 0 && (
                <>
                  <div className="text-sm font-medium mb-1.5">Draft screening questions</div>
                  <div className="text-xs mb-2.5" style={{ color: C.ink2 }}>AI writes 3 questions from the job description — a skills check, salary expectation, and start date.</div>
                  {candidateJobs.length > 0 ? (
                    <>
                      <select value={draftJobId || ""} onChange={(e) => setDraftJobId(e.target.value)} className="w-full mb-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line }}>
                        {candidateJobs.map((j) => <option key={j.id} value={j.id}>{j.role}, {j.client}</option>)}
                      </select>
                      <Btn kind="primary" full onClick={draftQuestions} disabled={aiBusy}>{aiBusy ? <>Drafting <InlineDots color="#fff" /></> : "Draft with AI"}</Btn>
                    </>
                  ) : <div className="text-xs" style={{ color: C.ink3 }}>Post a job first, then come back to draft questions against it.</div>}
                </>
              )}
              {qaState === "pending" && qaQuestions.length > 0 && (
                <>
                  <div className="flex items-center gap-2 text-sm font-medium mb-1.5"><Sparkles size={15} color={C.em} /> {qaQuestions.length} screening questions ready</div>
                  {qaQuestions.map((q, i) => <div key={i} className="text-xs mb-1" style={{ color: C.ink2 }}>{i + 1}. {q}</div>)}
                  <Btn kind="primary" full className="mt-2" onClick={approveQ}>Approve and send</Btn>
                </>
              )}
              {qaState === "sent" && (
                <>
                  {qaQuestions.length > 0 && <div className="mb-2">{qaQuestions.map((q, i) => <div key={i} className="text-xs mb-1" style={{ color: C.ink2 }}>{i + 1}. {q}</div>)}</div>}
                  <div className="text-sm mb-2" style={{ color: C.ink2 }}>Waiting for {candidate.name.split(" ")[0]}'s reply. Paste it here when it arrives, and AI will review it.</div>
                  <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} className="w-full rounded-lg border px-3 py-2 text-sm outline-none mb-2" style={{ borderColor: C.line, background: "#fff" }} />
                  <Btn kind="primary" full onClick={reviewReply} disabled={aiBusy}>{aiBusy ? <>AI is reviewing <InlineDots color="#fff" /></> : "Get AI verdict"}</Btn>
                </>
              )}
              {qaState === "answered" && (
                <>
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium"><Sparkles size={15} color={C.em} /> AI verdict</div>
                    {candidate.screening.verdict && <Pill tone={candidate.screening.verdict === "Perfect fit" ? "em" : candidate.screening.verdict === "Possible fit" ? "warn" : "danger"}>{candidate.screening.verdict}</Pill>}
                  </div>
                  {candidate.screening.reasoning && <div className="text-sm mb-3" style={{ color: C.ink2 }}>{candidate.screening.reasoning}</div>}
                  {(candidate.screening.qa || []).map((qa, i) => (<div key={i} className="py-2" style={{ borderTop: i ? `1px solid ${C.line}` : `1px solid ${C.line}` }}><div className="text-sm font-medium">{qa.q}</div><div className="text-sm" style={{ color: C.ink2 }}>{qa.a}</div></div>))}
                </>
              )}
            </div>
          </Card>
          <Card>
            <SectionTitle title="Candidate page" sub="Their secure link. No login needed." size="text-xl" />
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 mt-3 text-sm" style={{ background: C.canvas }}><Lock size={14} color={C.ink2} className="shrink-0" /><span style={{ color: C.ink2 }} className="truncate">{window.location.host + "/?c=" + candidate.portal}</span><Copy size={15} color={C.ink2} className="ml-auto cursor-pointer shrink-0" onClick={() => { try { navigator.clipboard.writeText(window.location.origin + window.location.pathname + "?c=" + candidate.portal); toast("Link copied"); } catch (e) { toast("Copy failed. Select the link and copy it."); } }} /></div>
          </Card>
          {candidate.matches.length > 0 && (
            <Card>
              <SectionTitle title="Other roles they match" sub="Shown to candidate at 70% or higher." size="text-xl" />
              {candidate.matches.map((m, i) => (<div key={i} className="flex items-center justify-between py-2.5 gap-2" style={{ borderTop: `1px solid ${C.line}` }}><div className="min-w-0"><div className="text-sm font-medium truncate">{m.role}</div><div className="text-xs" style={{ color: C.ink2 }}>{m.company}</div></div><Pill tone="em">{m.fit}%</Pill></div>))}
            </Card>
          )}
        </div>
      </div>
    </div>
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

function JobDetail({ job, S, toast, onBack, onPromote }) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (!job) return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Jobs</button>
      <div className="text-sm" style={{ color: C.ink3 }}>This job could not be found.</div>
    </div>
  );
  const candidates = S.cands.filter((c) => c.endorsed.some((e) => e.company === job.client && e.role === job.role));
  const setStatus = (v) => S.setJobStatus(job.id, v);
  const copyLink = () => { try { navigator.clipboard.writeText("https://" + job.link); toast("Link copied"); } catch (e) { toast("Copy failed. Select the link and copy it."); } };
  const fits = suggestFits(job, S.cands);
  const reroute = (c) => {
    S.updateCand(c.id, (cc) => ({ status: "With client", endorsed: [...cc.endorsed, { company: job.client, role: job.role, by: todayStr() + " by " + S.me.first, status: "With client", next: "Awaiting feedback" }], timeline: [...cc.timeline, { t: "Rerouted to " + job.role + ", " + job.client, d: todayStr(), done: true }] }));
    toast(c.name + " rerouted to " + job.role);
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
            <Btn onClick={() => onPromote(job.role)}>Promote</Btn>
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
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mb-4">
          <StatusPill status={job.status} />
          {job.recruiters.length > 0 && <Pill tone="neutral">{job.recruiters.length} recruiter{job.recruiters.length > 1 ? "s" : ""} on this role</Pill>}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
          <div><div className="text-xs" style={{ color: C.ink3 }}>Submitted</div><div className="text-sm font-medium mt-0.5">{job.submitted}</div></div>
          <div><div className="text-xs" style={{ color: C.ink3 }}>Interview</div><div className="text-sm font-medium mt-0.5">{job.interview}</div></div>
          <div><div className="text-xs" style={{ color: C.ink3 }}>Open</div><div className="text-sm font-medium mt-0.5">{job.days}d</div></div>
        </div>
        {(job.location || job.minPay || job.maxPay) && (
          <div className="flex flex-wrap gap-4 mb-4 text-sm" style={{ color: C.ink2 }}>
            {job.location && <span>{job.location}</span>}
            {(job.minPay || job.maxPay) && <span>{job.minPay ? naira(job.minPay) : "?"} – {job.maxPay ? naira(job.maxPay) : "?"} / year</span>}
          </div>
        )}
        {job.description && (
          <div className="mb-4 pt-4 text-sm whitespace-pre-wrap" style={{ borderTop: `1px solid ${C.line}`, color: C.ink2 }}>{job.description}</div>
        )}
        <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm" style={{ background: C.canvas }}><Lock size={14} color={C.ink2} className="shrink-0" /><span style={{ color: C.ink2 }} className="truncate">{job.link}</span></div>
      </Card>
      {S.role !== "recruiter" && fits.length > 0 && (
        <Card>
          <SectionTitle title="Candidates who might fit this role" sub="From your existing bench, matched on skills and role — nothing moves until you reroute them." size="text-xl" />
          <div className="flex flex-col gap-2 mt-3">
            {fits.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl border p-3" style={{ borderColor: C.line }}>
                <div className="flex items-center gap-3 min-w-0 cursor-pointer" onClick={() => S.openCandidate(c.id)}>
                  <Avatar init={c.name.split(" ").map((x) => x[0]).join("")} tone="em" />
                  <div className="min-w-0"><div className="font-medium text-sm truncate">{c.name}</div><div className="text-xs truncate" style={{ color: C.ink2 }}>{c.role}{c.recruiter ? " · " + c.recruiter : ""}</div></div>
                </div>
                <Btn kind="primary" onClick={() => reroute(c)} className="shrink-0">Reroute</Btn>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <SectionTitle title="Candidates on this role" sub={candidates.length + " submitted so far"} size="text-xl" />
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
              { key: "status", label: "STATUS", render: (c) => <StatusPill status={c.status} /> },
              { key: "ai", label: "AI", render: (c) => <Pill tone={!c.ai ? "neutral" : c.ai >= 80 ? "em" : c.ai >= 70 ? "warn" : "danger"}>{c.ai || "-"}</Pill> },
            ]}
          />
        </div>
      </Card>
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

function PostJobForm({ setPage, toast, onPromote, S, onOpenJob }) {
  const [title, setTitle] = useState("");
  const [client, setClient] = useState("");
  const [location, setLocation] = useState("Lagos, Nigeria");
  const [minPay, setMinPay] = useState("");
  const [maxPay, setMaxPay] = useState("");
  const [description, setDescription] = useState("");
  const [done, setDone] = useState(null); // { link, id, status, title, client }
  const inp = "w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none";
  const inpStyle = { borderColor: C.line, background: "#FAF8F3" };
  const publish = (status) => {
    if (!title.trim() || !client.trim()) { toast("Add a job title and client"); return; }
    const id = uid();
    const slug = (client[0] + title.split(" ").map((w) => w[0]).join("")).toLowerCase() + "-" + String(S.jobs.length + 1).padStart(2, "0");
    const link = "harbor.link/j/" + slug;
    S.setJobs((l) => [{ id, role: title, client, location, minPay: num(minPay) || null, maxPay: num(maxPay) || null, description, recruiters: [], submitted: 0, interview: 0, days: 0, status, link }, ...l]);
    setDone({ link, id, status, title, client });
    toast(status === "Draft" ? "Saved as draft" : "Job published");
  };
  const reset = () => { setDone(null); setTitle(""); setClient(""); setMinPay(""); setMaxPay(""); setDescription(""); };
  const copyLink = () => { try { navigator.clipboard.writeText("https://" + done.link); toast("Link copied"); } catch (e) { toast("Copy failed. Select the link and copy it."); } };

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <button onClick={() => setPage("jobs")} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Jobs</button>
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="Post a new job" sub="Publishing creates a unique link for candidates and recruiters." />
        <div className="flex gap-2">
          <Btn onClick={() => publish("Draft")} className="flex-1 md:flex-none justify-center">Save as draft</Btn>
          <Btn kind="primary" className="flex-1 md:flex-none justify-center" onClick={() => publish("Open")}>Publish job</Btn>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <Card className="md:col-span-2 flex flex-col gap-4">
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Job title</label><input value={title} onChange={(e) => setTitle(e.target.value)} className={inp} style={inpStyle} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Client</label><input value={client} onChange={(e) => setClient(e.target.value)} className={inp} style={inpStyle} /></div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Location</label><input value={location} onChange={(e) => setLocation(e.target.value)} className={inp} style={inpStyle} /></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Minimum salary (₦)</label><input value={minPay} onChange={(e) => setMinPay(e.target.value)} className={inp} style={inpStyle} /></div>
            <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Maximum salary (₦)</label><input value={maxPay} onChange={(e) => setMaxPay(e.target.value)} className={inp} style={inpStyle} /></div>
          </div>
          <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Job description</label><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Describe the role, responsibilities, and what success looks like..." className={inp} style={inpStyle} /></div>
          <div className="pt-3 flex items-center justify-between gap-3" style={{ borderTop: `1px solid ${C.line}` }}>
            <div><div className="text-sm font-medium">Auto-rate candidates</div><div className="text-xs" style={{ color: C.ink2 }}>AI reviews and rates every applicant.</div></div>
            <div className="w-10 h-6 rounded-full flex items-center px-0.5 shrink-0" style={{ background: C.em }}><div className="w-5 h-5 rounded-full bg-white ml-auto" /></div>
          </div>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <SectionTitle title="Job link" sub="Generated when you publish." size="text-xl" />
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 mt-3 text-sm" style={{ background: C.canvas }}><Lock size={14} color={C.ink2} className="shrink-0" /><span style={{ color: C.ink2 }} className="truncate">harbor.link/j/••••••</span></div>
            <div className="mt-2"><Pill tone="neutral">Draft until published</Pill></div>
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
  const [channels, setChannels] = useState({ GJ: true, LI: true, FB: false, GA: false });
  const [budget, setBudget] = useState("300,000");
  const [payer, setPayer] = useState("agency");
  const [copy, setCopy] = useState(`We're hiring: ${jobTitle}. Competitive pay, remote-friendly, fast interview process. Apply through Harbor today.`);

  React.useEffect(() => {
    setCopy(`We're hiring: ${jobTitle}. Competitive pay, remote-friendly, fast interview process. Apply through Harbor today.`);
  }, [jobTitle, open]);

  const toggle = (k) => setChannels((c) => ({ ...c, [k]: !c[k] }));
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
        {AD_CHANNELS.map((ch) => (
          <button key={ch.key} onClick={() => toggle(ch.key)} className="flex items-center gap-3 rounded-xl border p-3 text-left" style={{ borderColor: channels[ch.key] ? C.em : C.line, background: channels[ch.key] ? C.emTint : "#fff" }}>
            <div className="w-9 h-9 rounded-lg flex items-center justify-center font-semibold shrink-0" style={{ fontSize: 11, background: CHANNEL_TONE[ch.key].bg, color: CHANNEL_TONE[ch.key].fg }}>{ch.key}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium flex items-center gap-2">{ch.name}{ch.free && <Pill tone="em">Free</Pill>}</div>
              <div className="text-xs" style={{ color: C.ink2 }}>{ch.desc}</div>
            </div>
            <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: channels[ch.key] ? C.em : "#fff", border: channels[ch.key] ? "none" : `1.5px solid #D5D2C7` }}>
              {channels[ch.key] && <Check size={13} color="#fff" strokeWidth={3} />}
            </div>
          </button>
        ))}
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
   Contains: Inbox, HiringTracker, Campaigns, Billing, Ads, Users, Settings,
   UploadCandidates, CandidatePortal and the App root (default export).
   ====================================================================== */

const STAGES = ["Submitted", "In review", "Interview", "Offer", "Placed"];
function HiringTracker({ role, S }) {
  const rows = (role === "recruiter" ? S.jobs.filter((j) => j.recruiters.includes(S.me.init)) : S.jobs).filter((j) => j.status !== "Closed");
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <SectionTitle size="text-3xl md:text-4xl" title="Hiring tracker" sub="Where every open role sits in the pipeline." />
      <Card>
        <DataTable
          rows={rows}
          columns={[
            { key: "role", label: "ROLE", render: (j) => <div><div className="font-medium">{j.role}</div><div className="text-xs" style={{ color: C.ink2 }}>{j.client}</div></div> },
            { key: "submitted", label: "SUBMITTED", render: (j) => j.submitted },
            { key: "interview", label: "INTERVIEW", render: (j) => j.interview },
            { key: "pipe", label: "PIPELINE", render: (j) => <div className="flex items-center gap-2"><ProgressBar w={100} pct={(j.interview / Math.max(1, j.submitted)) * 300} /><span className="text-xs">{Math.round((j.interview / Math.max(1, j.submitted)) * 100)}% reach interview</span></div> },
            { key: "days", label: "OPEN", render: (j) => `${j.days}d` },
            { key: "status", label: "STATUS", render: (j) => <StatusPill status={j.status} /> },
          ]}
        />
      </Card>
      <div className="text-xs" style={{ color: C.ink3 }}>Stages: {STAGES.join(", ")}.</div>
    </div>
  );
}

function CampaignsPage({ toast, S }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [aud, setAud] = useState("");
  const create = () => {
    if (!name.trim()) { toast("Name the campaign"); return; }
    S.setCampaigns((l) => [{ id: uid(), name, meta: S.me.first + " \u00b7 Not scheduled", audience: aud || "-", delivered: "-", opened: 0, status: "Draft" }, ...l]);
    setName(""); setAud(""); setOpen(false); toast("Draft created");
  };
  /* DEMO: in production this hands the send to your email provider */
  const send = (n) => { S.setCampaigns((l) => l.map((c) => (c.name === n ? { ...c, status: "Sent", delivered: c.audience, meta: c.meta.split(" \u00b7 ")[0] + " \u00b7 " + todayStr() } : c))); toast("Campaign sent"); };
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
    </div>
  );
}

function BillingPage({ role, toast, S }) {
  const list = role === "recruiter" ? S.placements.filter((p) => p.recruiterId === S.me.id) : S.placements;
  const setSt = (n, st, msg) => { S.setPlacements((l) => l.map((p) => (p.name === n ? { ...p, status: st } : p))); toast(msg); };
  const count = (s) => list.filter((p) => p.status === s).length;
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <SectionTitle size="text-3xl md:text-4xl" title="Billing" sub="Fees are invoiced once the guarantee period clears." />
      <KPIGrid>
        <KPI dark label="Ready to invoice" value={count("Ready")} foot="Guarantee cleared" />
        <KPI label="In guarantee" value={count("Guarantee")} foot="Not billable yet" />
        <KPI label="Paid" value={count("Paid") + count("Invoiced")} foot="Invoiced or paid" />
        <KPI label="Fallout" value={count("Fallout")} foot="Left in guarantee" />
      </KPIGrid>
      <Card>
        <DataTable
          keyField="name"
          rows={list}
          columns={[
            { key: "name", label: "PLACEMENT", render: (p) => <div><div className="font-medium">{p.name}</div><div className="text-xs" style={{ color: C.ink2 }}>{p.role}</div></div> },
            { key: "recruiter", label: "RECRUITER", render: (p) => <Avatar init={p.recruiter} tone={PEOPLE_TONE[p.recruiter]} size={26} /> },
            { key: "fee", label: "FEE", render: (p) => <span className="font-medium">{p.fee}</span> },
            { key: "guarantee", label: "GUARANTEE", render: (p) => <span className="text-xs" style={{ color: C.ink2 }}>{p.guarantee}</span> },
            { key: "status", label: "STATUS", render: (p) => (
              <div className="flex items-center gap-2">
                <StatusPill status={p.status} />
                {p.status === "Ready" && role !== "recruiter" && <button onClick={() => setSt(p.name, "Invoiced", "Invoice created for " + p.name)} className="text-xs" style={{ color: C.em }}>Invoice</button>}
                {p.status === "Invoiced" && role !== "recruiter" && <button onClick={() => setSt(p.name, "Paid", "Marked paid: " + p.name)} className="text-xs" style={{ color: C.em }}>Mark paid</button>}
              </div>
            ) },
          ]}
        />
      </Card>
    </div>
  );
}

function AdsPage({ role, toast, onPromote, S }) {
  const ads = S.ads;
  const setAdStatus = (id, st, msg) => { S.setAds((l) => l.map((a) => (a.id === id ? { ...a, status: st } : a))); toast(msg); };
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
          ]}
        />
      </Card>
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
  const ROLE_OPTIONS = [["recruiter", "Recruiter"], ["recops", "Rec Ops manager"], ["admin", "Admin"]];
  const invite = async () => {
    if (!name.trim()) { toast("Enter their name"); return; }
    if (!email.includes("@")) { toast("Enter a valid email"); return; }
    if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) { toast("That email already has an account"); return; }
    if (pass.length < 8) { toast("Password must be at least 8 characters"); return; }
    setBusy(true);
    try { await S.createAccount({ email, password: pass, full_name: name, role: roleKey }); setName(""); setEmail(""); setPass(""); setOpen(false); toast("Account created for " + name); }
    catch (e) { toast(e.message || "Could not create account"); }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <SectionTitle size="text-3xl md:text-4xl" title="Users and permissions" sub="Control who can see and do what." />
        <Btn kind="primary" icon={UserPlus} onClick={() => setOpen(true)}>Invite user</Btn>
      </div>
      <Card>
        <DataTable
          keyField="email"
          rows={users}
          columns={[
            { key: "name", label: "USER", render: (u) => <div><div className="font-medium">{u.name}</div><div className="text-xs" style={{ color: C.ink2 }}>{u.email}</div></div> },
            { key: "role", label: "ROLE", render: (u) => u.role },
            { key: "status", label: "STATUS", render: (u) => <StatusPill status={u.status} /> },
            { key: "act", label: "", render: (u) => u.roleKey === "admin" ? null : <button onClick={() => S.disableUser(u.id).then(() => toast("Account disabled"))} className="text-xs" style={{ color: C.dangerFg }}>Disable</button> },
          ]}
        />
      </Card>
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
        <div className="text-xs mt-2" style={{ color: C.ink3 }}>Share this email and password with them directly. They can change the password after signing in.</div>
      </Modal>
    </div>
  );
}

function SettingsPage({ toast, S }) {
  const [name, setName] = useState(S.settings.name);
  const [guarantee, setGuarantee] = useState(String(S.settings.guaranteeDays));
  const [auto, setAuto] = useState(S.settings.ai);
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <SectionTitle size="text-3xl md:text-4xl" title="Agency settings" sub="Defaults that apply across the whole agency." />
      <Card className="flex flex-col gap-4 md:max-w-xl">
        <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Agency name</label><input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
        <div><label className="text-xs font-medium" style={{ color: C.ink2 }}>Guarantee period (days)</label><input value={guarantee} onChange={(e) => setGuarantee(e.target.value)} className="w-full mt-1.5 rounded-lg border px-3.5 py-2.5 text-sm outline-none" style={{ borderColor: C.line, background: "#FAF8F3" }} /></div>
        <button onClick={() => setAuto(!auto)} className="pt-3 flex items-center justify-between gap-3 text-left" style={{ borderTop: `1px solid ${C.line}` }}>
          <div><div className="text-sm font-medium">AI screening questions</div><div className="text-xs" style={{ color: C.ink2 }}>Draft questions for every new candidate. You approve before they send.</div></div>
          <div className="w-10 h-6 rounded-full flex items-center px-0.5 shrink-0" style={{ background: auto ? C.em : "#D5D2C7" }}><div className={`w-5 h-5 rounded-full bg-white ${auto ? "ml-auto" : ""}`} /></div>
        </button>
        <Btn kind="primary" onClick={() => { S.saveSettings({ name, guaranteeDays: num(guarantee) || 60, ai: auto }); toast("Settings saved"); }}>Save changes</Btn>
      </Card>
    </div>
  );
}

const fileToBase64 = (f) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = reject;
  r.readAsDataURL(f);
});

function UploadCandidates({ setPage, toast, S }) {
  const [file, setFile] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const upload = async () => {
    if (!files.length) { toast("Choose a file first"); return; }
    setBusy(true);
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
    const others = files.filter((f) => !/\.pdf$/i.test(f.name));
    let count = 0, aiFailures = 0;

    // CSV rows and non-PDF files: added as before, no AI score yet.
    const added = [];
    for (const f of others) {
      if (/\.csv$/i.test(f.name)) {
        const lines = (await f.text()).split(/\r?\n/).filter(Boolean);
        const head = lines[0].toLowerCase().split(",").map((h) => h.trim());
        lines.slice(1).forEach((ln) => { const v = ln.split(","); const g = (k) => (v[head.indexOf(k)] || "").trim(); if (g("name")) added.push({ name: g("name"), role: g("role") || "Unspecified", location: g("location") || "Lagos, Nigeria", emailAddr: g("email"), phone: g("phone") }); });
      } else added.push({ name: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "), role: "Unspecified", location: "Lagos, Nigeria" });
    }
    if (added.length) {
      S.setCands((l) => [...added.map((a) => newCandidate({ ...a, recruiter: S.me.name, recruiterId: S.me.id, recruiterInit: S.me.init, ai: 0, timeline: [{ t: "Uploaded by " + S.me.first, d: todayStr(), done: true }] })), ...l]);
      count += added.length;
    }

    // PDFs: inserted first, then handed to AI for real scoring (skills, strengths, gaps, ai_score).
    for (const f of pdfs) {
      setStatus("Scoring " + f.name + "…");
      const c = newCandidate({ name: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "), role: "Unspecified", location: "Lagos, Nigeria", recruiter: S.me.name, recruiterId: S.me.id, recruiterInit: S.me.init, ai: 0, timeline: [{ t: "Uploaded by " + S.me.first, d: todayStr(), done: true }] });
      try {
        await S.insertCandidateAwait(c);
        const b64 = await fileToBase64(f);
        await S.aiScreen("score_cv", { candidateId: c.id, fileBase64: b64, mediaType: "application/pdf" });
        count++;
      } catch (e) { aiFailures++; toast(f.name + ": " + e.message); }
    }

    setBusy(false); setStatus("");
    if (!count) { toast("No candidates found. CSV needs name, role and location columns."); return; }
    toast(count + " candidate(s) added" + (aiFailures ? `, ${aiFailures} not AI-scored` : ""));
    setPage("candidates");
  };
  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <button onClick={() => setPage("candidates")} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Candidates</button>
      <SectionTitle size="text-3xl md:text-4xl" title="Upload candidates" sub="Add a PDF CV (AI reads and scores it), a spreadsheet, or other files." />
      <Card className="md:max-w-xl">
        <label className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-10 cursor-pointer text-center" style={{ borderColor: "#D5D2C7", background: "#FAF8F3" }}>
          <Upload size={22} color={C.ink2} />
          <div className="text-sm font-medium">{file || "Choose files"}</div>
          <div className="text-xs" style={{ color: C.ink3 }}>PDF (AI-scored), DOCX or CSV</div>
          <input type="file" multiple className="hidden" onChange={(e) => { setFiles(Array.from(e.target.files)); setFile(e.target.files.length ? `${e.target.files.length} file(s) selected` : ""); }} />
        </label>
        <div className="mt-4"><Btn kind="primary" full onClick={upload} disabled={busy}>{busy ? <>{status || "Uploading"} <InlineDots color="#fff" /></> : "Upload and rate"}</Btn></div>
      </Card>
    </div>
  );
}

function CandidatePortal({ onBack, data }) {
  const c = data || { name: "", endorsements: [], matches: [] };
  return (
    <div className="min-h-screen" style={{ background: C.canvas }}>
      <div className="max-w-2xl mx-auto p-4 md:p-8 flex flex-col gap-4">
        {onBack && <button onClick={onBack} className="flex items-center gap-1.5 text-sm w-fit" style={{ color: C.ink2 }}><ChevronLeft size={15} /> Back to dashboard</button>}
        <div className="text-3xl md:text-4xl" style={{ ...SERIF }}>Hi {(c.name || "there").split(" ")[0]}</div>
        <div className="text-sm" style={{ color: C.ink2 }}>Here is where your applications stand.</div>
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

const FETCH_PATH = "/rest/v1/candidates?select=*,candidate_endorsements(*),candidate_comments(*),candidate_timeline(*)&order=created_at.desc";
async function loadAll(token) {
  const [profiles, candidates, jobs, applications, placements, campaigns, ads, settingsRows] = await Promise.all([
    sbFetch("/rest/v1/profiles?select=*", { token }),
    sbFetch(FETCH_PATH, { token }),
    sbFetch("/rest/v1/jobs?select=*,job_recruiters(*)&order=created_at.desc", { token }),
    sbFetch("/rest/v1/applications?select=*&order=created_at.desc", { token }),
    sbFetch("/rest/v1/placements?select=*&order=created_at.desc", { token }),
    sbFetch("/rest/v1/campaigns?select=*&order=created_at.desc", { token }),
    sbFetch("/rest/v1/ad_campaigns?select=*&order=created_at.desc", { token }),
    sbFetch("/rest/v1/agency_settings?select=*", { token }),
  ]);
  return mapAll({ profiles, candidates, jobs, applications, placements, campaigns, ads, settings: settingsRows[0] });
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [toastText, setToastText] = useState("");
  const [promote, setPromote] = useState({ open: false, job: "" });
  const [portal, setPortal] = useState(false);
  const [portalToken] = useState(() => new URLSearchParams(window.location.search).get("c"));
  const [portalData, setPortalData] = useState(null);

  const toast = (t) => { setToastText(t); setTimeout(() => setToastText(""), 2600); };
  const signOut = () => { store.set(null); setSession(null); setMe(null); setData(null); setStatus("signedout"); };

  React.useEffect(() => {
    if (portalToken) { sbFetch("/rest/v1/rpc/candidate_portal", { method: "POST", body: { p_token: portalToken } }).then(setPortalData).catch(() => setPortalData({ error: true })); }
  }, [portalToken]);

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
    return <CandidatePortal data={portalData} onBack={() => { window.history.replaceState({}, "", window.location.pathname); window.location.reload(); }} />;
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
  const myMe = { name: me.name, label: me.role, init: initialsOf(me.name), first: me.name.split(" ")[0], id: me.id };
  const reload = () => { setRefreshing(true); return loadAll(session.token).then(setData).catch((e) => toast(e.message)).finally(() => setRefreshing(false)); };
  const call = async (path, opts) => { try { await sbFetch(path, { ...opts, token: session.token }); reload(); } catch (e) { toast(e.message); throw e; } };

  // Local candidate field -> candidates table column, for the fields a person can actually edit.
  const CAND_FIELD_MAP = { status: "status", name: "name", role: "role_title", location: "location", emailAddr: "email", phone: "phone", experience: "experience", notice: "notice", pay: "pay", skills: "skills", strengths: "strengths", gaps: "gaps", ai: "ai_score", recruiterId: "recruiter_id" };
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
        reload();
      } catch (e) { toast(e.message); reload(); }
    })();
  };

  const S = {
    role, me: myMe, query, toast, go: setPage,
    cands: data.cands, updateCand,
    setCands: (fn) => { const list = typeof fn === "function" ? fn(data.cands) : fn; const added = list.filter((c) => !data.cands.some((x) => x.id === c.id));
      setData((d) => ({ ...d, cands: list })); added.forEach((c) => call("/rest/v1/candidates", { method: "POST", body: { id: c.id, name: c.name, role_title: c.role, location: c.location, recruiter_id: c.recruiterId, status: c.status, ai_score: c.ai || null, email: c.emailAddr || null } })); },
    jobs: data.jobs,
    setJobs: (fn) => { const list = typeof fn === "function" ? fn(data.jobs) : fn; const j = list[0];
      setData((d) => ({ ...d, jobs: list })); call("/rest/v1/jobs", { method: "POST", body: { id: j.id, role_title: j.role, client: j.client, location: j.location || null, min_pay: j.minPay || null, max_pay: j.maxPay || null, description: j.description || null, status: j.status, created_by: session.uid } }); },
    inbox: data.inbox,
    setInbox: (fn) => { const list = typeof fn === "function" ? fn(data.inbox) : fn;
      setData((d) => ({ ...d, inbox: list })); const x = list.find((i) => i.assignedId); if (x) call("/rest/v1/applications?id=eq." + x.id, { method: "PATCH", body: { assigned_to: x.assignedId } }); },
    placements: data.placements,
    setPlacements: (fn) => { const list = typeof fn === "function" ? fn(data.placements) : fn;
      const changed = list.find((p, i) => !data.placements[i] || data.placements[i].status !== p.status);
      setData((d) => ({ ...d, placements: list }));
      if (changed && data.placements.some((p) => p.id === changed.id)) call("/rest/v1/placements?id=eq." + changed.id, { method: "PATCH", body: { status: changed.status } });
      else if (changed) call("/rest/v1/placements", { method: "POST", body: { id: changed.id, candidate_name: changed.name, role_desc: changed.role, recruiter_id: changed.recruiterId, fee: changed.feeNum, status: changed.status } });
    },
    campaigns: data.campaigns,
    setCampaigns: (fn) => { const list = typeof fn === "function" ? fn(data.campaigns) : fn;
      const changed = list.find((c, i) => !data.campaigns[i] || data.campaigns[i].status !== c.status);
      setData((d) => ({ ...d, campaigns: list }));
      const existing = changed && data.campaigns.find((c) => c.id === changed.id);
      if (existing) call("/rest/v1/campaigns?id=eq." + changed.id, { method: "PATCH", body: { status: changed.status } });
      else if (changed) call("/rest/v1/campaigns", { method: "POST", body: { id: changed.id, name: changed.name, created_by: session.uid } });
    },
    ads: data.ads,
    setAds: (fn) => { const list = typeof fn === "function" ? fn(data.ads) : fn;
      const existingIds = new Set(data.ads.map((a) => a.id)); const added = list.filter((a) => !existingIds.has(a.id));
      const changed = list.find((a) => { const o = data.ads.find((x) => x.id === a.id); return o && o.status !== a.status; });
      setData((d) => ({ ...d, ads: list }));
      added.forEach((a) => call("/rest/v1/ad_campaigns", { method: "POST", body: { id: a.id, job_title: a.job, client: a.client, channels: a.channels, payer_type: a.payerType, budget: num(a.budget), status: a.status, created_by: session.uid } }));
      if (changed) call("/rest/v1/ad_campaigns?id=eq." + changed.id, { method: "PATCH", body: { status: changed.status } });
    },
    users: data.users,
    createAccount: async ({ email, password, full_name, role }) => {
      const r = await fetch(SB_URL + "/functions/v1/create-user", { method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, full_name, role }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "Could not create account"); reload();
    },
    disableUser: (id) => call("/rest/v1/profiles?id=eq." + id, { method: "PATCH", body: { status: "Disabled" } }),
    settings: data.settings,
    saveSettings: (v) => call("/rest/v1/agency_settings?id=eq.1", { method: "PATCH", body: { agency_name: v.name, guarantee_days: v.guaranteeDays, ai_screening: v.ai } }),
    team: buildTeam(data.users, data.cands, data.placements),
    openCandidate: (id) => setCandId(id),
    insertCandidateAwait: (c) => call("/rest/v1/candidates", { method: "POST", body: { id: c.id, name: c.name, role_title: c.role, location: c.location, recruiter_id: c.recruiterId, status: c.status, ai_score: c.ai || null, email: c.emailAddr || null } }),
    setJobStatus: (id, status) => call("/rest/v1/jobs?id=eq." + id, { method: "PATCH", body: { status } }).then(() => setData((d) => ({ ...d, jobs: d.jobs.map((j) => (j.id === id ? { ...j, status } : j)) }))),
    aiScreen: async (action, payload) => {
      const r = await fetch(SB_URL + "/functions/v1/ai-screen", { method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "AI request failed"); reload(); return j;
    },
  };
  const onPromote = (job) => setPromote({ open: true, job });
  const pendingQ = data.cands.filter((c) => c.screening.state === "pending").length;

  if (portal) return <CandidatePortal onBack={() => setPortal(false)} data={null} />;

  const scope = role === "recruiter" ? "recruiter" : "all";
  const candData = role === "recruiter" ? data.cands.filter((c) => c.recruiterId === session.uid) : data.cands;
  const candidate = data.cands.find((c) => c.id === candId);

  let content;
  if (candidate) content = <CandidateDetail key={candidate.id} candidate={candidate} onBack={() => setCandId(null)} toast={toast} S={S} />;
  else if (page === "overview") content = role === "recruiter" ? <OverviewRecruiter S={S} /> : <OverviewRecOps S={S} />;
  else if (page === "candidates") content = <CandidatesList scope={scope} data={candData} openCandidate={(c) => setCandId(c.id)} setPage={setPage} S={S} toast={toast} />;
  else if (page === "uploadCandidates") content = <UploadCandidates setPage={setPage} toast={toast} S={S} />;
  else if (page === "inbox") content = <InboxPage toast={toast} S={S} />;
  else if (page === "jobs") content = <JobsPage setPage={setPage} onPromote={onPromote} S={S} onOpenJob={(id) => { setJobId(id); setPageRaw("jobDetail"); }} />;
  else if (page === "postJob") content = <PostJobForm setPage={setPage} toast={toast} onPromote={onPromote} S={S} onOpenJob={(id) => { setJobId(id); setPageRaw("jobDetail"); }} />;
  else if (page === "jobDetail") content = <JobDetail job={data.jobs.find((j) => j.id === jobId)} S={S} toast={toast} onBack={() => setPage("jobs")} onPromote={onPromote} />;
  else if (page === "hiringTracker") content = <HiringTracker role={role} S={S} />;
  else if (page === "campaigns") content = <CampaignsPage toast={toast} S={S} />;
  else if (page === "billing") content = <BillingPage role={role} toast={toast} S={S} />;
  else if (page === "ads") content = <AdsPage role={role} toast={toast} onPromote={onPromote} S={S} />;
  else if (page === "users") content = role === "admin" ? <UsersPage toast={toast} S={S} /> : <OverviewRecOps S={S} />;
  else if (page === "settings") content = role === "admin" ? <SettingsPage toast={toast} S={S} /> : <OverviewRecOps S={S} />;
  else content = <OverviewRecOps S={S} />;

  return (
    <div className="flex min-h-screen" style={{ background: C.canvas, color: C.ink, fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>
      <TopProgressBar show={refreshing} />
      <Sidebar role={role} page={page} setPage={setPage} me={myMe} pendingQ={pendingQ} onSignOut={signOut} />
      <div className="flex-1 min-w-0">
        <TopBar query={query} setQuery={setQuery} />
        <div className="px-4 md:px-8" style={{ paddingBottom: 96 }}>{content}</div>
      </div>
      <MobileBottomNav role={role} page={page} setPage={setPage} onMore={() => setMoreOpen(true)} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} role={role} page={page} setPage={setPage} me={myMe} onSignOut={signOut} />
      <PromoteModal open={promote.open} onClose={() => setPromote({ ...promote, open: false })} jobTitle={promote.job} toast={toast} S={S} />
      <Toast text={toastText} />
    </div>
  );
}
