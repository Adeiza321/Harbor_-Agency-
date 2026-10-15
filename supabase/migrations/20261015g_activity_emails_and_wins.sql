-- Activity emails to recruiters (role-emails function) and team wins.
--   Emails when something touches a recruiter's own candidates or work and someone else (or the
--   system) did it: stage changes, a candidate accepting/declining or being put forward, interviews
--   booked/moved/cancelled/decided, tasks given to them, candidates assigned to them, teammates' notes.
--   Placements: a placement_cheers row per placed candidate (the celebration screen and the
--   congratulations on the recruiter's profile), an email to every other recruiter, and
--   placement_kudos for "Congratulate" (which emails the recruiter).

create table if not exists public.placement_cheers (
  id uuid primary key default gen_random_uuid(),
  link_id uuid unique references public.candidate_jobs(id) on delete cascade,
  candidate_id uuid references public.candidates(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  recruiter_id uuid references public.profiles(id) on delete set null,
  placed_by uuid references public.profiles(id) on delete set null,
  role_title text not null default '',
  client text not null default '',
  celebrated_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists placement_cheers_recruiter_idx on public.placement_cheers(recruiter_id);
create index if not exists placement_cheers_candidate_idx on public.placement_cheers(candidate_id);
create index if not exists placement_cheers_job_idx on public.placement_cheers(job_id);
create index if not exists placement_cheers_placed_by_idx on public.placement_cheers(placed_by);
alter table public.placement_cheers enable row level security;
-- The whole team sees wins (role and client, no candidate details); the recruiter marks their celebration seen.
create policy placement_cheers_read on public.placement_cheers for select to authenticated using ((select public.app_role()) is not null);
create policy placement_cheers_seen on public.placement_cheers for update to authenticated using (recruiter_id = (select auth.uid())) with check (recruiter_id = (select auth.uid()));

create table if not exists public.placement_kudos (
  id uuid primary key default gen_random_uuid(),
  cheer_id uuid not null references public.placement_cheers(id) on delete cascade,
  from_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  message text,
  created_at timestamptz not null default now(),
  unique (cheer_id, from_id)
);
create index if not exists placement_kudos_from_idx on public.placement_kudos(from_id);
alter table public.placement_kudos enable row level security;
create policy placement_kudos_read on public.placement_kudos for select to authenticated using ((select public.app_role()) is not null);
create policy placement_kudos_insert on public.placement_kudos for insert to authenticated with check (from_id = (select auth.uid()));
create policy placement_kudos_delete on public.placement_kudos for delete to authenticated using (from_id = (select auth.uid()));

-- candidate_jobs: stage changes (and placements), responses, new links.
create or replace function public.cj_activity_email()
returns trigger language plpgsql security definer set search_path = public as $$
declare c record; j record; cheer uuid;
begin
  if tg_op = 'INSERT' then
    perform public.post_role_email(jsonb_build_object('kind', 'added', 'linkId', new.id, 'actorId', auth.uid()));
    return new;
  end if;
  if new.stage is distinct from old.stage then
    if new.stage = 'Placed' then
      select name, recruiter_id into c from public.candidates where id = new.candidate_id;
      select role_title, client into j from public.jobs where id = new.job_id;
      insert into public.placement_cheers (link_id, candidate_id, job_id, recruiter_id, placed_by, role_title, client)
        values (new.id, new.candidate_id, new.job_id, c.recruiter_id, auth.uid(), coalesce(j.role_title, ''), coalesce(j.client, ''))
        on conflict (link_id) do nothing returning id into cheer;
      if cheer is not null then perform public.post_role_email(jsonb_build_object('kind', 'placed', 'cheerId', cheer)); end if;
    end if;
    perform public.post_role_email(jsonb_build_object('kind', 'stage', 'linkId', new.id, 'from', coalesce(old.stage, ''), 'to', new.stage, 'actorId', auth.uid()));
  end if;
  if new.candidate_response is distinct from old.candidate_response then
    perform public.post_role_email(jsonb_build_object('kind', 'response', 'linkId', new.id, 'actorId', auth.uid()));
  end if;
  return new;
end $$;
revoke all on function public.cj_activity_email() from public, anon, authenticated;
drop trigger if exists candidate_jobs_activity_email on public.candidate_jobs;
create trigger candidate_jobs_activity_email after insert or update of stage, candidate_response on public.candidate_jobs
  for each row execute function public.cj_activity_email();

create or replace function public.iv_activity_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.post_role_email(jsonb_build_object('kind', 'interview', 'interviewId', new.id, 'op', 'insert', 'actorId', auth.uid()));
  elsif new.decision is distinct from old.decision and new.decision is not null then
    perform public.post_role_email(jsonb_build_object('kind', 'interview', 'interviewId', new.id, 'op', 'decision', 'actorId', auth.uid()));
  elsif new.starts_at is distinct from old.starts_at or (new.status is distinct from old.status and new.status = 'cancelled') then
    perform public.post_role_email(jsonb_build_object('kind', 'interview', 'interviewId', new.id, 'op', 'update', 'actorId', auth.uid()));
  end if;
  return new;
end $$;
revoke all on function public.iv_activity_email() from public, anon, authenticated;
drop trigger if exists interviews_activity_email on public.interviews;
create trigger interviews_activity_email after insert or update of starts_at, status, decision on public.interviews
  for each row execute function public.iv_activity_email();

create or replace function public.task_activity_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is not null and new.assigned_to is distinct from new.created_by then
    perform public.post_role_email(jsonb_build_object('kind', 'task', 'taskId', new.id));
  end if;
  return new;
end $$;
revoke all on function public.task_activity_email() from public, anon, authenticated;
drop trigger if exists tasks_activity_email on public.tasks;
create trigger tasks_activity_email after insert on public.tasks for each row execute function public.task_activity_email();

create or replace function public.cand_assigned_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.recruiter_id is not null and new.recruiter_id is distinct from old.recruiter_id then
    perform public.post_role_email(jsonb_build_object('kind', 'assigned', 'candidateId', new.id, 'actorId', auth.uid()));
  end if;
  return new;
end $$;
revoke all on function public.cand_assigned_email() from public, anon, authenticated;
drop trigger if exists candidates_assigned_email on public.candidates;
create trigger candidates_assigned_email after update of recruiter_id on public.candidates for each row execute function public.cand_assigned_email();

create or replace function public.comment_activity_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.post_role_email(jsonb_build_object('kind', 'comment', 'commentId', new.id));
  return new;
end $$;
revoke all on function public.comment_activity_email() from public, anon, authenticated;
drop trigger if exists candidate_comments_activity_email on public.candidate_comments;
create trigger candidate_comments_activity_email after insert on public.candidate_comments for each row execute function public.comment_activity_email();

create or replace function public.kudos_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.post_role_email(jsonb_build_object('kind', 'kudos', 'kudosId', new.id));
  return new;
end $$;
revoke all on function public.kudos_email() from public, anon, authenticated;
drop trigger if exists placement_kudos_email on public.placement_kudos;
create trigger placement_kudos_email after insert on public.placement_kudos for each row execute function public.kudos_email();
