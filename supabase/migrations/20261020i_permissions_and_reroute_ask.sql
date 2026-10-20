-- 1) Rerouting asks first. Putting a candidate on a new role no longer always ends their other live
--    roles: the person routing chooses. keep_other_roles = true on the new row keeps the others.
alter table public.candidate_jobs add column if not exists keep_other_roles boolean not null default false;

create or replace function public.reroute_on_route()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.stage = 'Sourced' and new.candidate_response = 'pending' and not coalesce(new.keep_other_roles, false) then
    perform public.reject_other_roles(new.id);
  end if;
  return null;
end $$;

-- 2) Permissions: Admins and Rec Ops do what affects other people; recruiters manage their own
--    candidates, talk to them, update their status and see their own billing.

-- Recruiters see, in the Inbox, only the people who applied through their own links (already
-- their candidates). Everything else in the Inbox stays with Rec Ops and Admins.
drop policy if exists apps_recruiter_read on public.applications;
create policy apps_recruiter_read on public.applications for select to authenticated
  using ((select public.app_role()) = 'recruiter' and via_recruiter = (select auth.uid()));

-- Posting a job is for Rec Ops and Admins.
alter policy jobs_insert on public.jobs
  with check ((select public.is_staff()) and created_by = (select auth.uid()));

-- Tasks: recruiters add tasks for themselves only, and can't hand a task to someone else.
create or replace function public.guard_task_assignee()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is not null and not public.is_staff() and new.assigned_to is distinct from auth.uid()
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    raise exception 'Only Rec Ops or an Admin can give tasks to other people' using errcode = 'P0001';
  end if;
  return new;
end $$;
create or replace trigger tasks_guard_assignee before insert or update of assigned_to on public.tasks for each row execute function public.guard_task_assignee();

-- Candidates: only Rec Ops and Admins move a candidate to another recruiter.
create or replace function public.guard_candidate_owner()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is not null and not public.is_staff() and new.recruiter_id is distinct from old.recruiter_id then
    raise exception 'Only Rec Ops or an Admin can move a candidate to another recruiter' using errcode = 'P0001';
  end if;
  return new;
end $$;
create or replace trigger candidates_guard_owner before update of recruiter_id on public.candidates for each row execute function public.guard_candidate_owner();

-- A client lead the employer agreed to: same choice (keep or end the candidate's other live roles).
create or replace function public.lead_offer_process_ask(p_offer uuid, p_keep_others boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o record; l record; jid uuid; lid uuid; fresh boolean := false;
begin
  if not public.is_staff() then raise exception 'Only Rec Ops or an Admin can do this' using errcode = '42501'; end if;
  select * into o from lead_offers where id = p_offer;
  if not found then raise exception 'Offer not found'; end if;
  if o.status not in ('confirmed', 'processing') then raise exception 'The candidate has to confirm first'; end if;
  select * into l from leads where id = o.lead_id;
  jid := l.converted_job_id;
  if jid is null or not exists (select 1 from jobs where id = jid) then
    insert into jobs (role_title, client, location, country, description, status, lead_role, created_by)
    values (coalesce(nullif(l.job_title, ''), 'Role'), coalesce(nullif(l.company, ''), 'Client'), l.location,
            case when length(coalesce(l.country, '')) = 2 then l.country end, l.description, 'Open', true, auth.uid())
    returning id into jid;
    update leads set converted_job_id = jid where id = l.id;
  else
    update jobs set lead_role = true, status = case when status = 'Draft' then 'Open' else status end where id = jid and status <> 'Closed';
  end if;
  select id into lid from candidate_jobs where candidate_id = o.candidate_id and job_id = jid;
  if lid is null then
    insert into candidate_jobs (candidate_id, job_id, stage, candidate_response, added_by, keep_other_roles)
    values (o.candidate_id, jid, 'Submitted', 'accepted', auth.uid(), coalesce(p_keep_others, false)) returning id into lid;
    fresh := true;
    if not coalesce(p_keep_others, false) then perform public.reject_other_roles(lid); end if;
    insert into candidate_timeline (candidate_id, title, done)
    values (o.candidate_id, coalesce(l.company, 'The employer') || ' agreed to move forward for ' || coalesce(l.job_title, 'the role'), true);
  end if;
  update lead_offers set status = 'processing', candidate_job_id = lid where id = o.id;
  update leads set status = 'won' where id = l.id and status <> 'won';
  return jsonb_build_object('ok', true, 'jobId', jid, 'linkId', lid, 'fresh', fresh);
end $$;
revoke all on function public.lead_offer_process_ask(uuid, boolean) from public, anon;
grant execute on function public.lead_offer_process_ask(uuid, boolean) to authenticated;
create or replace function public.lead_offer_process(p_offer uuid)
returns jsonb language sql security definer set search_path to 'public' as $$ select public.lead_offer_process_ask(p_offer, false) $$;
