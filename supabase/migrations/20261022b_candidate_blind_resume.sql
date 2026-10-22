-- One blind resume per candidate, made once and reused for every client link and pitch.
-- Pages live in the private blind-resumes bucket at cand-<candidate id>/<n>.webp. Rec Ops / Admins
-- make them (one at a time or in bulk) and check them; a candidate's own recruiter can make one
-- for their candidate, which then waits for a Rec Ops / Admin check before any pitch uses it.
-- Older blind resumes made for one client link (<link id>/<n>.webp) keep working on that link.
alter table public.candidates
  add column if not exists blind_pages int,
  add column if not exists blind_at timestamptz,
  add column if not exists blind_by uuid,
  add column if not exists blind_checked_at timestamptz,
  add column if not exists blind_checked_by uuid;

create or replace function public.can_manage_link(p_link text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when p_link like 'offer-%' then public.is_staff()
    when p_link like 'cand-%' then public.is_staff() or exists (
      select 1 from public.candidates c
       where c.id::text = substr(p_link, 6) and c.recruiter_id = auth.uid() and public.app_role() is not null)
    else exists (select 1 from public.candidate_jobs cj join public.candidates c on c.id = cj.candidate_id
                  where cj.id::text = p_link and (public.is_staff() or (c.recruiter_id = auth.uid() and public.app_role() is not null))) end
$$;
revoke all on function public.can_manage_link(text) from public, anon;
grant execute on function public.can_manage_link(text) to authenticated;

-- Only Rec Ops / Admins can mark a blind resume as checked.
create or replace function public.guard_blind_check() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.blind_checked_at is distinct from old.blind_checked_at or new.blind_checked_by is distinct from old.blind_checked_by)
     and new.blind_checked_at is not null and not public.is_staff() and auth.uid() is not null then
    raise exception 'Only Rec Ops or an Admin can mark a blind resume as checked';
  end if;
  return new;
end $$;
drop trigger if exists candidates_guard_blind_check on public.candidates;
create trigger candidates_guard_blind_check before update of blind_checked_at, blind_checked_by on public.candidates
  for each row execute function public.guard_blind_check();
