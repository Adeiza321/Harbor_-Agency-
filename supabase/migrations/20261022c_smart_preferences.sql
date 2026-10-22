-- Smart "Help us match you" form. It opens first when a candidate says Yes to being put forward
-- for future roles, and on the "Send us your CV" (Active file) page after they send their CV.
-- Answers we already have (from the CV, the application, earlier screening answers) are shown
-- pre-filled for them to check or change; only what we don't know is asked fresh.
--   candidates.prefs_prefill   the AI's best reading of their answers from everything on file
--                              (cached; ai-screen prefs_prefill), never saved as their answers
--                              until they confirm them in the form
--   applications.preferences   answers given on the Send-us-your-CV page, before the application
--                              becomes a candidate (copied over when it does)
alter table public.candidates add column if not exists prefs_prefill jsonb, add column if not exists prefs_prefill_at timestamptz;
alter table public.applications add column if not exists preferences jsonb, add column if not exists prefs_token uuid default gen_random_uuid();
update public.applications set prefs_token = gen_random_uuid() where prefs_token is null;

create or replace function public.candidate_preferences(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c record;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  select id, name, location, pay, notice, industries, preferences, preferences_at, pitch_consent, prefs_prefill into c
    from candidates where portal_token = p_token;
  if c.id is null then raise exception 'Invalid link'; end if;
  return jsonb_build_object('preferences', c.preferences, 'savedAt', c.preferences_at, 'pitchConsent', coalesce(c.pitch_consent, false),
    'location', c.location, 'pay', c.pay, 'notice', c.notice, 'prefill', c.prefs_prefill);
end $$;
revoke all on function public.candidate_preferences(text) from public;
grant execute on function public.candidate_preferences(text) to anon, authenticated;

-- Answers from the Send-us-your-CV page (no candidate page yet): checked the same way as
-- candidate_set_preferences, kept on the application, and copied to the candidate if the
-- application has already become one (a recruiter's own link assigns it straight away).
create or replace function public.application_set_preferences(p_app uuid, p_token uuid, p_prefs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; p jsonb := coalesce(p_prefs, '{}'::jsonb); sal jsonb; pay_text text;
begin
  select id, candidate_id, created_at into a from applications where id = p_app and prefs_token = p_token;
  if a.id is null then raise exception 'Invalid link'; end if;
  if a.created_at < now() - interval '2 days' then raise exception 'This link has expired'; end if;
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
  update applications set preferences = p || jsonb_build_object('v', 1),
      role_title = left((select string_agg(x, ', ') from jsonb_array_elements_text(p->'roles') x), 200)
    where id = a.id;
  if a.candidate_id is not null then
    sal := p->'salary';
    pay_text := (sal->>'currency') || ' ' || to_char((sal->>'min')::numeric, 'FM999,999,999')
      || case when coalesce((sal->>'max')::numeric, 0) > (sal->>'min')::numeric then ' – ' || to_char((sal->>'max')::numeric, 'FM999,999,999') else '' end
      || ' per ' || coalesce(nullif(sal->>'period', ''), 'year');
    update candidates set preferences = p || jsonb_build_object('v', 1), preferences_at = now(), pay = pay_text, notice = p->>'availability',
        location = (p->>'currentCity') || ', ' || (p->>'currentCountry'), pitch_consent = true, pitch_consent_at = coalesce(pitch_consent_at, now())
      where id = a.candidate_id;
    insert into candidate_timeline (candidate_id, title, done) values (a.candidate_id, 'Answered their job preferences when joining the Active file', true);
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.application_set_preferences(uuid, uuid, jsonb) from public;
grant execute on function public.application_set_preferences(uuid, uuid, jsonb) to anon, authenticated;
