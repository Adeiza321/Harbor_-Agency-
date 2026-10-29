-- Nothing a candidate fills in is lost (29 Oct 2026). The "Help us match you" form (Send us your CV,
-- and the candidate page the first time) now saves the answers so far after each step, as a draft.
-- Finishing the form replaces the draft with the full answers, as before. The candidate's profile
-- shows a draft ("started but didn't finish") and it fills their location, salary, notice and work
-- setup where those are still blank.

alter table public.applications add column if not exists preferences_draft jsonb, add column if not exists preferences_draft_at timestamptz;
alter table public.candidates add column if not exists preferences_draft jsonb, add column if not exists preferences_draft_at timestamptz;

-- Blanks on a candidate filled from (draft) answers. Never over what's there.
create or replace function public.fill_candidate_from_prefs(p_cand uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare sal jsonb := p->'salary'; pay_text text; ws text[];
begin
  if coalesce((sal->>'min')::numeric, 0) > 0 and coalesce(sal->>'currency', '') <> '' then
    pay_text := (sal->>'currency') || ' ' || to_char((sal->>'min')::numeric, 'FM999,999,999')
      || case when coalesce((sal->>'max')::numeric, 0) > (sal->>'min')::numeric then ' – ' || to_char((sal->>'max')::numeric, 'FM999,999,999') else '' end
      || ' per ' || coalesce(nullif(sal->>'period', ''), 'year');
  end if;
  ws := array(select x from jsonb_array_elements_text(coalesce(p->'workSetup', '[]')) x where x in ('remote', 'hybrid', 'onsite'));
  update candidates set
    pay = case when coalesce(nullif(btrim(pay), '-'), '') = '' and pay_text is not null then pay_text else pay end,
    notice = case when coalesce(nullif(btrim(notice), '-'), '') = '' and coalesce(p->>'availability', '') <> '' then p->>'availability' else notice end,
    location = case when coalesce(btrim(location), '') = '' and coalesce(p->>'currentCity', '') <> '' and coalesce(p->>'currentCountry', '') <> '' then (p->>'currentCity') || ', ' || (p->>'currentCountry') else location end,
    work_setup = case when coalesce(cardinality(work_setup), 0) = 0 and cardinality(ws) > 0 then ws else work_setup end
  where id = p_cand;
end $$;
revoke all on function public.fill_candidate_from_prefs(uuid, jsonb) from public, anon, authenticated;

create or replace function public.application_save_progress(p_app uuid, p_token uuid, p_prefs jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select id, candidate_id, created_at, preferences into a from applications where id = p_app and prefs_token = p_token;
  if a.id is null then raise exception 'Invalid link'; end if;
  if a.created_at < now() - interval '2 days' then raise exception 'This link has expired'; end if;
  if a.preferences is not null then return jsonb_build_object('ok', true, 'finished', true); end if;
  if jsonb_typeof(p_prefs) <> 'object' or length(p_prefs::text) > 20000 then raise exception 'Those answers could not be saved'; end if;
  update applications set preferences_draft = p_prefs, preferences_draft_at = now() where id = a.id;
  if a.candidate_id is not null then
    update candidates set preferences_draft = p_prefs, preferences_draft_at = now() where id = a.candidate_id and preferences is null;
    perform fill_candidate_from_prefs(a.candidate_id, p_prefs);
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.application_save_progress(uuid, uuid, jsonb) from public;
grant execute on function public.application_save_progress(uuid, uuid, jsonb) to anon, authenticated;

create or replace function public.candidate_save_progress(p_token text, p_prefs jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cand_id uuid; has_prefs boolean;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  select id, preferences is not null into cand_id, has_prefs from candidates where portal_token = p_token;
  if cand_id is null then raise exception 'Invalid link'; end if;
  -- Only the first time: changing saved answers needs their emailed code, and saves in full.
  if has_prefs then return jsonb_build_object('ok', true, 'finished', true); end if;
  if jsonb_typeof(p_prefs) <> 'object' or length(p_prefs::text) > 20000 then raise exception 'Those answers could not be saved'; end if;
  update candidates set preferences_draft = p_prefs, preferences_draft_at = now() where id = cand_id;
  perform fill_candidate_from_prefs(cand_id, p_prefs);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.candidate_save_progress(text, jsonb) from public;
grant execute on function public.candidate_save_progress(text, jsonb) to anon, authenticated;

-- Finishing clears the draft.
create or replace function public.prefs_clear_draft() returns trigger
language plpgsql as $$
begin
  if new.preferences is not null and new.preferences is distinct from old.preferences then
    new.preferences_draft := null; new.preferences_draft_at := null;
  end if;
  return new;
end $$;
drop trigger if exists candidates_prefs_clear_draft on public.candidates;
create trigger candidates_prefs_clear_draft before update of preferences on public.candidates for each row execute function public.prefs_clear_draft();
drop trigger if exists applications_prefs_clear_draft on public.applications;
create trigger applications_prefs_clear_draft before update of preferences on public.applications for each row execute function public.prefs_clear_draft();
