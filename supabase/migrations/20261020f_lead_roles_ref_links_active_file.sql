-- Undo the first Active file attempt (recruiter "Add to Active file" on a profile, and the
-- candidate-page "Add me" card). The Active file is for candidates who come in WITHOUT a job:
-- a recruiter adding someone straight to it, or someone sending their CV with no role picked.
drop function if exists public.add_to_active_file(uuid);
drop function if exists public.candidate_join_active_file(text);
drop function if exists public.candidate_active_file(text);
drop function if exists public.candidate_live_role(uuid);

-- Lead roles: the job made when an employer from a client lead agrees to a candidate. A normal
-- open job, but kept apart: only Rec Ops and Admins see it (its own tab under Jobs), it's never
-- on the public jobs board or job pages, starts no sourcing and sends no new-role emails.
alter table public.jobs add column if not exists lead_role boolean not null default false;

alter policy jobs_read on public.jobs
  using ((select public.app_role()) is not null and (not lead_role or (select public.is_staff())));

do $$
declare d text;
begin
  d := pg_get_functiondef('public.public_jobs()'::regprocedure);
  d := replace(d, 'left join jobs j on j.status = ''Open'' and j.link_slug is not null', 'left join jobs j on j.status = ''Open'' and j.link_slug is not null and not j.lead_role');
  execute d;
  d := pg_get_functiondef('public.public_job(text)'::regprocedure);
  d := replace(d, 'where j.link_slug = p_slug', 'where j.link_slug = p_slug and not j.lead_role');
  execute d;
  d := pg_get_functiondef('public.record_job_view(text, text, text)'::regprocedure);
  d := replace(d, 'status in (''Open'', ''On hold'') limit 1', 'status in (''Open'', ''On hold'') and not lead_role limit 1');
  execute d;
end $$;

create or replace function public.queue_job_sourcing()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.lead_role then return new; end if;
  if new.status = 'Open' and (tg_op = 'INSERT' or old.status not in ('Open', 'On hold')) then
    new.sourcing := coalesce(new.sourcing, '{}'::jsonb) || jsonb_build_object('state', 'pending', 'queuedAt', now());
  end if;
  return new;
end $$;

create or replace function public.jobs_role_email()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.lead_role then return new; end if;
  if tg_op = 'INSERT' then
    if new.status = 'Open' then perform public.post_role_email(jsonb_build_object('kind', 'status', 'jobId', new.id, 'from', '', 'to', new.status)); end if;
  elsif new.status is distinct from old.status and new.status <> 'Draft' then
    perform public.post_role_email(jsonb_build_object('kind', 'status', 'jobId', new.id, 'from', coalesce(old.status, ''), 'to', new.status));
  end if;
  return new;
end $$;

-- The employer agreed: the candidate (who already said yes) goes on the lead role with the
-- employer, like a reroute: any other live roles are marked Rejected as 'rerouted'.
create or replace function public.lead_offer_process(p_offer uuid)
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
    insert into candidate_jobs (candidate_id, job_id, stage, candidate_response, added_by)
    values (o.candidate_id, jid, 'Submitted', 'accepted', auth.uid()) returning id into lid;
    fresh := true;
    perform public.reject_other_roles(lid);
    insert into candidate_timeline (candidate_id, title, done)
    values (o.candidate_id, coalesce(l.company, 'The employer') || ' agreed to move forward for ' || coalesce(l.job_title, 'the role'), true);
  end if;
  update lead_offers set status = 'processing', candidate_job_id = lid where id = o.id;
  update leads set status = 'won' where id = l.id and status <> 'won';
  return jsonb_build_object('ok', true, 'jobId', jid, 'linkId', lid, 'fresh', fresh);
end $$;

-- Links tied to a recruiter: every team member has a short code; a job link or the Active file
-- link carrying ?r=<code> files whoever applies through it straight under that person.
alter table public.profiles add column if not exists ref_code text;
update public.profiles set ref_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 8) where ref_code is null;
alter table public.profiles alter column ref_code set default substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
create unique index if not exists profiles_ref_code_key on public.profiles (ref_code);
alter table public.applications add column if not exists via_recruiter uuid references public.profiles(id) on delete set null;
