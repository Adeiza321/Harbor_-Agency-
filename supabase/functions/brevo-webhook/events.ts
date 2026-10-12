// Brevo email events in one shape, whether they came from the webhook or the event log API.
// The same file is copied into brevo-webhook so both store identical rows.

// Webhook and API name the same event differently; stored under one name.
const CANON: Record<string, string> = {
  request: "request", requests: "request", sent: "request",
  delivered: "delivered",
  opened: "opened", unique_opened: "unique_opened", uniqueopened: "unique_opened",
  proxy_open: "proxy_open", unique_proxy_open: "proxy_open", loadedbyproxy: "proxy_open",
  click: "click", clicks: "click",
  hard_bounce: "hard_bounce", hardbounces: "hard_bounce",
  soft_bounce: "soft_bounce", softbounces: "soft_bounce",
  blocked: "blocked", invalid: "invalid", invalid_email: "invalid",
  deferred: "deferred", spam: "spam", complaint: "spam", unsubscribed: "unsubscribed", error: "error",
};
export const canonEvent = (e: unknown) => CANON[String(e || "").trim().toLowerCase()] || String(e || "").trim().toLowerCase();

export type EventRow = {
  dedupe: string; message_id: string | null; email: string; event: string; subject: string | null;
  tag: string | null; link: string | null; reason: string | null; at: string; source: string;
};

function when(e: any): string | null {
  const ts = Number(e.ts_event || e.ts_epoch || e.ts);
  if (Number.isFinite(ts) && ts > 1e9) return new Date((ts > 1e12 ? ts : ts * 1000)).toISOString();
  const d = new Date(String(e.date || ""));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function toRow(e: any, source: "webhook" | "sync"): EventRow | null {
  const email = String(e.email || "").trim().toLowerCase();
  const event = canonEvent(e.event);
  const at = when(e);
  if (!email || !event || !at) return null;
  const message_id = String(e["message-id"] || e.messageId || e.message_id || "").trim() || null;
  const tag = Array.isArray(e.tags) ? e.tags.join(", ") : (e.tag ? String(e.tag) : null);
  const link = e.link ? String(e.link).slice(0, 1000) : null;
  const minute = at.slice(0, 16);
  const dedupe = [message_id || `${email}|${String(e.subject || "")}`, event, minute, link || ""].join("|").slice(0, 1500);
  return {
    dedupe, message_id, email, event, subject: e.subject ? String(e.subject).slice(0, 500) : null, tag, link,
    reason: e.reason ? String(e.reason).slice(0, 300) : null, at, source,
  };
}

// Inserts, skipping events already stored. Returns how many rows were sent.
export async function storeEvents(admin: any, rows: EventRow[]) {
  const seen = new Set<string>();
  const uniq = rows.filter((r) => !seen.has(r.dedupe) && seen.add(r.dedupe));
  for (let i = 0; i < uniq.length; i += 500) {
    const { error } = await admin.from("email_events").upsert(uniq.slice(i, i + 500), { onConflict: "dedupe", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  return uniq.length;
}
