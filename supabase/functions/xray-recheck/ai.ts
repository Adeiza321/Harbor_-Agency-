// Claude for sourcing: ranking prospects, checking fit, and writing outreach.
// Same provider and model as screening (ANTHROPIC_API_KEY, ANTHROPIC_MODEL, default Haiku 4.5).

const MODEL = () => Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  throw new Error("AI returned something unexpected: " + text.slice(0, 200));
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
    if (/credit balance/i.test(body)) throw new Error("The Claude account is out of credit.");
    throw new Error("AI request failed (" + res!.status + "): " + body);
  }
  const data = await res!.json();
  if (data.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off before it finished");
  return parseJson((data.content || []).map((b: any) => b.text || "").join(""));
}
