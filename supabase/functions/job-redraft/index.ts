import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Rewrites a job ad for search (Google for Jobs, LinkedIn, job boards).
// Called from the "AI redraft for SEO" button on Post a job.
// Needs the ANTHROPIC_API_KEY secret on the Supabase project.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "AI is not set up yet: add an ANTHROPIC_API_KEY secret to this Supabase project." }, 503);

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const title = clip(input.title, 200).trim();
  const description = clip(input.description, 12000).trim();
  if (!title || description.length < 40) return json({ error: "Add a job title and a job description (at least a few sentences) first." }, 400);

  const facts = [
    `Job title: ${title}`,
    `Client (never name them in the ad): ${clip(input.client, 200)}`,
    `Work location / arrangement: ${clip(input.location, 200) || "not given"}`,
    `Country we are hiring in: ${clip(input.country, 100) || "not given"}`,
    `Salary: ${input.minPay || input.maxPay ? `${input.minPay || "?"} to ${input.maxPay || "?"} ${clip(input.currency, 3)} per year` : "not given"}`,
    "",
    "Original job description:",
    description,
  ].join("\n");

  const system = `You are an expert recruitment copywriter for a staffing agency. Rewrite job ads so they rank well in Google for Jobs, LinkedIn and job-board search, and so qualified candidates want to apply.

Rules:
- Use ONLY facts in the input. Never invent benefits, perks, company details, numbers, tools or requirements. Keep every requirement, pay figure and condition (e.g. visa sponsorship, relocation) that is given.
- Never name the client company. Refer to it generically from what the input says (e.g. "our client, a leading fintech").
- Title: the clearest standard job title candidates actually search for, optionally with one short qualifier (e.g. "(Remote)"). No emojis, no ALL CAPS, max 70 characters.
- Description: plain text (no markdown symbols like # or **). Short opening paragraph that states the role, seniority, location/remote status and country naturally. Then sections with these plain headings on their own line: About the role, What you'll do, What you'll bring, Nice to have (only if given), Pay and details. Use "• " bullets. Put the most searched skills and terms naturally in the text; do not keyword-stuff.
- Meta description: max 155 characters, for search results.
- Keywords: 8 to 12 search terms candidates would use.

Reply with ONLY a JSON object, no other text: {"title": string, "description": string, "meta_description": string, "keywords": string[]}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5",
      max_tokens: 3000,
      system,
      messages: [{ role: "user", content: facts }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: "AI request failed: " + (data?.error?.message || r.statusText) }, 502);

  const text = (data.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const out = JSON.parse(m ? m[0] : text);
    return json({
      title: clip(out.title, 120),
      description: clip(out.description, 15000),
      meta_description: clip(out.meta_description, 200),
      keywords: Array.isArray(out.keywords) ? out.keywords.slice(0, 15).map((k: unknown) => clip(k, 60)) : [],
    });
  } catch {
    return json({ error: "AI returned an unexpected format. Try again." }, 502);
  }
});
