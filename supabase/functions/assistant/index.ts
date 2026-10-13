import { createClient } from "npm:@supabase/supabase-js@2";

// The ProNext assistant. Signed-in staff only. It never changes anything itself: it answers,
// drafts, and PROPOSES actions; each proposal comes back to the app as a card the person has to
// approve, and the app then carries it out with that person's own permissions.
//   POST { messages: [{ role, content }], context: { me, today, tz, jobs, candidates, users } }
//   ->   { text, proposals: [{ tool, input }] }
// Each call's token use is logged to public.ai_usage (feature 'assistant') for spend tracking.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";
// USD per million tokens (Haiku 4.5), for the spend log.
const PRICE_IN = 1, PRICE_OUT = 5;

const TOOLS = [
  { name: "propose_job_draft", description: "Propose creating a new job as a DRAFT (the person reviews and publishes it). Use when asked to post/create/add a job.",
    input_schema: { type: "object", properties: {
      role: { type: "string" }, client: { type: "string" }, location: { type: "string" }, country: { type: "string" },
      work_setup: { type: "string", enum: ["Remote", "Hybrid", "On-site"] }, employment_type: { type: "string", enum: ["Full-time", "Part-time", "Contract", "Temporary", "Internship"] },
      description: { type: "string", description: "A clear job description: summary, responsibilities, requirements." },
      currency: { type: "string", description: "ISO code, e.g. USD" }, min_pay: { type: "number" }, max_pay: { type: "number" },
      fee_amount: { type: "number", description: "What the agency earns: a flat amount (e.g. Reflik incentive) or a percent" }, fee_type: { type: "string", enum: ["flat", "percent"] },
      contract: { type: "boolean", description: "True when the fee is paid monthly (a contract role)" }, contract_months: { type: "number" },
    }, required: ["role", "client"] } },
  { name: "propose_interview", description: "Propose scheduling an interview for a candidate.",
    input_schema: { type: "object", properties: {
      candidate_id: { type: "string" }, job_id: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM, 24h" },
      timezone: { type: "string", description: "IANA zone of the given time; default the person's own" }, duration_min: { type: "number" }, round: { type: "string" },
      location_type: { type: "string", enum: ["meet", "phone", "link", "in_person"] }, location: { type: "string" }, notes: { type: "string" }, notify_candidate: { type: "boolean" },
    }, required: ["candidate_id", "date", "time"] } },
  { name: "propose_note", description: "Propose adding internal feedback / a note to a candidate's profile (only the team sees it).",
    input_schema: { type: "object", properties: { candidate_id: { type: "string" }, text: { type: "string" } }, required: ["candidate_id", "text"] } },
  { name: "propose_message", description: "Propose sending a chat message (also emailed) to a candidate about a role, e.g. sharing feedback or asking them to update their details.",
    input_schema: { type: "object", properties: { candidate_id: { type: "string" }, job_id: { type: "string" }, text: { type: "string" } }, required: ["candidate_id", "text"] } },
  { name: "propose_stage", description: "Propose moving a candidate to a new stage on a role.",
    input_schema: { type: "object", properties: { candidate_id: { type: "string" }, job_id: { type: "string" },
      stage: { type: "string", enum: ["Sourced", "In review", "Screening", "Submitted", "Interview", "Offer", "Placed", "Rejected", "Withdrawn"] } }, required: ["candidate_id", "stage"] } },
  { name: "propose_task", description: "Propose a to-do / reminder with an optional due date. Admins and Rec Ops can assign it to someone else (assigned_to = their user id).",
    input_schema: { type: "object", properties: { title: { type: "string" }, due_on: { type: "string", description: "YYYY-MM-DD" }, assigned_to: { type: "string" } }, required: ["title"] } },
];

function systemPrompt(ctx: any) {
  return `You are the ProNext assistant inside a recruitment agency's workspace. You help ${ctx?.me?.name || "the user"} (${ctx?.me?.role || "staff"}) get work done.
Today is ${ctx?.today || ""} (${ctx?.tz || "UTC"}).
Rules:
- You cannot change anything yourself. To do something, call one of the propose_* tools; the person approves it in the app. Say briefly what you proposed.
- Only use ids from the lists below. If a name matches more than one person or role, or something required is missing (e.g. a time), ask a short question instead of guessing.
- Several actions can be proposed in one reply (e.g. a message and a reminder).
- Drafting an email or message for the person to send themselves: write it in your reply (no tool). Keep drafts short, warm and professional.
- Be brief. Plain text, no markdown headings.
- Never invent facts about candidates; use only what's below.

Open jobs (id | role | client | fee):
${(ctx?.jobs || []).map((j: any) => `${j.id} | ${j.role} | ${j.client}${j.fee ? " | " + j.fee : ""}`).join("\n") || "(none)"}

Candidates (id | name | current role | status | roles they're on as job_id:stage):
${(ctx?.candidates || []).map((c: any) => `${c.id} | ${c.name} | ${c.role || ""} | ${c.status || ""} | ${(c.links || []).map((l: any) => l.jobId + ":" + l.stage).join(", ")}`).join("\n") || "(none)"}

Team (id | name | role):
${(ctx?.users || []).map((u: any) => `${u.id} | ${u.name} | ${u.role}`).join("\n") || "(none)"}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: caller } = await admin.auth.getUser(jwt);
    if (!caller?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("profiles").select("status").eq("id", caller.user.id).single();
    if (!me || me.status !== "Active") return json({ error: "Your account isn't active" }, 403);
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "The assistant isn't connected (ANTHROPIC_API_KEY)" }, 400);

    const body = await req.json().catch(() => ({}));
    const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
      .map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 4000) }))
      .filter((m: any) => m.content);
    if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "Ask something first" }, 400);
    while (messages.length && messages[0].role !== "user") messages.shift();

    const payload = JSON.stringify({ model: MODEL, max_tokens: 1200, system: systemPrompt(body.context || {}), tools: TOOLS, messages });
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: payload });
      if (res.ok || ![429, 500, 502, 503, 529].includes(res.status)) break;
      await sleep(attempt === 0 ? 2000 : 5000);
    }
    if (!res!.ok) {
      const t = (await res!.text()).slice(0, 300);
      if (/credit balance/i.test(t)) return json({ error: "The Claude account is out of credit. Top up at console.anthropic.com, then try again." }, 402);
      return json({ error: [429, 529].includes(res!.status) ? "The assistant is busy right now. Try again in a minute." : "The assistant couldn't answer (" + res!.status + ")." }, 502);
    }
    const out = await res!.json();
    const blocks: any[] = Array.isArray(out?.content) ? out.content : [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const proposals = blocks.filter((b) => b.type === "tool_use").map((b) => ({ tool: String(b.name), input: b.input || {} }));

    const inTok = Number(out?.usage?.input_tokens) || 0, outTok = Number(out?.usage?.output_tokens) || 0;
    await admin.from("ai_usage").insert({ user_id: caller.user.id, feature: "assistant", model: MODEL, input_tokens: inTok, output_tokens: outTok,
      cost_usd: Math.round(((inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6) * 1e6) / 1e6 }).then(() => {}, () => {});

    return json({ ok: true, text: text || (proposals.length ? "Here's what I'd do. Approve to go ahead." : ""), proposals });
  } catch (e) {
    console.error("assistant", String((e as Error)?.message || e));
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
