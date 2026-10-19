-- Routing a candidate to another role ends their other live roles.
-- Every earlier role that isn't already finished (Rejected / Withdrawn / Placed) becomes
-- Rejected with reject_kind 'rerouted', and the candidate's own role_title (the header on
-- their profile) switches to the new role. Their overall status re-derives through the
-- existing sync_candidate_status trigger. reject_kind 'rerouted' is deliberately not
-- 'client' or 'internal', so it doesn't feed screening lessons or client-feedback sync.
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
  -- Called from the app: only active staff may do this.
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
  if j.role_title is not null then
    update public.candidates set role_title = j.role_title where id = l.candidate_id and role_title is distinct from j.role_title;
  end if;
  if n > 0 then
    insert into public.candidate_timeline (candidate_id, title, done)
    values (l.candidate_id, 'Routed to ' || coalesce(j.role_title, 'another role') || coalesce(', ' || nullif(j.client, ''), '') || ': ' || n || ' earlier role' || case when n > 1 then 's' else '' end || ' marked Rejected', true);
  end if;
  return n;
end $$;
revoke all on function public.reject_other_roles(uuid) from public, anon;
grant execute on function public.reject_other_roles(uuid) to authenticated, service_role;

-- A route (new link waiting for the candidate to accept) does it automatically,
-- whichever screen or function created it.
create or replace function public.reroute_on_route()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.stage = 'Sourced' and new.candidate_response = 'pending' then
    perform public.reject_other_roles(new.id);
  end if;
  return null;
end $$;
drop trigger if exists candidate_jobs_reroute on public.candidate_jobs;
create trigger candidate_jobs_reroute after insert on public.candidate_jobs
  for each row execute function public.reroute_on_route();
