// Google Calendar for interviews. Each person connects their own Google account once.
// Harbor creates its own "Harbor interviews" calendar in that account and only touches that
// calendar, plus free/busy times for clash warnings. Scopes:
//   calendar.app.created  manage calendars Harbor created (and their events)
//   calendar.freebusy     see busy times only, never event details
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. Redirect URI to register in Google Cloud:
//   <SUPABASE_URL>/functions/v1/interviews/oauth

export const SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.freebusy",
];
export const googleConfigured = () => !!(Deno.env.get("GOOGLE_CLIENT_ID") && Deno.env.get("GOOGLE_CLIENT_SECRET"));
export const redirectUri = () => Deno.env.get("SUPABASE_URL") + "/functions/v1/interviews/oauth";
const CAL = "https://www.googleapis.com/calendar/v3";

export function authUrl(state: string) {
  const q = new URLSearchParams({
    client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, redirect_uri: redirectUri(), response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q;
}

export async function exchangeCode(code: string): Promise<{ refresh_token?: string; access_token: string; id_token?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Google sign-in failed: " + String(data?.error_description || data?.error || res.status));
  return data;
}

export function emailFromIdToken(idToken?: string): string {
  try { const p = JSON.parse(atob(String(idToken).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); return String(p.email || ""); } catch { return ""; }
}

export async function revoke(refreshToken: string) {
  await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(refreshToken), { method: "POST" }).catch(() => {});
}

// One Google session per connection, refreshed when needed.
export class GCal {
  private token = "";
  constructor(public conn: { profile_id: string; refresh_token: string; calendar_id: string; sync_token?: string | null }) {}

  private async access(): Promise<string> {
    if (this.token) return this.token;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, refresh_token: this.conn.refresh_token, grant_type: "refresh_token" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const e = new Error(data?.error === "invalid_grant" ? "Google access was removed. Reconnect Google Calendar on My profile." : "Google sign-in failed: " + String(data?.error_description || data?.error || res.status));
      (e as any).revoked = data?.error === "invalid_grant";
      throw e;
    }
    this.token = data.access_token;
    return this.token;
  }

  async call(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<any> {
    const url = CAL + path + (query ? "?" + new URLSearchParams(query) : "");
    const res = await fetch(url, { method, headers: { Authorization: "Bearer " + (await this.access()), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error("Google Calendar " + res.status + ": " + String(data?.error?.message || "").slice(0, 200)); (e as any).status = res.status; throw e; }
    return data;
  }

  // The "Harbor interviews" calendar, created on first use.
  async ensureCalendar(timeZone: string): Promise<string> {
    if (this.conn.calendar_id && this.conn.calendar_id !== "primary") {
      try { await this.call("GET", "/calendars/" + encodeURIComponent(this.conn.calendar_id)); return this.conn.calendar_id; } catch (e) { if ((e as any).status !== 404) throw e; }
    }
    const cal = await this.call("POST", "/calendars", { summary: "Harbor interviews", description: "Interviews scheduled in Harbor. Moving or cancelling an event here updates Harbor.", timeZone: timeZone || "UTC" });
    this.conn.calendar_id = cal.id;
    this.conn.sync_token = null;
    return cal.id;
  }

  async createEvent(calId: string, ev: any, withMeet: boolean) {
    return this.call("POST", "/calendars/" + encodeURIComponent(calId) + "/events", ev, { conferenceDataVersion: withMeet ? "1" : "0", sendUpdates: ev.attendees?.length ? "all" : "none" });
  }
  async patchEvent(calId: string, id: string, ev: any, withMeet: boolean) {
    return this.call("PATCH", "/calendars/" + encodeURIComponent(calId) + "/events/" + encodeURIComponent(id), ev, { conferenceDataVersion: withMeet ? "1" : "0", sendUpdates: ev.attendees?.length ? "all" : "none" });
  }
  async deleteEvent(calId: string, id: string) {
    try { await this.call("DELETE", "/calendars/" + encodeURIComponent(calId) + "/events/" + encodeURIComponent(id), undefined, { sendUpdates: "all" }); }
    catch (e) { if (![404, 410].includes((e as any).status)) throw e; }
  }

  // Changes since the last sync. A first call (no token) just collects a token.
  async changes(calId: string): Promise<{ items: any[]; nextSyncToken: string }> {
    const items: any[] = []; let pageToken = ""; let syncToken = this.conn.sync_token || "";
    for (let i = 0; i < 10; i++) {
      const q: Record<string, string> = { showDeleted: "true", maxResults: "250" };
      if (pageToken) q.pageToken = pageToken; else if (syncToken) q.syncToken = syncToken; else q.timeMin = new Date(Date.now() - 864e5).toISOString();
      let data: any;
      try { data = await this.call("GET", "/calendars/" + encodeURIComponent(calId) + "/events", undefined, q); }
      catch (e) { if ((e as any).status === 410) { syncToken = ""; pageToken = ""; this.conn.sync_token = null; continue; } throw e; }
      items.push(...(data.items || []));
      if (data.nextPageToken) { pageToken = data.nextPageToken; continue; }
      return { items, nextSyncToken: data.nextSyncToken || "" };
    }
    return { items, nextSyncToken: "" };
  }

  async busy(timeMin: string, timeMax: string): Promise<{ start: string; end: string }[]> {
    const data = await this.call("POST", "/freeBusy", { timeMin, timeMax, items: [{ id: "primary" }] });
    return (data?.calendars?.primary?.busy || []) as { start: string; end: string }[];
  }
}
