-- "Withdraw my profile" asks why, with quick options (one tap) and an optional note. The reason is
-- saved on the offer, shown on the lead card (note) and sent to their recruiter in the pitch chat.
alter table public.lead_offers
  add column if not exists withdraw_reason text,
  add column if not exists withdraw_note text;

create or replace function public.candidate_pitch_withdraw(p_token text, p_offer text, p_reason text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := portal_candidate_id(p_token); o record; l record;
  r text := nullif(left(btrim(coalesce(p_reason, '')), 120), ''); n text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid;
  if not found then raise exception 'This role is no longer available'; end if;
  if o.status in ('withdrawn', 'removed') then return jsonb_build_object('ok', true); end if;
  update lead_offers set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'candidate', responded_at = coalesce(responded_at, now()),
      withdraw_reason = r, withdraw_note = n, note = case when r is not null then 'Reason: ' || r || coalesce(' (' || left(n, 120) || ')', '') else note end
    where id = o.id;
  if o.candidate_job_id is not null then
    update candidate_jobs set stage = 'Withdrawn' where id = o.candidate_job_id and stage not in ('Withdrawn', 'Rejected', 'Placed');
  end if;
  select job_title into l from leads where id = o.lead_id;
  insert into candidate_timeline (candidate_id, title, done)
    values (cid, 'Withdrew their profile from ' || coalesce(l.job_title, 'a role') || coalesce(' (' || r || ')', ''), true);
  perform pitch_chat(o.id, 'I''d like to withdraw my profile from ' || coalesce(l.job_title, 'this role') || '.'
    || coalesce(' Reason: ' || r || '.', '') || coalesce(' ' || n, ''));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.candidate_pitch_withdraw(text, text, text, text) from public;
grant execute on function public.candidate_pitch_withdraw(text, text, text, text) to anon, authenticated;

-- The old two-argument call (no reason) still works.
create or replace function public.candidate_pitch_withdraw(p_token text, p_offer text) returns jsonb
language sql security definer set search_path = public as $$
  select public.candidate_pitch_withdraw(p_token, p_offer, null, null)
$$;
revoke all on function public.candidate_pitch_withdraw(text, text) from public;
grant execute on function public.candidate_pitch_withdraw(text, text) to anon, authenticated;
