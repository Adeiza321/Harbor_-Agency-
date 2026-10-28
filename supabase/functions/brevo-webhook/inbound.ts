// Client replies, from Brevo's inbound parsing (an { items: [...] } post to this webhook).
//
// Client pitches and follow-ups go out with replies@<our reply subdomain> as the reply-to. Brevo
// receives that mail and posts it here. For each email:
//   1. It's matched to its lead: by the email thread (In-Reply-To / References = the Brevo message
//      id we kept for the pitch), else by who sent it (a contact we emailed), else by their company's
//      email domain (a colleague answering for them).
//   2. It's kept in client_replies.
//   3. A real reply stops that lead's follow-ups for good and moves it to Replied. An automatic reply
//      (out of office, "this mailbox isn't monitored") or likely spam doesn't.
//   4. Whoever sent the pitch and the Admins get a notification.
//   5. It's forwarded to the team's mailbox (OUTREACH_REPLY_TO, else the person who sent the
//      pitch, else the Admins) with the client as the reply-to, attachments included, so answering
//      it there goes straight back to the client.
// The setup check (sourcing reply_setup) sends an email to replies-check-<token>@<domain>; when it
// arrives here the reply address is switched on.

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
const lc = (s: unknown) => String(s || "").trim().toLowerCase();
const PERSONAL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|proton|protonmail|gmx|mail|zoho)\./i;

function header(h: any, name: string): string {
  if (!h || typeof h !== "object") return "";
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  const v = k ? h[k] : "";
  return Array.isArray(v) ? v.join(" ") : String(v || "");
}
// Out of office and other automatic answers: they don't count as the client responding.
export function isAutoReply(it: any): boolean {
  const h = it?.Headers || {};
  const auto = lc(header(h, "Auto-Submitted"));
  if (auto && auto !== "no") return true;
  if (header(h, "X-Autoreply") || header(h, "X-Autorespond") || header(h, "X-Auto-Response-Suppress").match(/all|oof|autoreply/i)) return true;
  if (/auto_reply|auto-reply|bulk|junk/i.test(header(h, "Precedence"))) return true;
  const subj = String(it?.Subject || "");
  if (/^\s*(automatic reply|auto(matic)?[- ]?reply|autoreply|out of (the )?office|ooo\b|away from (the )?office|on (annual )?leave|undeliverable|delivery status notification|mail delivery (failed|subsystem))/i.test(subj)) return true;
  const body = String(it?.ExtractedMarkdownMessage || it?.RawTextBody || "").slice(0, 600);
  return /\b(i am|i'm|i will be) (currently )?(out of (the )?office|away|on (annual )?leave|on vacation)\b|this (mailbox|inbox) is (not|no longer) monitored/i.test(body);
}
const refsOf = (it: any) => {
  const raw = [it?.InReplyTo, header(it?.Headers, "In-Reply-To"), header(it?.Headers, "References")].filter(Boolean).join(" ");
  const ids = new Set<string>();
  for (const m of raw.match(/<[^<>\s]+>/g) || []) { ids.add(m); ids.add(m.slice(1, -1)); }
  return Array.from(ids).slice(0, 40);
};

async function matchLead(admin: any, it: any, from: string) {
  const refs = refsOf(it);
  if (refs.length) {
    const { data } = await admin.from("outreach_messages").select("id,lead_id").in("provider_ref", refs).not("lead_id", "is", null).order("sent_at", { ascending: false }).limit(1);
    if (data?.[0]) return { leadId: data[0].lead_id, msgId: data[0].id, by: "thread" };
  }
  const since = new Date(Date.now() - 180 * 864e5).toISOString();
  const { data: sent } = await admin.from("outreach_messages").select("id,lead_id").eq("kind", "client").ilike("to_email", from).not("lead_id", "is", null).gte("sent_at", since).order("sent_at", { ascending: false }).limit(1);
  if (sent?.[0]) return { leadId: sent[0].lead_id, msgId: sent[0].id, by: "sender" };
  const { data: byContact } = await admin.from("leads").select("id").ilike("contact_email", from).not("contacted_at", "is", null).order("contacted_at", { ascending: false }).limit(1);
  if (byContact?.[0]) return { leadId: byContact[0].id, msgId: null, by: "contact" };
  // Someone else at the company (their colleague, or HR answering for the hiring manager).
  const domain = from.split("@")[1] || "";
  if (domain && !PERSONAL.test(from)) {
    const { data: byDomain } = await admin.from("leads").select("id").eq("company_domain", domain).in("status", ["contacted", "replied", "meeting"]).gte("contacted_at", since).order("contacted_at", { ascending: false }).limit(1);
    if (byDomain?.[0]) return { leadId: byDomain[0].id, msgId: null, by: "domain" };
  }
  return null;
}

async function brevoAttachment(token: string) {
  const res = await fetch("https://api.brevo.com/v3/inbound/attachments/" + encodeURIComponent(token), { headers: { "api-key": Deno.env.get("BREVO_API_KEY")! } });
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function forward(admin: any, it: any, r: { from: string; fromName: string; lead: any; auto: boolean; spam: boolean; senderId: string | null }) {
  const key = Deno.env.get("BREVO_API_KEY"), senderEmail = Deno.env.get("BREVO_SENDER_EMAIL");
  if (!key || !senderEmail) throw new Error("Brevo isn't set up");
  // Where the team reads replies.
  let to: { email: string; name?: string }[] = [];
  const set = Deno.env.get("OUTREACH_REPLY_TO") || "";
  // (Never the reply address itself, which would loop.)
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(set) && !/^replies(-check-[a-f0-9]+)?@/i.test(set)) to = [{ email: set }];
  if (!to.length && r.senderId) {
    const { data: p } = await admin.from("profiles").select("email,full_name").eq("id", r.senderId).maybeSingle();
    if (p?.email) to = [{ email: p.email, name: p.full_name || undefined }];
  }
  if (!to.length) {
    const { data: admins } = await admin.from("profiles").select("email,full_name").eq("role", "admin").eq("status", "Active");
    to = (admins || []).filter((a: any) => a.email).map((a: any) => ({ email: a.email, name: a.full_name || undefined }));
  }
  if (!to.length) throw new Error("No one to forward the reply to");
  const l = r.lead;
  const what = l ? `${esc(l.company)} · ${esc(l.job_title)}` : "";
  const note = r.spam ? "This looks like spam, so the lead wasn't changed."
    : !l ? "We couldn't match this to a lead."
    : r.auto ? "This is an automatic reply (out of office or similar), so follow-ups carry on."
    : "Follow-ups to this lead have stopped and it's moved to Replied.";
  const banner = `<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;background:#E8F1EC;color:#14503C;border-radius:10px;padding:10px 14px;margin:0 0 16px;">` +
    `<b>${esc(r.fromName || r.from)}</b> &lt;${esc(r.from)}&gt; replied${what ? " about " + what : ""}. ${esc(note)} Reply to this email to answer them directly.</div>`;
  const body = it.RawHtmlBody ? String(it.RawHtmlBody) : `<div style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;">${esc(it.RawTextBody || it.ExtractedMarkdownMessage || "")}</div>`;
  // Attachments, up to about 8 MB in all.
  const atts: { name: string; content: string }[] = [];
  let size = 0;
  for (const a of Array.isArray(it.Attachments) ? it.Attachments.slice(0, 10) : []) {
    const len = Number(a?.ContentLength) || 0;
    if (!a?.DownloadToken || size + len > 8e6) continue;
    const content = await brevoAttachment(String(a.DownloadToken)).catch(() => null);
    if (content) { atts.push({ name: String(a.Name || "attachment"), content }); size += len; }
  }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json", "api-key": key },
    body: JSON.stringify({
      sender: { email: senderEmail, name: (r.fromName || r.from).slice(0, 60) + " via Pronext" },
      to, replyTo: { email: r.from, ...(r.fromName ? { name: r.fromName } : {}) },
      subject: String(it.Subject || "(no subject)").slice(0, 250),
      htmlContent: banner + body, tags: ["client-reply"],
      ...(atts.length ? { attachment: atts } : {}),
    }),
  });
  if (!res.ok) throw new Error("Brevo " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 200));
}

export async function handleInbound(admin: any, items: any[]) {
  let stored = 0, forwarded = 0, failed = 0;
  for (const it of items.slice(0, 50)) {
    const from = lc(it?.From?.Address || it?.ReplyTo?.Address);
    if (!from) continue;
    const fromName = String(it?.From?.Name || "").trim().slice(0, 120);
    const rcpts = [...(Array.isArray(it?.Recipients) ? it.Recipients : []), ...(Array.isArray(it?.To) ? it.To.map((x: any) => x?.Address) : [])].map(lc);

    // The setup check: switch the reply address on.
    const check = rcpts.map((x) => /^replies-check-([a-f0-9]{16,})@/.exec(x)).find(Boolean);
    if (check) {
      const { data: st } = await admin.from("agency_settings").select("id,replies").limit(1).maybeSingle();
      const rep = st?.replies || {};
      if (st && rep.testToken && rep.testToken === check[1]) {
        await admin.from("agency_settings").update({ replies: { ...rep, status: "on", verifiedAt: new Date().toISOString(), testToken: null } }).eq("id", st.id);
      }
      continue;
    }

    const messageId = String(it?.MessageId || "").trim().slice(0, 500) || `${from}|${it?.SentAtDate || ""}|${String(it?.Subject || "").slice(0, 80)}`;
    const { data: prev } = await admin.from("client_replies").select("id,forwarded_at,lead_id").eq("message_id", messageId).maybeSingle();
    if (prev?.forwarded_at) continue;
    const auto = isAutoReply(it);
    const spamScore = Number(it?.SpamScore ?? it?.Spam?.Score ?? 0);
    const spam = Number.isFinite(spamScore) && spamScore >= 5;
    const m = await matchLead(admin, it, from);
    const { data: lead } = m ? await admin.from("leads").select("id,company,job_title,status,data").eq("id", m.leadId).maybeSingle() : { data: null };
    const text = String(it?.ExtractedMarkdownMessage || it?.RawTextBody || "").trim().slice(0, 20000);
    const row = {
      message_id: messageId, lead_id: lead?.id || null, outreach_message_id: m?.msgId || null, from_email: from, from_name: fromName || null,
      subject: String(it?.Subject || "").slice(0, 500) || null, body: text || null, auto, spam,
      attachments: (Array.isArray(it?.Attachments) ? it.Attachments : []).map((a: any) => ({ name: String(a?.Name || ""), type: String(a?.ContentType || ""), size: Number(a?.ContentLength) || 0 })),
      matched_by: lead ? m!.by : null,
    };
    let id = prev?.id;
    if (!id) {
      const { data: ins, error } = await admin.from("client_replies").insert(row).select("id").single();
      if (error) throw new Error(error.message);
      id = ins.id;
      stored++;
    }

    // Who sent the pitch: told about the reply (with the Admins), and gets it if no team mailbox is set.
    let senderId: string | null = null;
    if (lead) {
      const { data: first } = await admin.from("outreach_messages").select("approved_by").eq("lead_id", lead.id).eq("kind", "client").eq("status", "sent").order("sent_at").limit(1).maybeSingle();
      senderId = first?.approved_by || null;
    }
    if (lead && !auto && !spam && !prev) {
      const now = new Date().toISOString();
      const d = lead.data || {};
      const snippet = text.replace(/\s+/g, " ").slice(0, 200);
      await admin.from("leads").update({
        status: ["contacted", "queued", "approved", "new"].includes(lead.status) ? "replied" : lead.status,
        data: { ...d, followups: { ...(d.followups || {}), paused: true, reason: "They replied", auto: true, at: now }, last_reply: { at: now, from, name: fromName, snippet, id } },
      }).eq("id", lead.id);
      const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin").eq("status", "Active");
      const users = Array.from(new Set([senderId, ...(admins || []).map((a: any) => a.id)].filter(Boolean)));
      for (const u of users) {
        await admin.rpc("push_update", { p_user: u, p_kind: "event", p_title: `${fromName || from} at ${lead.company} replied (${lead.job_title})`,
          p_body: (snippet || "Open the lead to read it.") + " Follow-ups have stopped; the reply is in your inbox.", p_link: { page: "campaigns", lead: lead.id }, p_dedupe: "client-reply:" + id }).then(() => {}, () => {});
      }
    }
    try {
      await forward(admin, it, { from, fromName, lead, auto, spam, senderId });
      await admin.from("client_replies").update({ forwarded_at: new Date().toISOString(), forward_error: null }).eq("id", id);
      forwarded++;
    } catch (e) {
      failed++;
      await admin.from("client_replies").update({ forward_error: String((e as Error)?.message || e).slice(0, 300) }).eq("id", id);
    }
  }
  return { stored, forwarded, failed };
}
