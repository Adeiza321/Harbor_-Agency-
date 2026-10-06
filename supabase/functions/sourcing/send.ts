// Sending outreach email. Never through Brevo: Brevo forbids third-party contact lists, and
// Pronext's own candidate emails must not be put at risk. Two providers, whichever is set up:
//
//   Instantly (recommended)  INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_ID, optional INSTANTLY_CLIENT_CAMPAIGN_ID
//     Each email becomes a lead in an Instantly campaign whose step uses {{subject}} and {{body}}.
//     Instantly handles mailbox warm-up, rotation, sending windows and daily limits.
//   Gmail / Google Workspace  GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER
//     Sends through the Gmail API from one outreach mailbox.
//
// With neither set, approved emails wait in the queue ("Waiting for a sender").

export type Provider = "instantly" | "gmail" | "none";

export function provider(): Provider {
  if (Deno.env.get("INSTANTLY_API_KEY") && Deno.env.get("INSTANTLY_CAMPAIGN_ID")) return "instantly";
  if (Deno.env.get("GMAIL_REFRESH_TOKEN") && Deno.env.get("GMAIL_CLIENT_ID") && Deno.env.get("GMAIL_CLIENT_SECRET") && Deno.env.get("GMAIL_SENDER")) return "gmail";
  return "none";
}

export const normEmail = (e: string) => {
  const [u, d] = String(e || "").trim().toLowerCase().split("@");
  return d ? u.replace(/\+.*$/, "") + "@" + d : "";
};
// Suppressions store a hash, not the address, so "delete my data" leaves no readable email behind.
export async function emailHash(e: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normEmail(e)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
// Plain text -> simple HTML with clickable links and line breaks.
export const toHtml = (text: string) => esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>");

export type OutMail = { kind: "candidate" | "client"; to: string; toName: string; firstName: string; lastName: string; company: string; subject: string; body: string; unsubUrl: string };

async function sendInstantly(m: OutMail): Promise<string> {
  const campaign = m.kind === "client" ? (Deno.env.get("INSTANTLY_CLIENT_CAMPAIGN_ID") || Deno.env.get("INSTANTLY_CAMPAIGN_ID")) : Deno.env.get("INSTANTLY_CAMPAIGN_ID");
  const res = await fetch("https://api.instantly.ai/api/v2/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("INSTANTLY_API_KEY") },
    body: JSON.stringify({
      campaign, email: m.to, first_name: m.firstName, last_name: m.lastName, company_name: m.company,
      custom_variables: { subject: m.subject, body: toHtml(m.body) },
      skip_if_in_campaign: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Instantly " + res.status + ": " + String(data?.message || data?.error || "").slice(0, 200));
  return String(data?.id || "");
}

async function gmailToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GMAIL_CLIENT_ID")!, client_secret: Deno.env.get("GMAIL_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GMAIL_REFRESH_TOKEN")!, grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("Gmail sign-in failed: " + String(data?.error_description || data?.error || res.status));
  return data.access_token;
}

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encWord = (s: string) => "=?UTF-8?B?" + btoa(unescape(encodeURIComponent(s))) + "?=";

async function sendGmail(m: OutMail, fromName: string): Promise<string> {
  const token = await gmailToken();
  const sender = Deno.env.get("GMAIL_SENDER")!;
  const boundary = "hb" + crypto.randomUUID().replace(/-/g, "");
  const raw = [
    `From: ${encWord(fromName || sender)} <${sender}>`,
    `To: ${m.toName ? encWord(m.toName) + " " : ""}<${m.to}>`,
    `Subject: ${encWord(m.subject)}`,
    `List-Unsubscribe: <${m.unsubUrl}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", m.body,
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "", `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${toHtml(m.body)}</div>`,
    `--${boundary}--`,
  ].join("\r\n");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: b64url(raw) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Gmail " + res.status + ": " + String(data?.error?.message || "").slice(0, 200));
  return String(data?.id || "");
}

export async function sendMail(m: OutMail, fromName: string): Promise<{ provider: Provider; ref: string }> {
  const p = provider();
  if (p === "instantly") return { provider: p, ref: await sendInstantly(m) };
  if (p === "gmail") return { provider: p, ref: await sendGmail(m, fromName) };
  throw new Error("No outreach sender is connected yet");
}
