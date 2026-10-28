// Setting up client replies (Outreach > Setup > Client replies). Admins only.
//
// Client pitches and follow-ups get replies@<reply subdomain> as their reply-to once this is on, so
// Pronext sees every reply (brevo-webhook/inbound.ts), stops the follow-ups and forwards the reply to
// the team. Turning it on:
//   1. Two MX records on the reply subdomain (e.g. reply.pronextglobal.com) pointing at Brevo's
//      inbound servers. The subdomain only receives replies; your normal email isn't touched.
//   2. "Check and turn on": checks those records, registers the inbound webhook with Brevo (the same
//      brevo-webhook URL and token as the email events), and emails replies-check-<token>@<domain>.
//   3. When that email comes back through Brevo, the reply address is switched on. Until then,
//      replies keep going to your mailbox as before, so nothing is lost if something isn't right.

const MX = ["inbound1.sendinblue.com", "inbound2.sendinblue.com"];
const DOMAIN_RE = /^(?=.{4,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, "0")).join("");

export type ReplySetup = { domain?: string; status?: "dns" | "testing" | "on" | "off"; testToken?: string | null; testedAt?: string; verifiedAt?: string; webhookId?: number | null; error?: string };

async function load(admin: any): Promise<{ id: string | null; r: ReplySetup }> {
  const { data } = await admin.from("agency_settings").select("id,replies").limit(1).maybeSingle();
  return { id: data?.id || null, r: (data?.replies && typeof data.replies === "object") ? data.replies : {} };
}
async function save(admin: any, id: string | null, r: ReplySetup) {
  if (!id) throw new Error("Agency settings aren't set up yet");
  const { error } = await admin.from("agency_settings").update({ replies: r }).eq("id", id);
  if (error) throw new Error(error.message);
}
const senderDomain = () => String(Deno.env.get("BREVO_SENDER_EMAIL") || "").split("@")[1]?.toLowerCase() || "";
export const defaultReplyDomain = () => senderDomain() ? "reply." + senderDomain() : "";

// What the setup card shows.
export async function replyStatus(admin: any) {
  const { r } = await load(admin);
  const domain = r.domain || defaultReplyDomain();
  let status = r.status || "off";
  // The check email never came back.
  const stale = status === "testing" && r.testedAt && Date.now() - new Date(r.testedAt).getTime() > 15 * 60e3;
  return { ok: true, domain, status: stale ? "test_failed" : status, address: status === "on" ? "replies@" + domain : "", verifiedAt: r.verifiedAt || null,
    records: MX.map((v, i) => ({ type: "MX", host: domain, priority: (i + 1) * 10, value: v + "." })), error: r.error || "",
    forwardTo: Deno.env.get("OUTREACH_REPLY_TO") || "" };
}

async function mxOk(domain: string) {
  const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, { headers: { accept: "application/dns-json" } });
  const j = await res.json().catch(() => ({}));
  const got = (Array.isArray(j?.Answer) ? j.Answer : []).map((a: any) => String(a?.data || "").toLowerCase());
  return { ok: got.some((x: string) => x.includes("sendinblue.com") || x.includes("brevo.com")), got };
}

async function brevo(path: string, init: RequestInit = {}) {
  const res = await fetch("https://api.brevo.com/v3" + path, { ...init, headers: { accept: "application/json", "content-type": "application/json", "api-key": Deno.env.get("BREVO_API_KEY")!, ...(init.headers || {}) } });
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw new Error("Brevo " + res.status + ": " + raw.slice(0, 200));
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// "Check and turn on".
export async function replySetup(admin: any, domainIn?: string) {
  if (!Deno.env.get("BREVO_API_KEY") || !Deno.env.get("BREVO_SENDER_EMAIL")) throw new Error("Brevo isn't set up for sending yet");
  const { id, r } = await load(admin);
  const domain = String(domainIn || r.domain || defaultReplyDomain()).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!DOMAIN_RE.test(domain)) throw new Error("Enter a subdomain such as reply." + (senderDomain() || "yourcompany.com"));
  if (domain === senderDomain()) throw new Error("Use a subdomain (such as reply." + domain + "), not the domain you send from: its MX records would take over your normal email.");
  const dns = await mxOk(domain);
  if (!dns.ok) {
    await save(admin, id, { ...r, domain, status: "dns", error: dns.got.length ? "Found other MX records: " + dns.got.join(", ") : "" });
    return replyStatus(admin);
  }
  // The inbound webhook: Brevo posts replies to the same URL as the email events.
  const { data: token } = await admin.rpc("brevo_webhook_secret");
  if (!token) throw new Error("The Brevo webhook token isn't set up (vault secret brevo_webhook_token)");
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/brevo-webhook?token=${token}`;
  const list = await brevo("/webhooks?type=inbound");
  const mine = (Array.isArray(list?.webhooks) ? list.webhooks : []).find((w: any) => String(w?.url || "").includes("/functions/v1/brevo-webhook") && (!w.domain || String(w.domain).toLowerCase() === domain));
  let webhookId: number | null = mine?.id ?? null;
  if (mine) await brevo("/webhooks/" + mine.id, { method: "PUT", body: JSON.stringify({ url, events: ["inboundEmailProcessed"], domain, description: "Pronext client replies" }) });
  else webhookId = (await brevo("/webhooks", { method: "POST", body: JSON.stringify({ type: "inbound", events: ["inboundEmailProcessed"], url, domain, description: "Pronext client replies" }) }))?.id ?? null;
  // The round trip: an email to the reply domain, which switches it on when it comes back.
  const testToken = hex(12);
  await brevo("/smtp/email", { method: "POST", body: JSON.stringify({
    sender: { email: Deno.env.get("BREVO_SENDER_EMAIL"), name: "Pronext" }, to: [{ email: `replies-check-${testToken}@${domain}` }],
    subject: "Pronext reply check", textContent: "This checks that client replies reach Pronext. Nothing to do.", tags: ["reply-check"] }) });
  await save(admin, id, { ...r, domain, status: "testing", testToken, testedAt: new Date().toISOString(), webhookId, error: "" });
  return replyStatus(admin);
}

// Back to replies going straight to your mailbox.
export async function replyOff(admin: any) {
  const { id, r } = await load(admin);
  await save(admin, id, { ...r, status: "off", testToken: null });
  return replyStatus(admin);
}
