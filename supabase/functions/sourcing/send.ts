// Sending outreach email. Never through Brevo: Brevo forbids third-party contact lists, and
// Pronext's own candidate emails must not be put at risk. Providers, first one set up wins:
//
//   Apollo sequences          APOLLO_API_KEY (master), APOLLO_SEQUENCE_ID — see apollo.ts
//   Instantly  INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_ID, optional INSTANTLY_CLIENT_CAMPAIGN_ID
//     Each email becomes a lead in an Instantly campaign whose step uses {{subject}} and {{body}}.
//     Instantly handles mailbox warm-up, rotation, sending windows and daily limits.
//   Gmail / Google Workspace  GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER
//     Sends through the Gmail API from one outreach mailbox.
//
// With neither set, approved emails wait in the queue ("Waiting for a sender").
//
// Client pitches through Brevo (Outreach settings > "Send client pitches through", for now while
// Apollo is down): BREVO_API_KEY + BREVO_SENDER_EMAIL, the same account as the candidate emails, so
// it's kept to a small daily cap (clientBrevoPerDay). Candidate outreach never goes through Brevo.
// Each send's Brevo message id is kept (provider_ref), so its delivered / opened / clicked /
// bounced events (brevo-webhook -> email_events) show on the lead and in Email tracking.

import { sendViaApollo } from "./apollo.ts";

export type Provider = "apollo" | "instantly" | "gmail" | "brevo" | "none";

// Set once per request from Outreach settings (sourcing/index.ts).
let clientMode: "auto" | "brevo" = "auto";
export function useClientSender(mode: unknown) { clientMode = mode === "brevo" ? "brevo" : "auto"; }
export const brevoReady = () => !!(Deno.env.get("BREVO_API_KEY") && Deno.env.get("BREVO_SENDER_EMAIL"));

// The sender for one kind of email. Client pitches go through Apollo only with their own
// sequence (APOLLO_CLIENT_SEQUENCE_ID): the candidate sequence's follow-ups talk about a role and
// "your background", which would be wrong for a hiring manager.
export function provider(kind: "candidate" | "client" = "candidate"): Provider {
  if (kind === "client" && clientMode === "brevo") return brevoReady() ? "brevo" : "none";
  const apolloSeq = kind === "client" ? Deno.env.get("APOLLO_CLIENT_SEQUENCE_ID") : Deno.env.get("APOLLO_SEQUENCE_ID");
  if (Deno.env.get("APOLLO_API_KEY") && apolloSeq) return "apollo";
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
const linkify = (h: string) => h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');

// "Apply now: <url>" / "Know someone who'd fit? Refer them: <url>" lines become buttons in HTML.
const ACTION_LINE = /^(Apply now|Know someone who'd fit\? Refer them): (https?:\/\/\S+)$/;
function actionHtml(kind: string, url: string) {
  const u = esc(url);
  if (kind === "Apply now") return `<a href="${u}" style="display:inline-block;margin:4px 8px 4px 0;padding:11px 22px;background:#1F6F54;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;">Apply now</a>`;
  if (kind.startsWith("Know someone")) return `<a href="${u}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 20px;background:#ffffff;color:#1F6F54;text-decoration:none;border-radius:10px;border:1px solid #1F6F54;font-weight:600;">Refer someone</a>`;
  return `<a href="${u}">${u}</a>`;
}
// Plain text -> simple HTML with clickable links and line breaks.
export const toHtml = (text: string) => {
  const out: string[] = [];
  let row: string[] = [];
  const flush = () => { if (row.length) { out.push(`<div style="margin:6px 0 10px;">${row.join("")}</div>`); row = []; } };
  for (const line of String(text || "").split("\n")) {
    const m = line.trim().match(ACTION_LINE);
    if (m) { row.push(actionHtml(m[1], m[2])); continue; }
    flush();
    out.push(linkify(esc(line)) + "<br>");
  }
  flush();
  return out.join("");
};

export type Attachment = { name: string; type: string; bytes: Uint8Array };
export type OutMail = { kind: "candidate" | "client"; to: string; toName: string; firstName: string; lastName: string; company: string; subject: string; body: string; html?: string; unsubUrl: string; attachment?: Attachment; replyTo?: string };

async function sendInstantly(m: OutMail): Promise<string> {
  const campaign = m.kind === "client" ? (Deno.env.get("INSTANTLY_CLIENT_CAMPAIGN_ID") || Deno.env.get("INSTANTLY_CAMPAIGN_ID")) : Deno.env.get("INSTANTLY_CAMPAIGN_ID");
  const res = await fetch("https://api.instantly.ai/api/v2/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("INSTANTLY_API_KEY") },
    body: JSON.stringify({
      campaign, email: m.to, first_name: m.firstName, last_name: m.lastName, company_name: m.company,
      custom_variables: { subject: m.subject, body: m.html || toHtml(m.body) },
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
function bytesB64(b: Uint8Array) {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}
const encWord = (s: string) => "=?UTF-8?B?" + btoa(unescape(encodeURIComponent(s))) + "?=";

async function sendGmail(m: OutMail, fromName: string): Promise<string> {
  const token = await gmailToken();
  const sender = Deno.env.get("GMAIL_SENDER")!;
  const boundary = "hb" + crypto.randomUUID().replace(/-/g, "");
  const alt = [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", m.body,
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "", m.html || `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${toHtml(m.body)}</div>`,
    `--${boundary}--`,
  ];
  // With an attachment: multipart/mixed around the text + HTML versions and the file.
  let content = alt;
  if (m.attachment) {
    const mixed = "hm" + crypto.randomUUID().replace(/-/g, "");
    const fileName = m.attachment.name.replace(/["\\\r\n]/g, "");
    content = [
      `Content-Type: multipart/mixed; boundary="${mixed}"`, "",
      `--${mixed}`, ...alt,
      `--${mixed}`, `Content-Type: ${m.attachment.type}; name="${fileName}"`, `Content-Disposition: attachment; filename="${fileName}"`, "Content-Transfer-Encoding: base64", "",
      (bytesB64(m.attachment.bytes).match(/.{1,76}/g) || []).join("\r\n"),
      `--${mixed}--`,
    ];
  }
  const raw = [
    `From: ${encWord(fromName || sender)} <${sender}>`,
    `To: ${m.toName ? encWord(m.toName) + " " : ""}<${m.to}>`,
    `Subject: ${encWord(m.subject)}`,
    `List-Unsubscribe: <${m.unsubUrl}>`,
    "MIME-Version: 1.0",
    ...content,
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

// A client pitch through Brevo: the email exactly as written (its own HTML with the candidates
// button and unsubscribe link), replies to the agency, a one-click unsubscribe header, tagged.
const b64 = (bytes: Uint8Array) => { let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
export async function sendBrevoOutreach(m: OutMail, fromName: string, tag = "client-pitch", extraHeaders: Record<string, string> = {}): Promise<string> {
  const key = Deno.env.get("BREVO_API_KEY")!, senderEmail = Deno.env.get("BREVO_SENDER_EMAIL")!;
  // Client replies on (Outreach > Setup): replies come to Pronext, which forwards them on.
  const replyTo = m.replyTo || Deno.env.get("OUTREACH_REPLY_TO") || "";
  const html = m.html || `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;">${linkify(esc(m.body)).replace(/\n/g, "<br>")}</div>` +
    (m.unsubUrl ? `<p style="font-size:12px;color:#8A8578;margin-top:24px;"><a href="${esc(m.unsubUrl)}" style="color:#8A8578;">Unsubscribe</a></p>` : "");
  // extraHeaders: e.g. In-Reply-To / References, so a follow-up lands in the same thread. If Brevo
  // won't take them, the email goes without (it still threads by subject in most inboxes).
  const post = (extra: Record<string, string>) => fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "api-key": key },
    body: JSON.stringify({
      sender: { email: senderEmail, name: fromName || "ProNext" },
      to: [{ email: m.to, ...(m.toName ? { name: m.toName } : {}) }],
      ...(replyTo ? { replyTo: { email: replyTo, name: fromName || undefined } } : {}),
      subject: m.subject, htmlContent: html, textContent: m.body,
      ...(m.unsubUrl || Object.keys(extra).length ? { headers: { ...(m.unsubUrl ? { "List-Unsubscribe": `<${m.unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}), ...extra } } : {}),
      tags: [tag],
      ...(m.attachment ? { attachment: [{ name: m.attachment.name, content: b64(m.attachment.bytes) }] } : {}),
    }),
  });
  let res = await post(extraHeaders);
  let raw = await res.text().catch(() => "");
  if (!res.ok && res.status === 400 && Object.keys(extraHeaders).length) { res = await post({}); raw = await res.text().catch(() => ""); }
  if (!res.ok) throw new Error("Brevo " + res.status + ": " + raw.slice(0, 200));
  let id = "";
  try { id = String(JSON.parse(raw)?.messageId || ""); } catch { /* keep '' */ }
  return id;
}

export async function sendMail(m: OutMail, fromName: string): Promise<{ provider: Provider; ref: string }> {
  const p = provider(m.kind);
  if (p === "brevo") return { provider: p, ref: await sendBrevoOutreach(m, fromName) };
  if (p === "apollo") return { provider: p, ref: await sendViaApollo(m) };
  if (p === "instantly") return { provider: p, ref: await sendInstantly(m) };
  if (p === "gmail") return { provider: p, ref: await sendGmail(m, fromName) };
  throw new Error("No outreach sender is connected yet");
}
