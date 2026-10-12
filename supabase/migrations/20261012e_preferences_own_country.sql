-- Job preferences, round 2: we only hire candidates in the country they live in, so the form no
-- longer asks where else they'd work or about right to work elsewhere. "Preferred cities" (in their
-- own country) is optional; relocation means within that country. The rest is unchanged.
--   preferences.preferredCities[]  optional cities in their own country
--   preferences.relocate           yes | maybe | no, within their own country
-- (older answers may still carry preferredLocations / rightToWork; they're simply shown as they are)

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
    where portal_token = p_token returning id into cand_id;
  if cand_id is null then raise exception 'Invalid link'; end if;
  insert into candidate_timeline (candidate_id, title, done) values (cand_id, 'Updated their job preferences', true);
  return jsonb_build_object('ok', true);
end $$;
