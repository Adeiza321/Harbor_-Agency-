-- "Not active" candidates ("Open to new roles" off) stay off until THEY turn it back on: a pause
-- that has run its year no longer counts as open by itself. Instead, a year on, we email them to
-- ask (sourcing tick): actively looking / open to the right role (both turn it back on) / not
-- right now (stays off; we ask again in another year). The question is also on their page.
--   candidates.open_checkin_at  when we last emailed that question
--   candidates.looking          their answer: active | open | not_now
--   candidates.looking_at       when they answered
alter table public.candidates
  add column if not exists open_checkin_at timestamptz,
  add column if not exists looking text,
  add column if not exists looking_at timestamptz;

-- Open only when it's on.
create or replace function public.candidate_is_open(c public.candidates) returns boolean language sql stable as $$
  select coalesce(c.open_to_roles, true)
$$;

-- The candidate page: the same (and it says when the year is up, so the page can ask).
do $$
declare d text;
begin
  d := pg_get_functiondef('public.candidate_preferences(text)'::regprocedure);
  d := replace(d, '''open'', c.open_to_roles or (c.open_paused_until is not null and c.open_paused_until < now())',
                  '''open'', coalesce(c.open_to_roles, true), ''checkinDue'', (not coalesce(c.open_to_roles, true) and c.open_paused_until is not null and c.open_paused_until <= now())');
  if d not like '%checkinDue%' then raise exception 'candidate_preferences: open expression not found'; end if;
  execute d;
end $$;

-- Their answer, from the email or their page.
create or replace function public.candidate_open_answer(p_token text, p_answer text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid; a text := lower(btrim(coalesce(p_answer, '')));
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  if a not in ('active', 'open', 'not_now') then raise exception 'Choose an answer'; end if;
  select id into cid from candidates where portal_token = p_token;
  if cid is null then raise exception 'Invalid link'; end if;
  if a in ('active', 'open') then
    update candidates set open_to_roles = true, open_paused_until = null, open_changed_at = now(), looking = a, looking_at = now() where id = cid;
    insert into candidate_timeline (candidate_id, title, done)
      values (cid, case a when 'active' then 'Turned on: actively looking for a new role' else 'Turned on: open to the right role' end, true);
  else
    update candidates set open_to_roles = false, open_paused_until = now() + interval '1 year', open_changed_at = now(), looking = a, looking_at = now() where id = cid;
    insert into candidate_timeline (candidate_id, title, done) values (cid, 'Not looking right now: we''ll check in again in a year', true);
  end if;
  return jsonb_build_object('ok', true, 'open', a <> 'not_now');
end $$;
revoke all on function public.candidate_open_answer(text, text) from public;
grant execute on function public.candidate_open_answer(text, text) to anon, authenticated;
