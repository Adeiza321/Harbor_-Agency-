-- The candidate's pitch page shows the job-description check (what the employer asks for and how
-- they match it, from their CV) next to how the role matches what they're looking for (23 Oct 2026).
create or replace function public.candidate_pitch(p_token text, p_offer text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := portal_candidate_id(p_token); o record; c record;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid
    and status in ('notified', 'reminded', 'no_email', 'acknowledged', 'ready', 'pitched', 'withdrawn', 'removed');
  if not found then return null; end if;
  select open_to_roles, open_paused_until into c from candidates where id = cid;
  return jsonb_build_object('offer', o.token, 'status', o.status, 'role', offer_role_anon(o.lead_id),
    'fit', o.fit, 'verdict', o.verdict, 'requirements', coalesce(o.requirements, '[]'::jsonb),
    'jdCheck', coalesce(o.jd_check, '[]'::jsonb),
    'questions', coalesce(o.questions, '[]'::jsonb), 'answers', o.answers, 'whyRole', o.why_role,
    'acknowledgedAt', o.acknowledged_at, 'withdrawnBy', o.withdrawn_by, 'otherRoles', o.other_roles,
    'open', coalesce(c.open_to_roles, true),
    'facts', (select coalesce(data -> 'role', '{}'::jsonb) from leads where id = o.lead_id));
end $$;
revoke all on function public.candidate_pitch(text, text) from public;
grant execute on function public.candidate_pitch(text, text) to anon, authenticated;
