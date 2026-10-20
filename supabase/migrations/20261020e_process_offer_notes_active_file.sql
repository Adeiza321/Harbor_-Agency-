-- 1) A client lead the employer agreed to: the candidate who confirmed is processed like a reroute.
--    The posting becomes a Draft job for that client (not public, no sourcing until someone opens
--    it), and the candidate is routed to it (stage Sourced, waiting for them to accept), which
--    marks any other live roles Rejected as 'rerouted' (trigger candidate_jobs_reroute).
alter table public.lead_offers add column if not exists candidate_job_id uuid references public.candidate_jobs(id) on delete set null;
alter table public.lead_offers drop constraint if exists lead_offers_status_check;
alter table public.lead_offers add constraint lead_offers_status_check
  check (status in ('suggested','sent','interested','confirmed','processing','declined','skipped'));

create or replace function public.lead_offer_process(p_offer uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare o record; l record; jid uuid; lid uuid;
begin
  if not public.is_staff() then raise exception 'Only Rec Ops or an Admin can do this' using errcode = '42501'; end if;
  select * into o from lead_offers where id = p_offer;
  if not found then raise exception 'Offer not found'; end if;
  if o.status not in ('confirmed', 'processing') then raise exception 'The candidate has to confirm first'; end if;
  select * into l from leads where id = o.lead_id;
  jid := l.converted_job_id;
  if jid is null or not exists (select 1 from jobs where id = jid) then
    insert into jobs (role_title, client, location, country, description, status, created_by)
    values (coalesce(nullif(l.job_title, ''), 'Role'), coalesce(nullif(l.company, ''), 'Client'), l.location,
            case when length(coalesce(l.country, '')) = 2 then l.country end, l.description, 'Draft', auth.uid())
    returning id into jid;
    update leads set converted_job_id = jid where id = l.id;
  end if;
  select id into lid from candidate_jobs where candidate_id = o.candidate_id and job_id = jid;
  if lid is null then
    insert into candidate_jobs (candidate_id, job_id, stage, candidate_response, added_by)
    values (o.candidate_id, jid, 'Sourced', 'pending', auth.uid()) returning id into lid;
    insert into candidate_timeline (candidate_id, title, done)
    values (o.candidate_id, coalesce(l.company, 'The employer') || ' agreed to consider them for ' || coalesce(l.job_title, 'the role'), true);
  end if;
  update lead_offers set status = 'processing', candidate_job_id = lid where id = o.id;
  update leads set status = 'won' where id = l.id and status <> 'won';
  return jsonb_build_object('ok', true, 'jobId', jid, 'linkId', lid);
end $$;
revoke all on function public.lead_offer_process(uuid) from public, anon;
grant execute on function public.lead_offer_process(uuid) to authenticated;

-- 2) A pinned note on the candidate's profile: shown at the top for everyone on the team who opens it.
alter table public.candidates add column if not exists profile_note text,
  add column if not exists profile_note_by uuid references public.profiles(id) on delete set null,
  add column if not exists profile_note_at timestamptz;

create or replace function public.set_profile_note(p_candidate uuid, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare n text := nullif(left(trim(coalesce(p_note, '')), 2000), '');
begin
  if public.app_role() is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  perform set_config('harbor.quiet', 'on', true);
  update candidates set profile_note = n, profile_note_by = case when n is null then null else auth.uid() end,
         profile_note_at = case when n is null then null else now() end
   where id = p_candidate;
  if not found then raise exception 'Candidate not found'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.set_profile_note(uuid, text) from public, anon;
grant execute on function public.set_profile_note(uuid, text) to authenticated;

-- 3) Active file: a recruiter can put a candidate on it, and a candidate can add themselves from
--    their candidate page. Not while they're live on a role: that role decides their status.
create or replace function public.candidate_live_role(p_cand uuid)
returns text language sql stable security definer set search_path to 'public' as $$
  select j.role_title from candidate_jobs l join jobs j on j.id = l.job_id
   where l.candidate_id = p_cand and coalesce(l.candidate_response, 'accepted') <> 'declined'
     and l.stage not in ('Rejected', 'Withdrawn', 'Placed')
   order by l.created_at desc limit 1
$$;
revoke all on function public.candidate_live_role(uuid) from public, anon, authenticated;

create or replace function public.add_to_active_file(p_candidate uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; live text;
begin
  select id, name, status, recruiter_id into c from candidates where id = p_candidate;
  if not found then raise exception 'Candidate not found'; end if;
  if not (public.is_staff() or (c.recruiter_id = auth.uid() and public.app_role() is not null)) then
    raise exception 'Only their recruiter, Rec Ops or an Admin can do this' using errcode = '42501';
  end if;
  if c.status = 'Active file' then return jsonb_build_object('ok', true, 'already', true); end if;
  live := candidate_live_role(c.id);
  if live is not null then
    raise exception '% is live on %. Reject or reroute them there first.', split_part(c.name, ' ', 1), live using errcode = 'P0001';
  end if;
  perform set_config('harbor.status_sync', 'on', true);
  update candidates set status = 'Active file' where id = c.id;
  perform set_config('harbor.status_sync', 'off', true);
  insert into candidate_timeline (candidate_id, title, done) values (c.id, 'Added to the Active file', true);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.add_to_active_file(uuid) from public, anon;
grant execute on function public.add_to_active_file(uuid) to authenticated;

-- Candidate page: are they on the Active file, or live on a role right now?
create or replace function public.candidate_active_file(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare cid uuid := portal_candidate_id(p_token); c record;
begin
  if cid is null then return null; end if;
  select status, pitch_consent into c from candidates where id = cid;
  return jsonb_build_object('inActiveFile', c.status = 'Active file', 'live', candidate_live_role(cid) is not null, 'pitchConsent', coalesce(c.pitch_consent, false));
end $$;

-- "Keep me in mind for other roles": on the Active file (when not live on a role) and open to
-- being matched to new roles, which we always ask about first.
create or replace function public.candidate_join_active_file(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare cid uuid := portal_candidate_id(p_token); c record; live boolean;
begin
  if cid is null then raise exception 'Invalid link'; end if;
  select name, status, recruiter_id into c from candidates where id = cid;
  live := candidate_live_role(cid) is not null;
  perform set_config('harbor.status_sync', 'on', true);
  update candidates set pitch_consent = true, pitch_consent_at = now(),
         status = case when live then status else 'Active file' end
   where id = cid;
  perform set_config('harbor.status_sync', 'off', true);
  insert into candidate_timeline (candidate_id, title, done) values (cid, 'Added themselves to the Active file from their candidate page', true);
  if c.recruiter_id is not null then
    perform push_update(c.recruiter_id, 'event', c.name || ' added themselves to the Active file',
      'They want to be considered for other roles.', jsonb_build_object('page', 'candidates', 'candidateId', cid), 'activefile:' || cid, false, null);
  end if;
  return jsonb_build_object('ok', true, 'live', live);
end $$;

revoke all on function public.candidate_active_file(text) from public;
revoke all on function public.candidate_join_active_file(text) from public;
grant execute on function public.candidate_active_file(text) to anon, authenticated;
grant execute on function public.candidate_join_active_file(text) to anon, authenticated;
