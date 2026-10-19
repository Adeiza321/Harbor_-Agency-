-- After a reroute the candidate's header (role, AI rating, status) follows their current role.

-- 1) Status: a role they've been routed to (waiting for them to accept) counts as "In review",
--    so a rerouted candidate doesn't drop to Active file. Only declined roles are ignored.
create or replace function public.derive_candidate_status(p_cand uuid)
returns text
language sql
stable security definer
set search_path to 'public'
as $$
  select case
    when count(*) = 0 then null
    when bool_or(stage = 'Placed') then 'Placed'
    when bool_or(stage = 'Offer') then 'Offer'
    when bool_or(stage = 'Interview') then 'Interview'
    when bool_or(stage = 'Submitted') then 'With client'
    when bool_or(stage in ('Sourced', 'In review', 'Screening')) then 'In review'
    else 'Active file' end
  from public.candidate_jobs
  where candidate_id = p_cand and coalesce(candidate_response, 'accepted') <> 'declined'
$$;

-- 2) The current role = their newest role that's still live. Its title and AI fit become the
--    candidate's role and AI rating (the numbers on their profile header and in lists).
create or replace function public.sync_current_role(p_cand uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare r record;
begin
  select cj.fit, j.role_title into r
    from public.candidate_jobs cj join public.jobs j on j.id = cj.job_id
   where cj.candidate_id = p_cand and cj.stage not in ('Rejected', 'Withdrawn')
     and coalesce(cj.candidate_response, 'accepted') <> 'declined'
   order by cj.created_at desc limit 1;
  if not found then return; end if;
  perform set_config('harbor.manual_review', 'on', true);
  update public.candidates
     set role_title = coalesce(r.role_title, role_title),
         ai_score = coalesce(r.fit, ai_score)
   where id = p_cand
     and (role_title is distinct from coalesce(r.role_title, role_title) or ai_score is distinct from coalesce(r.fit, ai_score));
  perform set_config('harbor.manual_review', 'off', true);
end $$;

-- 3) Rerouting: reject the earlier roles, then sync the header to the new role.
create or replace function public.reject_other_roles(p_link uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare l record; j record; n integer := 0;
begin
  select id, candidate_id, job_id into l from public.candidate_jobs where id = p_link;
  if l.id is null then return 0; end if;
  if auth.uid() is not null and not exists (select 1 from public.profiles where id = auth.uid() and status = 'Active') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select role_title, client into j from public.jobs where id = l.job_id;
  update public.candidate_jobs
     set stage = 'Rejected', outcome_at = now(), rejected_at = now(), rejected_by = auth.uid(),
         reject_kind = 'rerouted', reject_reason = 'rerouted',
         reject_feedback = 'Routed to ' || coalesce(j.role_title, 'another role') || coalesce(' at ' || nullif(j.client, ''), '')
   where candidate_id = l.candidate_id and id <> l.id
     and stage not in ('Rejected', 'Withdrawn', 'Placed');
  get diagnostics n = row_count;
  perform public.sync_current_role(l.candidate_id);
  if n > 0 then
    insert into public.candidate_timeline (candidate_id, title, done)
    values (l.candidate_id, 'Routed to ' || coalesce(j.role_title, 'another role') || coalesce(', ' || nullif(j.client, ''), '') || ': ' || n || ' earlier role' || case when n > 1 then 's' else '' end || ' marked Rejected', true);
  end if;
  return n;
end $$;

-- 4) When the current role's AI fit arrives or changes (screening finishes later), update the rating.
create or replace function public.sync_current_role_on_fit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.fit is distinct from old.fit or new.stage is distinct from old.stage or new.candidate_response is distinct from old.candidate_response then
    perform public.sync_current_role(new.candidate_id);
  end if;
  return null;
end $$;
drop trigger if exists candidate_jobs_current_role on public.candidate_jobs;
create trigger candidate_jobs_current_role after update of fit, stage, candidate_response on public.candidate_jobs
  for each row execute function public.sync_current_role_on_fit();

-- Bring every candidate in line now (status and header).
do $$ declare c record; d text; begin
  for c in select distinct candidate_id from public.candidate_jobs loop
    perform public.sync_current_role(c.candidate_id);
    d := public.derive_candidate_status(c.candidate_id);
    if d is not null then
      perform set_config('harbor.status_sync', 'on', true);
      update public.candidates set status = d where id = c.candidate_id and status is distinct from d and status not in ('Placed', 'Hired');
      perform set_config('harbor.status_sync', 'off', true);
    end if;
  end loop;
end $$;
