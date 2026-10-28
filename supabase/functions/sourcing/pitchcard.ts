// The role card on the candidate's profile for a pitched role (a client-lead role) IS the pitch
// screening: its fit, verdict and requirement checklist come from the employer's job description,
// read against their CV, with their pitch answers counted. Outreach checks that they tick the
// must-haves, not how much evidence the CV gives. The automatic AI screening never runs on these
// cards: any re-screen (profile edit, answers, the Screen button) rebuilds the card from the pitch.
// No imports, so ai-screen can use it too.
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const CARD_VERDICT: Record<string, string> = { "Perfect fit": "Perfect fit", "Good fit": "Good fit", "Not a fit": "Reject" };
export function pitchCard(o: any) {
  const checks: any[] = Array.isArray(o?.jd_check) ? o.jd_check : [];
  const requirements = checks.slice(0, 25).map((c: any) => ({
    requirement: clip(c?.item, 160), type: c?.required !== false && !c?.info ? "must" : "preferred",
    status: ["met", "confirmed"].includes(c?.status) ? "met" : c?.status === "not_met" ? "not met" : "partial",
    evidence: clip(c?.evidence || (c?.status === "not_shown" ? "Not on their CV: asked in the pitch email" : ""), 240),
  })).filter((r: any) => r.requirement);
  const toConfirm = checks.filter((c: any) => c?.required !== false && !c?.info && c?.status === "not_shown").map((c: any) => "To confirm: " + clip(c.item, 140));
  const notMet = checks.filter((c: any) => c?.required !== false && !c?.info && c?.status === "not_met").map((c: any) => clip(c.item, 160));
  return {
    stage: "first", source: "pitch",
    summary: clip([o?.reason, toConfirm.length ? `Screened against the employer's job description; ${toConfirm.length === 1 ? "one requirement is" : toConfirm.length + " requirements are"} asked in the pitch email.` : "Screened against the employer's job description."].filter(Boolean).join(" "), 1200),
    strengths: (Array.isArray(o?.bullets) ? o.bullets : []).slice(0, 6).map((b: unknown) => clip(b, 160)),
    gaps: [...notMet, ...toConfirm].slice(0, 6),
    score: o?.fit ?? 0, verdict: CARD_VERDICT[o?.verdict] || "Possible fit", verdict_reason: clip(o?.reason, 400),
    requirements, usedResume: true, answersUsed: 0, updatedAt: new Date().toISOString(), followups: null,
  };
}
// The pitch email's questions, saved on the card as Q&A pairs (answers filled in when they reply).
export const pitchPairs = (o: any) => (Array.isArray(o?.questions) ? o.questions : [])
  .map((q: any, i: number) => ({ q: clip(typeof q === "string" ? q : q?.q, 300), a: String((Array.isArray(o?.answers) ? o.answers[i] : "") || "") })).filter((x: any) => x.q);

