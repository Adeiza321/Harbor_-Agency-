import { createClient } from "npm:@supabase/supabase-js@2";

// "City, Country" without repeating a country the location already names (same as the app's jobPlace).
const COUNTRY_ALIASES: Record<string, string[]> = { "United States": ["usa", "us", "u.s.", "united states of america"], "United Kingdom": ["uk", "u.k.", "england", "scotland", "wales", "great britain"], "United Arab Emirates": ["uae"] };
function jobPlace(location?: string | null, country?: string | null) {
  const loc = String(location || "").trim(), c = String(country || "").trim();
  if (!c) return loc;
  if (/^remote\b.*worldwide/i.test(c)) return !loc ? c : /remote|worldwide|anywhere/i.test(loc) ? loc : loc + " \u00b7 Remote";
  if (!loc) return c;
  const low = loc.toLowerCase(), names = [c].concat(COUNTRY_ALIASES[c] || []).map((n) => n.toLowerCase());
  if (names.some((n) => new RegExp("(^|[\\s,(/-])" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[\\s,)/-])").test(low))) return loc;
  return loc + ", " + c;
}

// Public endpoint behind the links in outreach emails (no login; the random token in the link
// identifies the person). The page itself is Pronext's app at /?u=<token>&k=p|l&a=<action>,
// which calls this function:
//   info         what the link is about (role, company) so the page can show it; for a
//                candidate, also the job description with the client's name taken out
//   job          (page only) the job description page linked from a candidate email
//   interested   prospect: lands in the Inbox as an application for that job
//                lead: marked replied so a recruiter follows up
//   unsubscribe  never emailed again (hash of the address kept on the suppression list)
//   delete       as unsubscribe, and their details are erased from Pronext

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const normEmail = (e: string) => { const [u, d] = String(e || "").trim().toLowerCase().split("@"); return d ? u.replace(/\+.*$/, "") + "@" + d : ""; };
async function emailHash(e: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normEmail(e)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    // A client pitch goes to several people at a company, each with their own link:
    // <lead token>~<contact token>.
    const [token, contactToken = ""] = String(body.token || "").split("~");
    const kind = body.kind === "l" ? "l" : "p";
    const action = String(body.action || "info");
    if (!/^[0-9a-f]{32}$/.test(token) || (contactToken && !/^[0-9a-f]{16}$/.test(contactToken))) return json({ error: "This link isn't valid. Check you used the whole link from the email." }, 400);

    const suppress = async (email: string, reason: string) => {
      if (email) await admin.from("outreach_suppressions").upsert({ email_norm: await emailHash(email), reason }, { onConflict: "email_norm" });
      // Anything still waiting to go to them is cancelled.
      if (email) await admin.from("outreach_messages").update({ status: "skipped", error: "Unsubscribed" }).eq("status", "queued").eq("to_email", email);
    };

    if (kind === "p") {
      const { data: p } = await admin.from("prospects").select("id,job_id,first_name,full_name,email,status,jobs(role_title,location,country,work_setup,status,description,client,employment_type,min_pay,max_pay,currency,salary_period,commission_only)").eq("unsub_token", token).maybeSingle();
      if (!p) return json({ ok: true, gone: true });
      const job: any = (p as any).jobs || {};
      if (action === "info") {
        const { data: st } = await admin.from("agency_settings").select("agency_name,outreach").limit(1).maybeSingle();
        // The client is never named to an outside candidate: their name is taken out of the description.
        const client = String(job.client || "").trim();
        const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        let description = String(job.description || "");
        if (client.length >= 2) description = description.replace(new RegExp("\\b" + esc(client) + "('s)?\\b", "gi"), (_m: string, poss?: string) => (poss ? "our client's" : "our client"));
        const showPay = !!st?.outreach?.includePay && !job.commission_only && (job.min_pay || job.max_pay);
        let money = (n: number) => String(n);
        try { const f = new Intl.NumberFormat("en-US", { style: "currency", currency: job.currency || "USD", maximumFractionDigits: 0 }); money = (n: number) => f.format(n); } catch (_) { /* unknown currency code */ }
        const per = ({ yearly: "a year", monthly: "a month", weekly: "a week", daily: "a day", hourly: "an hour" } as Record<string, string>)[String(job.salary_period || "Yearly").toLowerCase()] || "";
        const pay = showPay ? [job.min_pay, job.max_pay].filter(Boolean).map((n: number) => money(Number(n))).join(" – ") + (per ? " " + per : "") : "";
        return json({ ok: true, kind, firstName: p.first_name, role: job.role_title, location: jobPlace(job.location, job.country), setup: job.work_setup, employment: job.employment_type || "",
          pay, description: job.status === "Closed" ? "" : description.slice(0, 20000), closed: job.status === "Closed", agencyName: String(st?.agency_name || "").trim(), status: p.status });
      }
      if (action === "unsubscribe") {
        await suppress(p.email, "unsubscribed");
        await admin.from("prospects").update({ status: "unsubscribed" }).eq("id", p.id);
        return json({ ok: true, done: "unsubscribed" });
      }
      if (action === "delete") {
        await suppress(p.email, "deleted on request");
        await admin.from("prospects").delete().eq("id", p.id);
        return json({ ok: true, done: "deleted" });
      }
      if (action === "interested") {
        if (job.status === "Closed") return json({ ok: true, done: "closed", role: job.role_title });
        if (!["interested", "converted"].includes(p.status)) {
          // The Inbox row first, then the status: someone a recruiter found is then given to that
          // recruiter straight away (prospects_sourced_interest), using this row.
          const { data: dup } = await admin.from("applications").select("id").eq("job_id", p.job_id).ilike("email", p.email).limit(1);
          if (!dup?.length) await admin.from("applications").insert({ name: p.full_name || p.first_name || "Outreach contact", email: p.email, role_title: job.role_title || "Role", job_id: p.job_id, source: "outreach", interest_at: new Date().toISOString() });
          await admin.from("prospects").update({ status: "interested" }).eq("id", p.id);
        }
        return json({ ok: true, done: "interested", role: job.role_title });
      }
      return json({ error: "Unknown action" }, 400);
    }

    const { data: l } = await admin.from("leads").select("id,job_title,company,contact_first_name,contact_email,status,notes,data").eq("unsub_token", token).maybeSingle();
    if (!l) return json({ ok: true, gone: true });
    // Whose link this is: one of the lead's contacts, or (older links) the lead's single contact.
    const contacts: any[] = Array.isArray(l.data?.contacts) ? l.data.contacts : [];
    const who = contactToken ? contacts.find((c) => c?.token === contactToken) : null;
    if (contactToken && !who) return json({ ok: true, gone: true });
    const email = who ? String(who.email || "") : l.contact_email || "";
    const firstName = who ? who.first_name || "" : l.contact_first_name;
    const saveContacts = (list: any[]) => admin.from("leads").update({ data: { ...(l.data || {}), contacts: list } }).eq("id", l.id);
    if (action === "info") return json({ ok: true, kind, firstName, role: l.job_title, company: l.company, status: l.status });
    if (action === "unsubscribe" || action === "delete") {
      await suppress(email, action === "delete" ? "deleted on request" : "unsubscribed");
      // Their replies to us go too.
      if (action === "delete" && email) await admin.from("client_replies").delete().ilike("from_email", email.trim());
      if (who) {
        // Just this person; the lead carries on with the others.
        const list = action === "delete" ? contacts.filter((c) => c.token !== contactToken) : contacts.map((c) => c.token === contactToken ? { ...c, unsubscribed: true } : c);
        await saveContacts(list);
        const left = list.filter((c) => c?.email && !c.unsubscribed && !c.removed);
        if (!left.length) await admin.from("leads").update({ status: "unsubscribed" }).eq("id", l.id);
        if (String(l.contact_email || "").toLowerCase() === email.toLowerCase()) {
          const m = left[0];
          await admin.from("leads").update({ contact_name: m?.name || null, contact_first_name: m?.first_name || null, contact_role: m ? (m.title || m.role) : null, contact_linkedin: m?.linkedin || null, contact_email: m?.email || null }).eq("id", l.id);
        }
      } else if (action === "delete") {
        await admin.from("leads").update({ status: "unsubscribed", contact_name: null, contact_first_name: null, contact_role: null, contact_linkedin: null, contact_email: null, contact_email_status: null }).eq("id", l.id);
      } else {
        await admin.from("leads").update({ status: "unsubscribed" }).eq("id", l.id);
      }
      return json({ ok: true, done: action === "delete" ? "deleted" : "unsubscribed" });
    }
    if (action === "interested") {
      // Interested: the contract goes out by itself on the next outreach run (sourcing stepContracts),
      // to whoever clicked.
      if (!["replied", "meeting", "won"].includes(l.status))
        await admin.from("leads").update({ status: "replied", notes: [l.notes, "Clicked 'interested' in the email" + (who ? " (" + (who.name || who.email) + ")" : "") + " " + new Date().toISOString().slice(0, 10)].filter(Boolean).join("\n") }).eq("id", l.id);
      if (who && !l.data?.interested_by) await admin.from("leads").update({ data: { ...(l.data || {}), interested_by: { email: who.email, name: who.name || "", first_name: who.first_name || "", token: who.token } } }).eq("id", l.id);
      await admin.from("leads").update({ interested_at: new Date().toISOString() }).eq("id", l.id).is("interested_at", null);
      return json({ ok: true, done: "interested", role: l.job_title });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("outreach-public", String((e as Error)?.message || e));
    return json({ error: "Something went wrong on our side. Please try again in a minute." }, 500);
  }
});
