// Morning brief and end-of-day round-up, built straight from the data (no AI): what changed, what's
// closest to a hire, what's waiting on someone, and the top 3 things to do, each offered as a
// reminder to approve (the same cards the assistant used to propose). Recruiters see only their own
// candidates and the roles they're engaged on; Admin and Rec Ops see everything.

type Me = { id: string; full_name: string; role: string; scoped: boolean };
const RANK: Record<string, number> = { Offer: 4, Interview: 3, Submitted: 2, Screening: 1, "In review": 1, Sourced: 0 };
const DAY = 864e5;
const first = (n: string) => String(n || "").split(" ")[0] || "there";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function buildDigest(admin: any, me: Me, kind: "brief" | "roundup", tz: string) {
  const now = Date.now();
  const since = new Date(now - (kind === "brief" ? 24 : 12) * 3600e3).toISOString();
  const ymd = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  const today = ymd(now), tomorrow = ymd(now + DAY);
  const due = kind === "brief" ? today : tomorrow;
  const hhmm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  // What this person can see.
  let cq = admin.from("candidates").select("id,name,created_at,recruiter_id").eq("is_draft", false);
  if (me.scoped) cq = cq.eq("recruiter_id", me.id);
  const { data: cands } = await cq;
  const cById = new Map((cands || []).map((c: any) => [c.id, c]));
  const cIds = [...cById.keys()];
  const { data: jobsAll } = await admin.from("jobs").select("id,role_title,client,status,created_at");
  let myJobIds: Set<string> | null = null;
  if (me.scoped) { const { data: jr } = await admin.from("job_recruiters").select("job_id").eq("recruiter_id", me.id); myJobIds = new Set((jr || []).map((r: any) => r.job_id)); }
  const jobs = (jobsAll || []).filter((j: any) => !myJobIds || myJobIds.has(j.id));
  const jById = new Map((jobsAll || []).map((j: any) => [j.id, j]));
  const roleOf = (id: string) => { const j: any = jById.get(id); return j ? j.role_title + (j.client ? " (" + j.client + ")" : "") : "a role"; };

  const inC = (q: any, col = "candidate_id") => (cIds.length ? q.in(col, cIds.slice(0, 900)) : q.eq(col, "00000000-0000-0000-0000-000000000000"));
  const [{ data: links }, { data: tl }, { data: ivs }, { data: tasks }] = await Promise.all([
    inC(admin.from("candidate_jobs").select("id,candidate_id,job_id,stage,candidate_response,submitted_at,updated_at,created_at")),
    inC(admin.from("candidate_timeline").select("candidate_id,title,created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(200)),
    admin.from("interviews").select("id,candidate_id,job_id,round,starts_at,status,recruiter_id,candidate_confirmed_at").eq("status", "scheduled")
      .gte("starts_at", new Date(now - 2 * 3600e3).toISOString()).lte("starts_at", new Date(now + 2 * DAY).toISOString()).order("starts_at"),
    admin.from("tasks").select("id,title,due_on,status").eq("assigned_to", me.id).neq("status", "done").order("due_on", { ascending: true, nullsFirst: false }).limit(50),
  ]);
  const linkIds = (links || []).map((l: any) => l.id);
  const { data: replies } = linkIds.length
    ? await admin.from("candidate_job_messages").select("link_id,created_at,recruiter_read_at").in("link_id", linkIds.slice(0, 900)).eq("sender", "candidate").is("deleted_at", null).gte("created_at", since)
    : { data: [] };
  const linkById = new Map((links || []).map((l: any) => [l.id, l]));

  const live = (links || []).filter((l: any) => !["Rejected", "Withdrawn", "Placed"].includes(l.stage) && l.candidate_response !== "declined");
  const newCands = (cands || []).filter((c: any) => c.created_at >= since);
  const moves = (tl || []).filter((t: any) => /moved|status|rejected|routed|accepted|declined|interview|offer|placed|submitted/i.test(t.title));
  const unread = (replies || []).filter((m: any) => !m.recruiter_read_at);
  const myIvs = (ivs || []).filter((i: any) => cById.has(i.candidate_id) || (!me.scoped));
  const ivDay = myIvs.filter((i: any) => ymd(new Date(i.starts_at).getTime()) === (kind === "brief" ? today : tomorrow));
  const unconfirmed = ivDay.filter((i: any) => !i.candidate_confirmed_at);
  const waiting = live.filter((l: any) => l.stage === "Submitted" && l.submitted_at && now - new Date(l.submitted_at).getTime() > 3 * DAY);
  const overdue = (tasks || []).filter((t: any) => t.due_on && t.due_on <= today);

  // Roles closest to a hire: best stage on each open role.
  const best = new Map<string, any>();
  for (const l of live) { const j: any = jById.get(l.job_id); if (!j || j.status !== "Open") continue; const b = best.get(l.job_id); if (!b || (RANK[l.stage] ?? 0) > (RANK[b.stage] ?? 0)) best.set(l.job_id, l); }
  const closest = [...best.values()].filter((l) => (RANK[l.stage] ?? 0) >= 2).sort((a, b) => (RANK[b.stage] ?? 0) - (RANK[a.stage] ?? 0)).slice(0, 3);
  // Open roles where nothing has moved for a week.
  const lastMove = new Map<string, number>();
  for (const l of links || []) { const t = Math.max(new Date(l.updated_at || l.created_at).getTime(), new Date(l.created_at).getTime()); lastMove.set(l.job_id, Math.max(lastMove.get(l.job_id) || 0, t)); }
  const stuck = jobs.filter((j: any) => j.status === "Open" && now - new Date(j.created_at).getTime() > 7 * DAY && now - (lastMove.get(j.id) || new Date(j.created_at).getTime()) > 7 * DAY).slice(0, 3);

  // Top 3 things, most urgent first.
  const todo: { title: string; candidate_id?: string; job_id?: string }[] = [];
  const push = (x: any) => { if (todo.length < 3 && !todo.some((t) => t.title === x.title)) todo.push(x); };
  const repliedLinks = [...new Set(unread.map((m: any) => m.link_id))];
  for (const id of repliedLinks) { const l: any = linkById.get(id); const c: any = l && cById.get(l.candidate_id); if (c) push({ title: `Reply to ${c.name} about ${roleOf(l.job_id)}`, candidate_id: c.id, job_id: l.job_id }); }
  for (const i of unconfirmed) { const c: any = cById.get(i.candidate_id); if (c) push({ title: `Confirm ${c.name}'s ${i.round || "interview"} at ${hhmm(i.starts_at)}`, candidate_id: c.id, job_id: i.job_id }); }
  for (const l of live.filter((x: any) => x.stage === "Offer")) { const c: any = cById.get(l.candidate_id); if (c) push({ title: `Push ${c.name}'s offer on ${roleOf(l.job_id)} to a decision`, candidate_id: c.id, job_id: l.job_id }); }
  for (const l of waiting) { const c: any = cById.get(l.candidate_id); if (c) push({ title: `Chase the client for feedback on ${c.name} (${roleOf(l.job_id)})`, candidate_id: c.id, job_id: l.job_id }); }
  for (const j of stuck) push({ title: `Restart sourcing on ${j.role_title}${j.client ? " (" + j.client + ")" : ""}`, job_id: j.id });
  for (const t of overdue) push({ title: t.title });

  // The message.
  const lines: string[] = [];
  lines.push(kind === "brief" ? `Good morning ${first(me.full_name)}. Here's where things stand.` : `Here's your day, ${first(me.full_name)}.`);
  const changed = [
    newCands.length ? plural(newCands.length, "new candidate") : "",
    moves.length ? plural(moves.length, "update") + " on candidates" : "",
    unread.length ? plural(repliedLinks.length, "candidate") + " replied" : "",
  ].filter(Boolean);
  lines.push("", `**${kind === "brief" ? "Since yesterday" : "Today"}:** ` + (changed.length ? changed.join(", ") + "." : "nothing new came in."));
  if (moves.length) for (const t of moves.slice(0, 4)) { const c: any = cById.get(t.candidate_id); lines.push(`- ${c ? c.name + ": " : ""}${t.title}`); }
  if (ivDay.length) {
    lines.push("", `**Interviews ${kind === "brief" ? "today" : "tomorrow"}:**`);
    for (const i of ivDay.slice(0, 5)) { const c: any = cById.get(i.candidate_id); lines.push(`- ${hhmm(i.starts_at)} ${c ? c.name : "Candidate"}, ${i.round || "interview"} for ${roleOf(i.job_id)}${i.candidate_confirmed_at ? "" : " (not confirmed yet)"}`); }
  }
  if (closest.length) {
    lines.push("", "**Closest to a hire:**");
    for (const l of closest) { const c: any = cById.get(l.candidate_id); lines.push(`- ${roleOf(l.job_id)}: ${c ? c.name : "a candidate"} at ${l.stage}`); }
  }
  const wait = [
    waiting.length ? plural(waiting.length, "candidate") + " waiting on client feedback for over 3 days" : "",
    stuck.length ? plural(stuck.length, "open role") + " with nothing moving for a week (" + stuck.map((j: any) => j.role_title).join(", ") + ")" : "",
    overdue.length ? plural(overdue.length, "task") + " due or overdue" : "",
  ].filter(Boolean);
  if (wait.length) lines.push("", "**Waiting:** " + wait.join("; ") + ".");
  if (todo.length) {
    lines.push("", `**${kind === "brief" ? "Top 3 for today" : "First 3 tomorrow"}:**`);
    todo.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
    lines.push("", "Approve the reminders below to add them to your to-do list.");
  } else lines.push("", "Nothing urgent needs you. A good moment to source for your open roles.");

  const proposals = todo.map((t) => ({ tool: "propose_task", input: { title: t.title, due_on: due, ...(t.candidate_id ? { candidate_id: t.candidate_id } : {}), ...(t.job_id ? { job_id: t.job_id } : {}) } }));
  return { text: lines.join("\n"), proposals };
}
