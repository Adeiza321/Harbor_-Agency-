-- 1. "Open to new roles" on the candidate page. Off = we don't put them forward (client pitches,
--    bench matches) for a year from when it went off, unless they turn it back on. It goes off by
--    itself when they're placed (status Placed or Hired).
-- 2. Their saved job information isn't shown on their page any more. "Edit my information" emails a
--    6-digit code to the address we already have (candidate-otp function); the code opens a
--    30-minute edit session, needed to read or change saved answers.
alter table public.candidates
  add column if not exists open_to_roles boolean not null default true,
  add column if not exists open_paused_until timestamptz,
  add column if not exists open_changed_at timestamptz,
  add column if not exists edit_otp_hash text,
  add column if not exists edit_otp_expires_at timestamptz,
  add column if not exists edit_otp_tries int not null default 0,
  add column if not exists edit_otp_sent_at timestamptz,
  add column if not exists edit_session text,
  add column if not exists edit_session_expires_at timestamptz;

-- Open, counting a pause that has run its year as open again.
create or replace function public.candidate_is_open(c public.candidates) returns boolean language sql stable as $$
  select c.open_to_roles or (c.open_paused_until is not null and c.open_paused_until < now())
$$;

create or replace function public.candidates_auto_close() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('Placed', 'Hired') and old.status is distinct from new.status and new.open_to_roles then
    new.open_to_roles := false; new.open_paused_until := now() + interval '1 year'; new.open_changed_at := now();
    insert into candidate_timeline (candidate_id, title, done) values (new.id, 'Not open to new roles for a year (started a new job)', true);
  end if;
  return new;
end $$;
drop trigger if exists candidates_auto_close on public.candidates;
create trigger candidates_auto_close before update of status on public.candidates for each row execute function public.candidates_auto_close();

create or replace function public.candidate_set_open(p_token text, p_open boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  update candidates set open_to_roles = coalesce(p_open, true), open_changed_at = now(),
      open_paused_until = case when coalesce(p_open, true) then null else now() + interval '1 year' end
    where portal_token = p_token returning id into cid;
  if cid is null then raise exception 'Invalid link'; end if;
  insert into candidate_timeline (candidate_id, title, done) values (cid, case when coalesce(p_open, true) then 'Turned on: open to new roles' else 'Turned off: not open to new roles for a year' end, true);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.candidate_set_open(text, boolean) from public;
grant execute on function public.candidate_set_open(text, boolean) to anon, authenticated;

-- What the candidate page knows, without the saved answers themselves (those need the code).
create or replace function public.candidate_preferences(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c record; em text;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  select * into c from candidates where portal_token = p_token;
  if c.id is null then raise exception 'Invalid link'; end if;
  em := coalesce(c.email, '');
  return jsonb_build_object('preferences', null, 'hasPreferences', c.preferences is not null, 'savedAt', c.preferences_at,
    'pitchConsent', coalesce(c.pitch_consent, false), 'location', case when c.preferences is null then c.location end,
    'prefill', case when c.preferences is null then c.prefs_prefill end,
    'open', c.open_to_roles or (c.open_paused_until is not null and c.open_paused_until < now()), 'pausedUntil', c.open_paused_until,
    'emailMasked', case when position('@' in em) > 1 then left(em, 1) || '•••' || substr(em, position('@' in em)) else '' end);
end $$;
revoke all on function public.candidate_preferences(text) from public;
grant execute on function public.candidate_preferences(text) to anon, authenticated;

create or replace function public.candidate_edit_ok(p_token text, p_session text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from candidates where portal_token = p_token and length(coalesce(p_session, '')) >= 32
    and edit_session = p_session and edit_session_expires_at > now())
$$;
revoke all on function public.candidate_edit_ok(text, text) from public, anon, authenticated;

-- Their saved answers, with a valid edit session (from the emailed code).
create or replace function public.candidate_preferences_edit(p_token text, p_session text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c record;
begin
  if not public.candidate_edit_ok(p_token, p_session) then raise exception 'Your code has expired. Ask for a new one.'; end if;
  select name, preferences, preferences_at, location into c from candidates where portal_token = p_token;
  return jsonb_build_object('preferences', c.preferences, 'savedAt', c.preferences_at, 'location', c.location, 'name', c.name);
end $$;
revoke all on function public.candidate_preferences_edit(text, text) from public;
grant execute on function public.candidate_preferences_edit(text, text) to anon, authenticated;

-- Saving answers: the first time, the candidate page link is enough; changing saved answers needs
-- the edit session too.
drop function if exists public.candidate_set_preferences(text, jsonb);
create or replace function public.candidate_set_preferences(p_token text, p_prefs jsonb, p_session text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cand_id uuid; had boolean; p jsonb := coalesce(p_prefs, '{}'::jsonb); sal jsonb; pay_text text;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  select id, preferences is not null into cand_id, had from candidates where portal_token = p_token;
  if cand_id is null then raise exception 'Invalid link'; end if;
  if had and not public.candidate_edit_ok(p_token, p_session) then raise exception 'Your code has expired. Ask for a new one to save changes.'; end if;
  if jsonb_typeof(p) <> 'object' or length(p::text) > 20000 then raise exception 'Those answers could not be saved'; end if;
  if jsonb_array_length(coalesce(p->'roles', '[]')) = 0 or coalesce(p->>'seniority', '') = ''
     or jsonb_array_length(coalesce(p->'employmentTypes', '[]')) = 0
     or coalesce((p->'salary'->>'min')::numeric, 0) <= 0 or coalesce(p->'salary'->>'currency', '') = ''
     or coalesce(p->>'currentCountry', '') = '' or coalesce(p->>'currentCity', '') = ''
     or coalesce(p->>'relocate', '') = ''
     or jsonb_array_length(coalesce(p->'workSetup', '[]')) = 0 or jsonb_typeof(p->'citizen') <> 'boolean'
     or ((p->>'citizen')::boolean = false and (coalesce(p->>'visaType', '') = '' or coalesce(p->>'sponsorship', '') = ''))
     or jsonb_array_length(coalesce(p->'languages', '[]')) = 0 or coalesce(p->>'availability', '') = ''
     or jsonb_array_length(coalesce(p->'industries', '[]')) = 0
  then raise exception 'Please answer every question'; end if;
  sal := p->'salary';
  pay_text := (sal->>'currency') || ' ' || to_char((sal->>'min')::numeric, 'FM999,999,999')
    || case when coalesce((sal->>'max')::numeric, 0) > (sal->>'min')::numeric then ' – ' || to_char((sal->>'max')::numeric, 'FM999,999,999') else '' end
    || ' per ' || coalesce(nullif(sal->>'period', ''), 'year');
  update candidates set preferences = p || jsonb_build_object('v', 1), preferences_at = now(),
      pay = pay_text, notice = p->>'availability', location = (p->>'currentCity') || ', ' || (p->>'currentCountry')
    where id = cand_id;
  insert into candidate_timeline (candidate_id, title, done) values (cand_id, 'Updated their job preferences', true);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.candidate_set_preferences(text, jsonb, text) from public;
grant execute on function public.candidate_set_preferences(text, jsonb, text) to anon, authenticated;
