// Closing a role stops every email for it (database trigger archive_job_prospects: emails still
// waiting are cancelled and everyone sourced for it moves to the talent pool), and takes everyone
// already emailed through Apollo out of Pronext's Apollo sequences so no follow-ups go out.
// The trigger asks Apollo straight away but can't tell whether Apollo did it; this sweep (every
// 10 minutes) makes sure: each person on a closed role who was emailed through Apollo is stopped
// in Apollo and marked (data.apollo_stop), and anyone Apollo couldn't be reached for is tried again.
import { apolloKey, apolloSequenceIds, stopInSequences } from "./apollo.ts";

export async function stopClosedRoleSequences(admin: any, max = 300) {
  if (!apolloKey() || !apolloSequenceIds().length) return { stopped: 0, skipped: "Apollo not connected" };
  const { data: jobs } = await admin.from("jobs").select("id").eq("status", "Closed");
  const jobIds = (jobs || []).map((j: any) => j.id);
  if (!jobIds.length) return { stopped: 0 };
  const { data: ps } = await admin.from("prospects").select("id,data").in("job_id", jobIds).is("data->>apollo_stop", null).limit(max);
  if (!ps?.length) return { stopped: 0 };
  const { data: msgs } = await admin.from("outreach_messages").select("prospect_id,provider_ref")
    .eq("provider", "apollo").eq("status", "sent").in("prospect_id", ps.map((p: any) => p.id)).not("provider_ref", "is", null);
  const refs = new Map<string, string[]>();
  for (const m of msgs || []) if (m.provider_ref) refs.set(m.prospect_id, [...(refs.get(m.prospect_id) || []), String(m.provider_ref)]);
  const now = new Date().toISOString();
  let stopped = 0, failed = 0;
  // Never emailed through Apollo: nothing to stop there.
  for (const p of ps.filter((p: any) => !refs.has(p.id))) await admin.from("prospects").update({ data: { ...(p.data || {}), apollo_stop: { at: now, none: true } } }).eq("id", p.id);
  const todo = ps.filter((p: any) => refs.has(p.id));
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    try {
      await stopInSequences(chunk.flatMap((p: any) => refs.get(p.id) || []));
      for (const p of chunk) await admin.from("prospects").update({ data: { ...(p.data || {}), apollo_stop: { at: now, contacts: (refs.get(p.id) || []).length } } }).eq("id", p.id);
      stopped += chunk.length;
    } catch (e) {
      failed += chunk.length;
      console.error("apollo stop (closed roles)", String((e as Error)?.message || e).slice(0, 200));
    }
  }
  return { stopped, failed };
}
