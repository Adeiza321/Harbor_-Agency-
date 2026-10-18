// The assistant's memory: what it has learned working with each person (and, for the whole team,
// what Admins and Rec Ops have taught it), kept in public.assistant_memories.
//   - Loaded into every conversation, newest first, so the next task starts from what it knows.
//   - Learned after each reply: a quick AI pass over the exchange keeps only durable things the person
//     said (preferences, corrections, facts about clients, roles and how the agency works, decisions).
//   - "remember" / "forget" tools: when someone says "remember…" or "that's wrong", it saves or
//     drops a memory itself (no approval card: it changes nothing in ProNext's data).
//   - Declined suggestions are noted (kind 'declined'), so it stops proposing the same thing.
//   - search_conversations: it can look back through the person's own saved conversations.
// People see and delete what it remembers in the assistant panel ("Memory").

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const MEMORY_KINDS = ["preference", "correction", "fact", "decision", "note"];

export const MEMORY_TOOLS = [
  { name: "remember", description: "Save something to remember in future conversations, without asking: when the person says 'remember…', corrects you, states a lasting preference (how they like emails, what a client wants, a rule the agency follows), or makes a decision that should hold. One short sentence in their terms. scope 'team' (Admins and Rec Ops only) when it's true for everyone at the agency, e.g. a client's preference.",
    input_schema: { type: "object", properties: { text: { type: "string" }, kind: { type: "string", enum: MEMORY_KINDS }, scope: { type: "string", enum: ["personal", "team"] } }, required: ["text"] } },
  { name: "forget", description: "Stop remembering something that's wrong or out of date (the id shown beside it under WHAT YOU'VE LEARNED). Use when the person says it's no longer true; then remember the new version.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "search_conversations", description: "Search this person's own saved conversations with you (titles and messages) for something said before: an earlier plan, a decision, a draft. Returns matching snippets with dates.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];

export async function loadMemories(admin: any, me: any) {
  const [{ data: mine }, { data: team }] = await Promise.all([
    admin.from("assistant_memories").select("id,kind,text,scope,created_at").eq("user_id", me.id).eq("active", true).eq("scope", "personal").order("created_at", { ascending: false }).limit(60),
    admin.from("assistant_memories").select("id,kind,text,scope,created_at").eq("active", true).eq("scope", "team").order("created_at", { ascending: false }).limit(40),
  ]);
  return { mine: mine || [], team: team || [] };
}

export function memoryPrompt(me: any, m: { mine: any[]; team: any[] }) {
  const line = (x: any) => `- [${String(x.id).slice(0, 8)}] ${x.kind === "declined" ? "Declined: " : ""}${x.text} (${String(x.created_at).slice(0, 10)})`;
  const learned = m.mine.filter((x) => x.kind !== "declined");
  const declined = m.mine.filter((x) => x.kind === "declined").slice(0, 12);
  if (!learned.length && !declined.length && !m.team.length) return "\n\nMEMORY: nothing learned yet. When the person tells you something worth keeping (a preference, a correction, how a client works), save it with remember.";
  return "\n\nWHAT YOU'VE LEARNED (apply it without being reminded; newer wins over older; if the person now says otherwise, follow them, forget the old one and remember the new):" +
    (learned.length ? `\nWorking with ${me.full_name || "this person"}:\n${learned.map(line).join("\n")}` : "") +
    (m.team.length ? `\nTrue for the whole agency:\n${m.team.map(line).join("\n")}` : "") +
    (declined.length ? `\nSuggestions they declined recently (don't propose the same thing again unless asked):\n${declined.map(line).join("\n")}` : "");
}

export async function runMemoryTool(admin: any, me: any, name: string, input: any, threadId: string | null) {
  const staff = me.role === "admin" || me.role === "recops";
  if (name === "remember") {
    const text = clip(input?.text, 300);
    if (!text) return { error: "Nothing to remember" };
    const scope = input?.scope === "team" && staff ? "team" : "personal";
    const kind = MEMORY_KINDS.includes(input?.kind) ? input.kind : "note";
    const { data, error } = await admin.from("assistant_memories").insert({ user_id: me.id, scope, kind, text, source: "told", thread_id: threadId }).select("id").single();
    return error ? { error: error.message } : { ok: true, id: String(data.id).slice(0, 8), scope };
  }
  if (name === "forget") {
    const id = clip(input?.id, 40).toLowerCase();
    if (id.length < 6) return { error: "Give the memory's id" };
    const { data: rows } = await admin.from("assistant_memories").select("id,user_id,scope").eq("active", true).or(`user_id.eq.${me.id},scope.eq.team`).limit(200);
    const hit = (rows || []).find((r: any) => String(r.id).startsWith(id));
    if (!hit) return { error: "No memory with that id" };
    if (hit.user_id !== me.id && !(hit.scope === "team" && staff)) return { error: "Only Admins and Rec Ops can change what the whole team's assistant remembers" };
    await admin.from("assistant_memories").update({ active: false, updated_at: new Date().toISOString() }).eq("id", hit.id);
    return { ok: true };
  }
  if (name === "search_conversations") {
    const q = clip(input?.query, 80).toLowerCase();
    if (!q) return { error: "Nothing to search for" };
    const { data: ts } = await admin.from("assistant_threads").select("id,title,messages,updated_at").eq("user_id", me.id).order("updated_at", { ascending: false }).limit(150);
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    const out: any[] = [];
    for (const t of ts || []) {
      for (const m of Array.isArray(t.messages) ? t.messages : []) {
        const c = String(m?.content || "");
        const low = c.toLowerCase();
        if (!words.length || !words.every((w) => low.includes(w))) continue;
        const at = Math.max(0, low.indexOf(words[0]) - 120);
        out.push({ conversation: t.title || "Untitled", date: String(t.updated_at).slice(0, 10), who: m.role === "assistant" ? "you" : "them", snippet: c.slice(at, at + 400) });
        if (out.length >= 8) break;
      }
      if (out.length >= 8) break;
    }
    return out.length ? out : { found: 0, note: "Nothing in your saved conversations matches that." };
  }
  return { error: "Unknown memory tool" };
}

// After a reply: keep what's worth remembering from this exchange (0 to 3 short lines).
export async function learnFromTurn(admin: any, key: string, model: string, me: any, messages: any[], reply: string, mem: { mine: any[]; team: any[] }, threadId: string | null) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const said = clip(lastUser?.content, 2000);
  if (!said || said.length < 12) return;
  const before = [...messages].reverse().find((m, i, a) => m.role === "assistant" && i > 0);
  const known = [...mem.mine, ...mem.team].filter((x) => x.kind !== "declined").map((x) => "- " + x.text).join("\n") || "(nothing yet)";
  const sys = "You decide what an AI assistant inside a recruitment agency's app should remember about the person it works for, from one exchange. Reply with STRICT JSON only: {\"memories\": [{\"text\": string, \"kind\": \"preference\"|\"correction\"|\"fact\"|\"decision\", \"team\": boolean}]}. " +
    "Keep ONLY lasting things THE PERSON said or confirmed: how they like work done (tone, length, format of emails and messages, what to show first), corrections of something the assistant got wrong, facts about their clients, roles, candidates' situations or how the agency works, and decisions that should hold. " +
    "Skip one-off requests, greetings, questions, anything the assistant said or looked up, and anything already known (listed). Each memory one short sentence under 25 words, in plain words, specific (names, numbers). " +
    "team = true only for facts about clients, roles or agency rules that would help any colleague; false for personal preferences. Usually the answer is {\"memories\": []}.";
  const text = `Already known:\n${known}\n\nAssistant said before: ${clip(before?.content, 600) || "(start of conversation)"}\n\nThe person said: ${said}\n\nAssistant replied: ${clip(reply, 800)}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 600, temperature: 0, system: sys, messages: [{ role: "user", content: text }] }),
    });
    if (!res.ok) return;
    const out = await res.json();
    const raw = (out.content || []).map((b: any) => b.text || "").join("").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
    const m = raw.match(/\{[\s\S]*\}/);
    const items = m ? (JSON.parse(m[0]).memories || []) : [];
    const staff = me.role === "admin" || me.role === "recops";
    const rows = (Array.isArray(items) ? items : []).slice(0, 3).map((x: any) => ({
      user_id: me.id, scope: x?.team && staff ? "team" : "personal", kind: MEMORY_KINDS.includes(x?.kind) ? x.kind : "note",
      text: clip(x?.text, 300), source: "learned", thread_id: threadId,
    })).filter((r: any) => r.text);
    if (rows.length) await admin.from("assistant_memories").insert(rows);
    await admin.from("ai_usage").insert({ user_id: me.id, feature: "assistant_memory", model, input_tokens: Number(out?.usage?.input_tokens) || 0, output_tokens: Number(out?.usage?.output_tokens) || 0,
      cost_usd: ((Number(out?.usage?.input_tokens) || 0) * (/haiku-5/.test(model) ? 0.1 : 1) + (Number(out?.usage?.output_tokens) || 0) * (/haiku-5/.test(model) ? 0.5 : 5)) / 1e6 }).then(() => {}, () => {});
  } catch (e) { console.error("learn", String((e as Error)?.message || e)); }
}
