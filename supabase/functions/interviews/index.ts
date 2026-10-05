import { createClient } from "npm:@supabase/supabase-js@2";
import { GCal, authUrl, emailFromIdToken, exchangeCode, googleConfigured, revoke } from "./google.ts";
import { Info, NOSHOW_TEXT, TZ_ABBR, PORTAL_BASE, cancelEmail, ics, inviteEmail, noShowEmail, reminderEmail } from "./mail.ts";
import { loadBrand, sendBrevo } from "./brand.ts";

// Interview calendar.
//   Staff and recruiters (their login): create, update (reschedule), cancel, outcome, busy,
//   google_status / google_connect / google_disconnect / google_settings.
//   Google redirect (GET /interviews/oauth): finishes connecting a Google account.
//   Scheduler (x-harbor-ops): tick = reminder emails 24h and 1h before, and changes made in
//   Google (moved or deleted events) brought back into Harbor.
// Deployed with verify_jwt off because Google's redirect carries no Harbor login; every POST
// checks the caller itself.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-harbor-ops",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const errMsg = (e: unknown) => String((e as Error)?.message || e);
const STAGE_DONE = ["Offer", "Placed"];
const ROUND_DEFAULT = "1st round";
const FIELDS = ["round", "starts_at", "duration_min", "location_type", "location", "notes", "recruiter_id", "scheduler_tz", "candidate_tz", "client_tz", "send_reminders"];

function clean(body: any) {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (k in (body || {})) out[k] = body[k];
  if ("starts_at" in out) { const d = new Date(String(out.starts_at)); if (isNaN(d.getTime())) throw new Error("Pick a valid date and time"); out.starts_at = d.toISOString(); }
  if ("duration_min" in out) out.duration_min = Math.min(Math.max(Math.round(Number(out.duration_min) || 60), 5), 600);
  if ("location_type" in out && !["meet", "link", "phone", "in_person"].includes(String(out.location_type))) out.location_type = "meet";
  if ("round" in out) out.round = String(out.round || ROUND_DEFAULT).slice(0, 60);
  for (const k of ["location", "notes", "scheduler_tz", "candidate_tz", "client_tz"]) if (k in out) out[k] = out[k] ? String(out[k]).slice(0, k === "notes" ? 2000 : 300) : null;
  return out;
}

async function info(admin: any, iv: any): Promise<{ i: Info; cand: any }> {
  const [{ data: cand }, { data: job }, { data: rec }] = await Promise.all([
    admin.from("candidates").select("id,name,email,portal_token,recruiter_id,status").eq("id", iv.candidate_id).single(),
    iv.job_id ? admin.from("jobs").select("role_title,client").eq("id", iv.job_id).maybeSingle() : Promise.resolve({ data: null }),
    iv.recruiter_id ? admin.from("profiles").select("full_name").eq("id", iv.recruiter_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return {
    cand,
    i: {
      candidateName: cand?.name || "", candidateEmail: cand?.email || "", portalToken: cand?.portal_token || "",
      role: job?.role_title || "the role", company: job?.client || "", round: iv.round || ROUND_DEFAULT,
      startsAt: iv.starts_at, durationMin: iv.duration_min, tz: iv.candidate_tz, locationType: iv.location_type,
      location: iv.location, joinUrl: iv.location_type === "meet" ? iv.meet_url : iv.location_type === "link" ? iv.location : null,
      recruiter: String(rec?.full_name || "").split(" ")[0],
    },
  };
}
// "Thu 1 Oct, 17:00 WAT" in the booker's zone, for timeline entries.
function fmtTz(iso: string, tz?: string | null) {
  try {
    const d = new Date(iso), zone = tz || "UTC";
    const a = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    const z = TZ_ABBR[zone] || new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(d).find((x) => x.type === "timeZoneName")?.value || zone;
    return a + " " + z;
  } catch { return iso; }
}
const seqOf = (_iv: any) => Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 60000);

async function mailCandidate(admin: any, iv: any, kind: "invite" | "changed" | "cancel" | "noshow" | "day" | "hour") {
  const { i } = await info(admin, iv);
  if (!i.candidateEmail) return false;
  const b = await loadBrand(admin);
  const m = kind === "invite" ? inviteEmail(b, i) : kind === "changed" ? inviteEmail(b, i, true) : kind === "cancel" ? cancelEmail(b, i)
    : kind === "noshow" ? noShowEmail(b, i) : reminderEmail(b, i, kind);
  const attach = ["invite", "changed", "cancel"].includes(kind) ? { name: "interview.ics", content: ics({ ...i, id: iv.id, seq: seqOf(iv), cancelled: kind === "cancel" }) } : undefined;
  return sendBrevo(b, { email: i.candidateEmail, name: i.candidateName }, m.subject, m.html, attach);
}

async function timeline(admin: any, candidateId: string, title: string) {
  await admin.from("candidate_timeline").insert({ candidate_id: candidateId, title }).then(() => {}, () => {});
}

// ---------- Google ----------
async function connFor(admin: any, profileId: string | null) {
  if (!profileId || !googleConfigured()) return null;
  const { data } = await admin.from("google_calendar_connections").select("*").eq("profile_id", profileId).maybeSingle();
  return data || null;
}
async function saveConn(admin: any, g: GCal, extra: Record<string, unknown> = {}) {
  await admin.from("google_calendar_connections").update({ calendar_id: g.conn.calendar_id, sync_token: g.conn.sync_token ?? null, ...extra }).eq("profile_id", g.conn.profile_id);
}

// Puts the interview in its recruiter's Google Calendar (or the booker's), with a Meet link
// when it's a video call. Never throws: problems are stored on the interview.
async function pushToGoogle(admin: any, iv: any): Promise<any> {
  try {
    const conn = (await connFor(admin, iv.recruiter_id)) || (await connFor(admin, iv.created_by));
    if (!conn) return iv;
    // Moved to someone else's calendar: take it out of the old one first.
    if (iv.google_event_id && iv.google_owner && iv.google_owner !== conn.profile_id) {
      const old = await connFor(admin, iv.google_owner);
      if (old) { const og = new GCal(old); await og.deleteEvent(old.calendar_id, iv.google_event_id).catch(() => {}); }
      iv.google_event_id = null;
    }
    const g = new GCal(conn);
    const calId = await g.ensureCalendar(iv.scheduler_tz || "UTC");
    const { i, cand } = await info(admin, iv);
    const start = new Date(iv.starts_at), end = new Date(start.getTime() + iv.duration_min * 60000);
    const wantMeet = iv.location_type === "meet" && !iv.meet_url;
    const ev: any = {
      summary: `${iv.round}: ${i.candidateName} – ${i.role}${i.company ? " (" + i.company + ")" : ""}`,
      description: [iv.notes ? "Notes: " + iv.notes : "", `Candidate page: ${PORTAL_BASE()}/?c=${i.portalToken}`, `Harbor: ${PORTAL_BASE()}/?page=interviews`].filter(Boolean).join("\n\n"),
      start: { dateTime: start.toISOString(), timeZone: iv.scheduler_tz || "UTC" },
      end: { dateTime: end.toISOString(), timeZone: iv.scheduler_tz || "UTC" },
      location: iv.location_type === "meet" ? undefined : iv.location || undefined,
      extendedProperties: { private: { harborInterviewId: iv.id } },
      reminders: { useDefault: true },
    };
    if (conn.settings?.inviteCandidate && cand?.email) ev.attendees = [{ email: cand.email, displayName: cand.name }];
    if (wantMeet) ev.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    let out: any;
    if (iv.google_event_id) {
      try { out = await g.patchEvent(calId, iv.google_event_id, ev, wantMeet); }
      catch (e) { if ([404, 410].includes((e as any).status)) out = await g.createEvent(calId, ev, wantMeet); else throw e; }
    } else out = await g.createEvent(calId, ev, wantMeet);
    const patch: any = { google_event_id: out.id, google_owner: conn.profile_id, google_synced_at: new Date().toISOString(), google_error: null };
    if (wantMeet && out.hangoutLink) patch.meet_url = out.hangoutLink;
    await saveConn(admin, g);
    const { data } = await admin.from("interviews").update(patch).eq("id", iv.id).select().single();
    return data || { ...iv, ...patch };
  } catch (e) {
    await admin.from("interviews").update({ google_error: errMsg(e).slice(0, 300) }).eq("id", iv.id);
    return { ...iv, google_error: errMsg(e) };
  }
}

async function removeFromGoogle(admin: any, iv: any) {
  if (!iv.google_event_id || !iv.google_owner) return;
  try {
    const conn = await connFor(admin, iv.google_owner);
    if (conn) await new GCal(conn).deleteEvent(conn.calendar_id, iv.google_event_id);
  } catch (e) { console.error("google delete", errMsg(e)); }
  await admin.from("interviews").update({ google_event_id: null }).eq("id", iv.id);
}

// Events moved or deleted in Google come back into Harbor.
async function pullFromGoogle(admin: any) {
  if (!googleConfigured()) return { skipped: "Google not configured" };
  const { data: conns } = await admin.from("google_calendar_connections").select("*").neq("calendar_id", "primary");
  let moved = 0, cancelled = 0; const errors: string[] = [];
  for (const conn of conns || []) {
    const g = new GCal(conn);
    try {
      const { items, nextSyncToken } = await g.changes(conn.calendar_id);
      for (const ev of items) {
        const id = ev?.extendedProperties?.private?.harborInterviewId;
        if (!id) continue;
        const { data: iv } = await admin.from("interviews").select("*").eq("id", id).maybeSingle();
        if (!iv || iv.status !== "scheduled" || iv.google_event_id !== ev.id) continue;
        if (ev.status === "cancelled") {
          await admin.from("interviews").update({ status: "cancelled", google_event_id: null }).eq("id", iv.id);
          await timeline(admin, iv.candidate_id, `${iv.round} cancelled in Google Calendar`);
          if (iv.send_reminders) await mailCandidate(admin, iv, "cancel");
          cancelled++; continue;
        }
        const s = ev.start?.dateTime ? new Date(ev.start.dateTime) : null, e = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
        if (!s || !e) continue;
        const dur = Math.max(5, Math.round((e.getTime() - s.getTime()) / 60000));
        if (s.getTime() === new Date(iv.starts_at).getTime() && dur === iv.duration_min) continue;
        const patch = { starts_at: s.toISOString(), duration_min: dur, reminder_day_sent_at: null, reminder_hour_sent_at: null, candidate_confirmed_at: null, google_synced_at: new Date().toISOString(), meet_url: ev.hangoutLink || iv.meet_url };
        const { data: upd } = await admin.from("interviews").update(patch).eq("id", iv.id).select().single();
        await timeline(admin, iv.candidate_id, `${iv.round} moved in Google Calendar`);
        if (iv.send_reminders && upd) await mailCandidate(admin, upd, "changed");
        moved++;
      }
      if (nextSyncToken) g.conn.sync_token = nextSyncToken;
      await saveConn(admin, g, { last_sync_at: new Date().toISOString(), last_error: null });
    } catch (e) {
      errors.push(errMsg(e).slice(0, 160));
      await admin.from("google_calendar_connections").update({ last_error: errMsg(e).slice(0, 300) }).eq("profile_id", conn.profile_id);
    }
  }
  return { moved, cancelled, errors };
}

async function reminders(admin: any) {
  const now = Date.now();
  const { data: list } = await admin.from("interviews").select("*").eq("status", "scheduled").eq("send_reminders", true)
    .gt("starts_at", new Date(now).toISOString()).lt("starts_at", new Date(now + 24 * 3600e3).toISOString()).limit(200);
  let day = 0, hour = 0;
  for (const iv of list || []) {
    const start = new Date(iv.starts_at).getTime(), made = new Date(iv.created_at).getTime(), left = start - now;
    if (!iv.reminder_hour_sent_at && left <= 75 * 60000 && made <= start - 2 * 3600e3) {
      if (await mailCandidate(admin, iv, "hour")) hour++;
      await admin.from("interviews").update({ reminder_hour_sent_at: new Date().toISOString(), ...(iv.reminder_day_sent_at ? {} : { reminder_day_sent_at: new Date().toISOString() }) }).eq("id", iv.id);
    } else if (!iv.reminder_day_sent_at && left > 2 * 3600e3 && made <= start - 20 * 3600e3) {
      if (await mailCandidate(admin, iv, "day")) day++;
      await admin.from("interviews").update({ reminder_day_sent_at: new Date().toISOString() }).eq("id", iv.id);
    }
  }
  return { day, hour };
}

function page(title: string, text: string, back: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as any)[c]);
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><meta http-equiv="refresh" content="2;url=${esc(back)}"></head>
<body style="margin:0;background:#F3EFE7;font-family:system-ui,sans-serif;color:#14201B;display:flex;min-height:100vh;align-items:center;justify-content:center"><div style="background:#fff;border:1px solid #E6E1D6;border-radius:16px;padding:28px;max-width:380px"><div style="font-family:Georgia,serif;font-size:22px;margin-bottom:8px">${esc(title)}</div><div style="font-size:14px;color:#56605A">${esc(text)}</div><a href="${esc(back)}" style="display:inline-block;margin-top:16px;color:#1F6F54">Back to Harbor</a></div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);

  // Google's redirect after someone allows access.
  if (req.method === "GET" && url.pathname.endsWith("/oauth")) {
    let back = PORTAL_BASE() + "/?page=myProfile&tab=calendar";
    try {
      const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
      const { data: st } = await admin.from("google_oauth_states").select("*").eq("state", state).maybeSingle();
      if (st?.return_to) back = st.return_to;
      if (url.searchParams.get("error")) return page("Google Calendar not connected", "You didn't allow access, so nothing changed.", back);
      if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60000) return page("Link expired", "Start again from My profile in Harbor.", back);
      await admin.from("google_oauth_states").delete().eq("state", state);
      const tok = await exchangeCode(code);
      const { data: existing } = await admin.from("google_calendar_connections").select("refresh_token,calendar_id,settings").eq("profile_id", st.profile_id).maybeSingle();
      const refresh = tok.refresh_token || existing?.refresh_token;
      if (!refresh) return page("Please try again", "Google didn't return long-term access. Remove Harbor under your Google account's third-party access, then connect again.", back);
      await admin.from("google_calendar_connections").upsert({
        profile_id: st.profile_id, google_email: emailFromIdToken(tok.id_token), refresh_token: refresh,
        calendar_id: existing?.calendar_id || "primary", settings: existing?.settings || undefined, connected_at: new Date().toISOString(), last_error: null,
      }, { onConflict: "profile_id" });
      // Create the "Harbor interviews" calendar now so the first booking is quick.
      const { data: conn } = await admin.from("google_calendar_connections").select("*").eq("profile_id", st.profile_id).single();
      try { const g = new GCal(conn); await g.ensureCalendar("UTC"); await saveConn(admin, g); } catch (e) { console.error("calendar create", errMsg(e)); }
      return page("Google Calendar connected", "Interviews you schedule in Harbor will now appear in your Google Calendar.", back);
    } catch (e) {
      return page("Couldn't connect Google Calendar", errMsg(e).slice(0, 200), back);
    }
  }
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // Scheduled runs.
    const opsKey = req.headers.get("x-harbor-ops") || "";
    if (opsKey) {
      const { data: tok } = await admin.from("ops_tokens").select("token").eq("token", opsKey).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (!tok || opsKey.length < 32) return json({ error: "Invalid ops token" }, 403);
      if (action !== "tick") return json({ error: "Unknown scheduled action" }, 400);
      const out: Record<string, unknown> = {};
      try { out.reminders = await reminders(admin); } catch (e) { out.remindersError = errMsg(e); }
      try { out.google = await pullFromGoogle(admin); } catch (e) { out.googleError = errMsg(e); }
      await admin.from("google_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600e3).toISOString());
      return json({ ok: true, ...out });
    }

    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("id,role,status,full_name").eq("id", caller.user.id).single();
    if (!me || me.status !== "Active") return json({ error: "Your account is not active" }, 403);
    const isStaff = me.role === "admin" || me.role === "recops";

    // Same reach as the interviews table's access rules.
    const allowed = async (candidateId: string, jobId: string | null, recruiterId: string | null) => {
      if (isStaff || recruiterId === me.id) return true;
      const { data: c } = await admin.from("candidates").select("recruiter_id").eq("id", candidateId).maybeSingle();
      if (c?.recruiter_id === me.id) return true;
      if (jobId) { const { data: jr } = await admin.from("job_recruiters").select("recruiter_id").eq("job_id", jobId).eq("recruiter_id", me.id).maybeSingle(); if (jr) return true; }
      return false;
    };
    const load = async (id: string) => {
      const { data: iv } = await admin.from("interviews").select("*").eq("id", id).maybeSingle();
      if (!iv) throw Object.assign(new Error("Interview not found"), { code: 404 });
      if (!(await allowed(iv.candidate_id, iv.job_id, iv.recruiter_id))) throw Object.assign(new Error("You don't have access to this interview"), { code: 403 });
      return iv;
    };

    // ---- Google connection (your own) ----
    if (action === "google_status") {
      const { data: c } = await admin.from("google_calendar_connections").select("google_email,calendar_id,settings,connected_at,last_sync_at,last_error").eq("profile_id", me.id).maybeSingle();
      return json({ ok: true, configured: googleConfigured(), connected: !!c, email: c?.google_email || "", lastSync: c?.last_sync_at || null, lastError: c?.last_error || null, settings: c?.settings || null });
    }
    if (action === "google_connect") {
      if (!googleConfigured()) return json({ error: "Google sign-in isn't set up yet. An admin needs to add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see supabase/INTERVIEWS_SETUP.md)." }, 400);
      const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      // Back to wherever Harbor is open (its address can differ from PORTAL_BASE_URL).
      const returnTo = typeof body.returnTo === "string" && /^https?:\/\/[^\s]+$/.test(body.returnTo) ? body.returnTo.slice(0, 500) : null;
      await admin.from("google_oauth_states").insert({ state, profile_id: me.id, return_to: returnTo });
      return json({ ok: true, url: authUrl(state) });
    }
    if (action === "google_disconnect") {
      const { data: c } = await admin.from("google_calendar_connections").select("refresh_token").eq("profile_id", me.id).maybeSingle();
      if (c) { await revoke(c.refresh_token); await admin.from("google_calendar_connections").delete().eq("profile_id", me.id); }
      return json({ ok: true });
    }
    if (action === "google_settings") {
      const s = body.settings || {};
      const settings = { clashCheck: s.clashCheck !== false, inviteCandidate: !!s.inviteCandidate };
      await admin.from("google_calendar_connections").update({ settings }).eq("profile_id", me.id);
      return json({ ok: true, settings });
    }

    // Busy times in someone's Google Calendar, for clash warnings.
    if (action === "busy") {
      const who = String(body.recruiterId || me.id);
      const conn = await connFor(admin, who);
      if (!conn || conn.settings?.clashCheck === false) return json({ ok: true, busy: [], connected: !!conn });
      try { return json({ ok: true, connected: true, busy: await new GCal(conn).busy(String(body.timeMin), String(body.timeMax)) }); }
      catch (e) { return json({ ok: true, connected: true, busy: [], error: errMsg(e) }); }
    }

    // ---- Interviews ----
    if (action === "create") {
      const f = clean(body);
      const candidateId = String(body.candidate_id || "");
      if (!candidateId || !f.starts_at) return json({ error: "Pick a candidate, date and time" }, 400);
      let jobId = body.job_id ? String(body.job_id) : null, linkId = body.link_id ? String(body.link_id) : null;
      if (linkId) { const { data: l } = await admin.from("candidate_jobs").select("id,job_id,candidate_id,stage").eq("id", linkId).maybeSingle(); if (!l || l.candidate_id !== candidateId) linkId = null; else jobId = l.job_id; }
      else if (jobId) { const { data: l } = await admin.from("candidate_jobs").select("id").eq("candidate_id", candidateId).eq("job_id", jobId).maybeSingle(); linkId = l?.id || null; }
      const recruiterId = (f.recruiter_id as string) || me.id;
      if (!(await allowed(candidateId, jobId, recruiterId))) return json({ error: "You don't have access to this candidate" }, 403);
      const { data: iv, error } = await admin.from("interviews").insert({ ...f, candidate_id: candidateId, job_id: jobId, link_id: linkId, recruiter_id: recruiterId, created_by: me.id }).select().single();
      if (error) return json({ error: error.message }, 400);
      if (body.moveStage && linkId) {
        const { data: l } = await admin.from("candidate_jobs").select("stage").eq("id", linkId).single();
        if (l && l.stage !== "Interview" && !STAGE_DONE.includes(l.stage)) await admin.from("candidate_jobs").update({ stage: "Interview" }).eq("id", linkId);
        await admin.from("candidates").update({ status: "Interview" }).eq("id", candidateId).in("status", ["In review", "With client", "Active file", "New"]);
      }
      await timeline(admin, candidateId, `${iv.round} booked for ${fmtTz(iv.starts_at, iv.scheduler_tz)}`);
      const synced = await pushToGoogle(admin, iv);
      const sent = body.notifyCandidate !== false ? await mailCandidate(admin, synced, "invite") : false;
      return json({ ok: true, interview: synced, emailed: sent });
    }

    if (action === "update") {
      const iv = await load(String(body.id));
      if (iv.status !== "scheduled") return json({ error: "Only upcoming interviews can be changed" }, 400);
      const f = clean(body.patch || {});
      const timeChanged = ("starts_at" in f && new Date(String(f.starts_at)).getTime() !== new Date(iv.starts_at).getTime()) || ("duration_min" in f && f.duration_min !== iv.duration_min);
      const whereChanged = ("location_type" in f && f.location_type !== iv.location_type) || ("location" in f && f.location !== iv.location);
      if (whereChanged && f.location_type !== "meet") (f as any).meet_url = null;
      if (timeChanged) Object.assign(f, { reminder_day_sent_at: null, reminder_hour_sent_at: null, candidate_confirmed_at: null });
      const { data: upd, error } = await admin.from("interviews").update(f).eq("id", iv.id).select().single();
      if (error) return json({ error: error.message }, 400);
      if (timeChanged) await timeline(admin, iv.candidate_id, `${upd.round} moved to ${fmtTz(upd.starts_at, upd.scheduler_tz)}`);
      const synced = await pushToGoogle(admin, upd);
      const sent = (timeChanged || whereChanged) && body.notifyCandidate !== false ? await mailCandidate(admin, synced, "changed") : false;
      return json({ ok: true, interview: synced, emailed: sent });
    }

    if (action === "cancel") {
      const iv = await load(String(body.id));
      if (iv.status !== "scheduled") return json({ error: "This interview isn't upcoming" }, 400);
      await admin.from("interviews").update({ status: "cancelled" }).eq("id", iv.id);
      await removeFromGoogle(admin, iv);
      await timeline(admin, iv.candidate_id, `${iv.round} cancelled`);
      const sent = body.notifyCandidate !== false ? await mailCandidate(admin, iv, "cancel") : false;
      return json({ ok: true, emailed: sent });
    }

    if (action === "remove") {
      const iv = await load(String(body.id));
      if (!(isStaff || iv.recruiter_id === me.id)) return json({ error: "Only the recruiter on it or Rec Ops can delete an interview" }, 403);
      await removeFromGoogle(admin, iv);
      await admin.from("interviews").delete().eq("id", iv.id);
      return json({ ok: true });
    }

    // After the interview: what happened, the client's decision, feedback.
    if (action === "outcome") {
      const iv = await load(String(body.id));
      const status = ["done", "no_show", "client_cancelled", "rescheduled"].includes(body.status) ? body.status : iv.status;
      const decision = status === "done" && ["next_round", "offer", "client_reject", "waiting"].includes(body.decision) ? body.decision : null;
      const feedback = typeof body.feedback === "string" ? body.feedback.slice(0, 4000) : iv.feedback;
      const { data: upd } = await admin.from("interviews").update({ status, decision, feedback }).eq("id", iv.id).select().single();
      if (iv.status === "scheduled" && status !== "done") await removeFromGoogle(admin, iv);
      const label: Record<string, string> = { done: "took place", no_show: "candidate didn't attend", client_cancelled: "client cancelled", rescheduled: "to be rescheduled" };
      const dec: Record<string, string> = { next_round: "through to the next round", offer: "offer", client_reject: "rejected by the client", waiting: "waiting for client feedback" };
      if (status !== iv.status || decision !== iv.decision) await timeline(admin, iv.candidate_id, `${iv.round}: ${label[status] || status}${decision ? ", " + dec[decision] : ""}`);

      if (decision === "offer" && iv.link_id) await admin.from("candidate_jobs").update({ stage: "Offer" }).eq("id", iv.link_id);
      if (decision === "client_reject" && iv.decision !== "client_reject") {
        if (iv.link_id) await admin.from("candidate_jobs").update({ stage: "Rejected" }).eq("id", iv.link_id);
        // Back to Active file (kept searchable) unless they're still live on another role.
        const { data: others } = await admin.from("candidate_jobs").select("id").eq("candidate_id", iv.candidate_id).neq("id", iv.link_id || "00000000-0000-0000-0000-000000000000")
          .in("stage", ["Submitted", "Interview", "Offer"]).neq("candidate_response", "declined").limit(1);
        if (!others?.length) await admin.from("candidates").update({ status: "Active file" }).eq("id", iv.candidate_id).in("status", ["Interview", "With client", "In review"]);
      }

      // No-show: one follow-up to the candidate, by email and on their candidate page.
      let followup = false;
      if (status === "no_show" && !iv.noshow_followup_sent_at) {
        const sent = await mailCandidate(admin, upd || iv, "noshow");
        if (iv.link_id) await admin.from("candidate_job_messages").insert({ link_id: iv.link_id, sender: "recruiter", author_id: me.id, body: NOSHOW_TEXT, recruiter_read_at: new Date().toISOString() });
        await admin.from("interviews").update({ noshow_followup_sent_at: new Date().toISOString() }).eq("id", iv.id);
        followup = sent || !!iv.link_id;
      }
      return json({ ok: true, followup });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: errMsg(e) }, (e as any)?.code === 403 ? 403 : (e as any)?.code === 404 ? 404 : 500);
  }
});
