// Claude for sourcing: ranking prospects, checking fit, and writing outreach.
// Same provider and model as screening (ANTHROPIC_API_KEY, ANTHROPIC_MODEL, default Haiku 4.5).

import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "npm:@supabase/supabase-js@2";

// What each Claude call costs, logged to ai_usage (Team audit and the AI spend figures), like the
// assistant and screening. The request sets what it's for and who it's charged to (aiCharge);
// scheduled runs have no user ("System").
export type AiCharge = { feature: string; userId: string | null };
export const aiCharge = new AsyncLocalStorage<AiCharge>();
const PRICE: Record<string, [number, number]> = { haiku: [1, 5], sonnet: [3, 15], opus: [5, 25] };
let usageDb: any = null;
export async function logAiUsage(usage: any, model: string, fallbackFeature = "sourcing") {
  if (!usage) return;
  try {
    usageDb = usageDb || createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const c = aiCharge.getStore();
    const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    const outTok = usage.output_tokens || 0;
    const [pi, po] = PRICE[Object.keys(PRICE).find((k) => model.includes(k)) || "sonnet"];
    const searches = Number(usage.server_tool_use?.web_search_requests) || 0;   // $10 per 1,000 web searches
    const cost = (inTok * pi + outTok * po) / 1e6 + searches * 0.01;
    await usageDb.from("ai_usage").insert({ user_id: c?.userId ?? null, feature: (c?.feature || fallbackFeature).slice(0, 60), model, input_tokens: inTok, output_tokens: outTok, cost_usd: Math.round(cost * 1e6) / 1e6 });
  } catch (e) { console.error("ai usage log", String((e as Error)?.message || e)); }
}

const MODEL = () => Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  throw new Error("AI returned something unexpected: " + text.slice(0, 200));
}

// When the Claude account runs out of credit (or its key stops working), ProNext keeps going
// without the AI: the failure is recorded (public.ai_health, shown as a banner in the dashboard)
// and callers skip the AI step. It clears itself on the next call that works.
export const AI_PAUSED = "AI is paused: the Claude account is out of credit or its key isn't working. Everything else keeps working; top up at console.anthropic.com to turn the AI back on.";
export const isAiPaused = (e: unknown) => /^AI is paused/.test(String((e as Error)?.message || e || ""));
export const aiDownFrom = (status: number, body: string) => status === 401 || status === 403 || /credit balance|billing|insufficient|invalid x-api-key|authentication_error|permission_error/i.test(body);
let healthClient: any = null;
export async function noteAiHealth(down: boolean, reason = "") {
  try {
    healthClient = healthClient || createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await healthClient.rpc("note_ai_health", { p_down: down, p_reason: reason.slice(0, 300) });
  } catch (_) { /* never let this break the caller */ }
}

export async function askAI(system: string, text: string, maxTokens = 4000): Promise<any> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("AI is not configured: add an ANTHROPIC_API_KEY secret.");
  const payload = JSON.stringify({ model: MODEL(), max_tokens: Math.max(maxTokens, 2000), temperature: 0, system, messages: [{ role: "user", content: text }] });
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: payload,
    });
    if (res.ok || ![429, 500, 502, 503, 529].includes(res.status)) break;
    await sleep(attempt === 0 ? 2000 : 6000);
  }
  if (!res!.ok) {
    const body = (await res!.text()).slice(0, 300);
    if (aiDownFrom(res!.status, body)) { await noteAiHealth(true, body); throw new Error(AI_PAUSED); }
    throw new Error("AI request failed (" + res!.status + "): " + body);
  }
  noteAiHealth(false);
  const data = await res!.json();
  await logAiUsage(data.usage, String(data.model || MODEL()));
  if (data.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off before it finished");
  return parseJson((data.content || []).map((b: any) => b.text || "").join(""));
}
