-- Job preferences: when a candidate agrees to be kept on file and recommended for roles, they
-- fill in what they're looking for (all required), on their candidate page. Matching, client
-- leads and screening read it; recruiters see and can correct it. Visa details are staff-only:
-- nothing client-facing selects this column.
--
-- candidates.preferences = {
--   roles[], seniority, employmentTypes[], salary { min, max, currency, period },
--   currentCity, currentCountry, preferredLocations[], relocate,
--   workSetup[] (remote | hybrid | onsite),
--   citizen (citizen or permanent resident where they live), visaType, visaExpiry ("" = no expiry),
--   sponsorship (yes | no | unsure), rightToWork [{ country, status: yes | no | sponsorship }],
--   languages [{ language, level }], availability, industries[] (industry experience)
-- }

alter table public.candidates
  add column if not exists preferences jsonb,
  add column if not exists preferences_at timestamptz,
  add column if not exists preferences_invited_at timestamptz;

-- What the candidate page needs to show (and prefill) the form.
create or replace function public.candidate_preferences(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c record;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  select id, name, location, pay, notice, industries, preferences, preferences_at, pitch_consent into c
    from candidates where portal_token = p_token;
  if c.id is null then raise exception 'Invalid link'; end if;
  return jsonb_build_object('preferences', c.preferences, 'savedAt', c.preferences_at, 'pitchConsent', coalesce(c.pitch_consent, false),
    'location', c.location, 'pay', c.pay, 'notice', c.notice);
end $$;

-- Save them. Everything is required; the page checks each answer, and this checks the essentials
-- so a half-filled form can't be saved by calling it directly. The salary, notice and location the
-- AI and matching already read are updated from the answers.
create or replace function public.candidate_set_preferences(p_token text, p_prefs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cand_id uuid; p jsonb := coalesce(p_prefs, '{}'::jsonb); sal jsonb; pay_text text;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  if jsonb_typeof(p) <> 'object' or length(p::text) > 20000 then raise exception 'Those answers could not be saved'; end if;
  if jsonb_array_length(coalesce(p->'roles', '[]')) = 0 or coalesce(p->>'seniority', '') = ''
     or jsonb_array_length(coalesce(p->'employmentTypes', '[]')) = 0
     or coalesce((p->'salary'->>'min')::numeric, 0) <= 0 or coalesce(p->'salary'->>'currency', '') = ''
     or coalesce(p->>'currentCountry', '') = '' or coalesce(p->>'currentCity', '') = ''
     or jsonb_array_length(coalesce(p->'preferredLocations', '[]')) = 0 or coalesce(p->>'relocate', '') = ''
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
    where portal_token = p_token returning id into cand_id;
  if cand_id is null then raise exception 'Invalid link'; end if;
  insert into candidate_timeline (candidate_id, title, done) values (cand_id, 'Updated their job preferences', true);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.candidate_preferences(text) from public;
revoke all on function public.candidate_set_preferences(text, jsonb) from public;
grant execute on function public.candidate_preferences(text) to anon, authenticated;
grant execute on function public.candidate_set_preferences(text, jsonb) to anon, authenticated;
