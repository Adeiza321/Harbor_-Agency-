-- Preferred work setup (remote / hybrid / onsite, any they'd accept) on every candidate.
--   candidates.work_setup    the one place screening and outreach read it. Kept in step with
--                            preferences.workSetup (the "Help us match you" form) both ways.
--   applications.work_setup  asked on the job apply form and on a referral's "I'm interested";
--                            copied to the candidate when the application becomes one (Inbox
--                            assign, a recruiter's own link, the Active file).
-- Recruiters set it on the candidate card (Edit details) and on Add candidate.

alter table public.candidates add column if not exists work_setup text[];
alter table public.applications add column if not exists work_setup text[];

-- Only the three known values, each once, in a fixed order; empty becomes null.
create or replace function public.clean_work_setup(v text[]) returns text[]
language sql immutable as $$
  select nullif(array(select x from unnest(array['remote', 'hybrid', 'onsite']) x where x = any(coalesce(v, '{}'))), '{}')
$$;
create or replace function public.work_setup_of(p jsonb) returns text[]
language sql immutable as $$
  select public.clean_work_setup(array(select lower(replace(replace(x, '-', ''), ' ', '')) from jsonb_array_elements_text(case when jsonb_typeof(p -> 'workSetup') = 'array' then p -> 'workSetup' else '[]'::jsonb end) x))
$$;

-- Candidates: the preferences form and the column stay the same. A new preferences.workSetup wins
-- (they just told us); otherwise a set column is written into preferences that already exist.
create or replace function public.candidates_work_setup_sync() returns trigger
language plpgsql set search_path = public as $$
declare from_prefs text[] := public.work_setup_of(new.preferences);
begin
  new.work_setup := public.clean_work_setup(new.work_setup);
  if tg_op = 'INSERT' then
    new.work_setup := coalesce(from_prefs, new.work_setup);
  elsif from_prefs is distinct from public.work_setup_of(old.preferences) and from_prefs is not null then
    new.work_setup := from_prefs;
  elsif new.work_setup is distinct from old.work_setup and new.preferences is not null and jsonb_typeof(new.preferences) = 'object' then
    new.preferences := new.preferences || jsonb_build_object('workSetup', to_jsonb(coalesce(new.work_setup, '{}')));
  end if;
  return new;
end $$;
drop trigger if exists candidates_work_setup_sync on public.candidates;
create trigger candidates_work_setup_sync before insert or update of work_setup, preferences on public.candidates
  for each row execute function public.candidates_work_setup_sync();

-- Applications: what they told us goes to their candidate once there is one (and again if they
-- change it), without overwriting a newer answer from the candidate page.
create or replace function public.applications_work_setup_to_candidate() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws text[] := coalesce(public.clean_work_setup(new.work_setup), public.work_setup_of(new.preferences));
begin
  if new.candidate_id is null or ws is null then return new; end if;
  if tg_op = 'UPDATE' and new.candidate_id is not distinct from old.candidate_id
     and coalesce(public.clean_work_setup(new.work_setup), public.work_setup_of(new.preferences)) is not distinct from coalesce(public.clean_work_setup(old.work_setup), public.work_setup_of(old.preferences)) then
    return new;
  end if;
  update candidates set work_setup = ws where id = new.candidate_id and work_setup is distinct from ws;
  return new;
end $$;
drop trigger if exists applications_work_setup_to_candidate on public.applications;
create trigger applications_work_setup_to_candidate after insert or update of candidate_id, work_setup, preferences on public.applications
  for each row execute function public.applications_work_setup_to_candidate();

-- A referred person confirms how they'd work, on the job page after "I'm interested".
create or replace function public.referral_work_setup(p_token text, p_setup text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; ws text[] := public.clean_work_setup(p_setup);
begin
  if p_token is null or length(p_token) < 16 then raise exception 'Invalid link'; end if;
  if ws is null then raise exception 'Choose at least one'; end if;
  select id, interest_at into a from applications where referral_token = p_token;
  if not found then raise exception 'Invalid link'; end if;
  update applications set work_setup = ws, interest_at = coalesce(interest_at, now()) where id = a.id;
  return jsonb_build_object('ok', true, 'workSetup', to_jsonb(ws));
end $$;
revoke all on function public.referral_work_setup(text, text[]) from public;
grant execute on function public.referral_work_setup(text, text[]) to anon, authenticated;

-- The referral greeting also says whether we already know their work setup.
create or replace function public.referral_interest(p_token text, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare a record;
begin
  if p_token is null or length(p_token) < 16 then return null; end if;
  select id, name, email, referrer, interest_at, status, work_setup into a from applications where referral_token = p_token;
  if not found then return null; end if;
  if p_confirm and a.interest_at is null and a.status = 'new' then
    update applications set interest_at = now() where id = a.id;
    a.interest_at := now();
  end if;
  return jsonb_build_object('name', a.name, 'email', a.email, 'referrer', a.referrer->>'name', 'interested', a.interest_at is not null,
    'workSetup', coalesce(to_jsonb(a.work_setup), '[]'::jsonb));
end $fn$;
grant execute on function public.referral_interest(text, boolean) to anon, authenticated;

-- Existing candidates who already told us on the preferences form.
update public.candidates set work_setup = public.work_setup_of(preferences)
 where work_setup is null and public.work_setup_of(preferences) is not null;
