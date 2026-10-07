-- =====================================================================
-- 7 Oct 2026 — chat: delete / clear, recruiter role label; Inbox: apply page and triage
--   * Delete for everyone: the sender's own message is hidden on both sides
--     (candidate_job_messages.deleted_at; the row stays for the agency's records).
--   * Clear chat: hides the conversation up to that moment for the person clearing only
--     (chat_clears: one row per conversation and viewer, 'candidate' or a staff user id).
--   * The person a candidate chats with shows as "Recruiter" or "TA manager" (Rec Ops / Admin).
--   * applications gain status (new / assigned / dismissed), CV, LinkedIn and answers, fed by the
--     public apply page (/?apply=<job link_slug>) through submit-application; public_job() gives
--     that page the job's public details.
-- =====================================================================

alter table public.candidate_job_messages add column if not exists deleted_at timestamptz;

create table if not exists public.chat_clears (
  link_id uuid not null references public.candidate_jobs(id) on delete cascade,
  viewer text not null,            -- 'candidate' or a staff user's id
  cleared_at timestamptz not null default now(),
  primary key (link_id, viewer)
);
alter table public.chat_clears enable row level security;
drop policy if exists chat_clears_own on public.chat_clears;
create policy chat_clears_own on public.chat_clears for select to authenticated using (viewer = auth.uid()::text);

create or replace function public.staff_title(p_role text) returns text
language sql immutable as $$ select case when p_role = 'recruiter' then 'Recruiter' else 'TA manager' end $$;

-- The old 2-argument chat_payload(uuid, text) is no longer used (it still exists live, with no grants).
drop function if exists public.chat_payload(uuid, text);
create or replace function public.chat_payload(p_link_id uuid, p_side text, p_viewer text) returns jsonb
language sql stable security definer set search_path = public as $$
  with cl as (select cleared_at from chat_clears where link_id = p_link_id and viewer = p_viewer)
  select jsonb_build_object(
    'linkId', l.id, 'role', j.role_title, 'company', j.client,
    'clearedAt', (select cleared_at from cl),
    'candidate', jsonb_build_object('id', c.id, 'name', c.name, 'photo', c.photo_url),
    'recruiter', jsonb_build_object('name', split_part(coalesce(p.full_name, ''), ' ', 1), 'photo', p.avatar_url, 'title', staff_title(p.role)),
    'peerTypingAt', (select t.at from chat_typing t where t.link_id = l.id and t.who <> p_side),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender', m.sender, 'createdAt', m.created_at,
        'deleted', m.deleted_at is not null,
        'body', case when m.deleted_at is null then m.body else '' end,
        'deliveredAt', m.delivered_at,
        'readAt', case when m.sender = 'candidate' then m.recruiter_read_at else m.candidate_read_at end,
        'emailStatus', m.email_status,
        'emailError', case when p_side = 'recruiter' then m.email_error end,
        'file', case when m.attachment_path is not null and m.deleted_at is null then jsonb_build_object('name', m.attachment_name, 'type', m.attachment_type, 'size', m.attachment_size) end)
        order by m.created_at)
      from candidate_job_messages m
      where m.link_id = l.id and m.created_at > coalesce((select cleared_at from cl), '-infinity'::timestamptz)), '[]'::jsonb))
  from candidate_jobs l
  join jobs j on j.id = l.job_id
  join candidates c on c.id = l.candidate_id
  left join profiles p on p.id = c.recruiter_id
  where l.id = p_link_id
$$;
revoke all on function public.chat_payload(uuid, text, text) from public, anon, authenticated;

create or replace function public.candidate_chat(p_token text, p_link_id uuid, p_read boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token);
begin
  if not exists (select 1 from candidate_jobs where id = p_link_id and candidate_id = cand_id) then
    raise exception 'This conversation is no longer available';
  end if;
  update candidate_job_messages set delivered_at = now()
    where link_id = p_link_id and sender = 'recruiter' and delivered_at is null;
  if p_read then
    update candidate_job_messages set candidate_read_at = now()
      where link_id = p_link_id and sender = 'recruiter' and candidate_read_at is null;
  end if;
  return chat_payload(p_link_id, 'candidate', 'candidate');
end $$;

create or replace function public.staff_chat(p_link_id uuid, p_read boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not can_chat(p_link_id) then raise exception 'You don''t have access to this conversation'; end if;
  update candidate_job_messages set delivered_at = now()
    where link_id = p_link_id and sender = 'candidate' and delivered_at is null;
  if p_read then
    update candidate_job_messages set recruiter_read_at = now()
      where link_id = p_link_id and sender = 'candidate' and recruiter_read_at is null;
  end if;
  return chat_payload(p_link_id, 'recruiter', auth.uid()::text);
end $$;

-- Delete for everyone: only your own side's messages.
create or replace function public.candidate_delete_message(p_token text, p_message_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token);
begin
  update candidate_job_messages m set deleted_at = now()
    from candidate_jobs l
    where m.id = p_message_id and l.id = m.link_id and l.candidate_id = cand_id
      and m.sender = 'candidate' and m.deleted_at is null;
  if not found then raise exception 'You can only delete your own messages'; end if;
end $$;
revoke all on function public.candidate_delete_message(text, uuid) from public;
grant execute on function public.candidate_delete_message(text, uuid) to anon, authenticated;

create or replace function public.staff_delete_message(p_message_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update candidate_job_messages m set deleted_at = now()
    where m.id = p_message_id and m.sender = 'recruiter' and m.deleted_at is null
      and can_chat(m.link_id) and (m.author_id = auth.uid() or is_staff());
  if not found then raise exception 'You can only delete messages you sent'; end if;
end $$;
revoke all on function public.staff_delete_message(uuid) from public, anon;
grant execute on function public.staff_delete_message(uuid) to authenticated;

-- Clear chat: for the person clearing only. Everything up to now also counts as read.
create or replace function public.candidate_clear_chat(p_token text, p_link_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token);
begin
  if not exists (select 1 from candidate_jobs where id = p_link_id and candidate_id = cand_id) then
    raise exception 'This conversation is no longer available';
  end if;
  update candidate_job_messages set candidate_read_at = now()
    where link_id = p_link_id and sender = 'recruiter' and candidate_read_at is null;
  insert into chat_clears (link_id, viewer, cleared_at) values (p_link_id, 'candidate', now())
    on conflict (link_id, viewer) do update set cleared_at = now();
end $$;
revoke all on function public.candidate_clear_chat(text, uuid) from public;
grant execute on function public.candidate_clear_chat(text, uuid) to anon, authenticated;

create or replace function public.staff_clear_chat(p_link_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_chat(p_link_id) then raise exception 'You don''t have access to this conversation'; end if;
  update candidate_job_messages set recruiter_read_at = now()
    where link_id = p_link_id and sender = 'candidate' and recruiter_read_at is null;
  insert into chat_clears (link_id, viewer, cleared_at) values (p_link_id, auth.uid()::text, now())
    on conflict (link_id, viewer) do update set cleared_at = now();
end $$;
revoke all on function public.staff_clear_chat(uuid) from public, anon;
grant execute on function public.staff_clear_chat(uuid) to authenticated;

-- Inbox ----------------------------------------------------------------------------
alter table public.applications
  add column if not exists status text not null default 'new',
  add column if not exists handled_at timestamptz,
  add column if not exists handled_by uuid references public.profiles(id),
  add column if not exists resume_path text,
  add column if not exists resume_name text,
  add column if not exists linkedin text,
  add column if not exists answers jsonb not null default '[]'::jsonb,
  add column if not exists note text;
alter table public.applications drop constraint if exists applications_status_check;
alter table public.applications add constraint applications_status_check check (status in ('new', 'assigned', 'dismissed'));
create index if not exists applications_status_idx on public.applications (status, created_at desc);
-- Everything already turned into a candidate is handled.
update public.applications set status = 'assigned', handled_at = coalesce(handled_at, created_at)
  where status = 'new' and (candidate_id is not null or assigned_to is not null);

-- Public details of one job for the apply page. The client is never named.
create or replace function public.public_job(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'title', j.role_title, 'location', j.location, 'workSetup', j.work_setup, 'employmentType', j.employment_type,
    'country', j.country, 'status', j.status, 'headcount', j.headcount,
    'description', case when length(trim(coalesce(j.client, ''))) >= 2
      then regexp_replace(coalesce(j.description, ''), '\m' || regexp_replace(trim(j.client), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '(''s)?\M', 'our client', 'gi')
      else coalesce(j.description, '') end,
    'pay', case when coalesce((s.outreach->>'includePay')::boolean, false) and not coalesce(j.commission_only, false) and (j.min_pay is not null or j.max_pay is not null)
      then jsonb_build_object('min', j.min_pay, 'max', j.max_pay, 'currency', j.currency, 'period', j.salary_period) end,
    'commissionOnly', coalesce(j.commission_only, false),
    'questions', coalesce(j.screening_questions, '[]'::jsonb),
    'agency', coalesce(nullif(trim(s.agency_name), ''), 'Pronext'))
  from jobs j left join lateral (select agency_name, outreach from agency_settings limit 1) s on true
  where j.link_slug = p_slug
$$;
revoke all on function public.public_job(text) from public;
grant execute on function public.public_job(text) to anon, authenticated;

-- Candidate page: recruiter title, and the conversation preview respects deletes and clears.
create or replace function public.candidate_portal(p_token text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'name', c.name,
    'photoUrl', c.photo_url,
    'pitchConsent', c.pitch_consent,
    'recruiter', (select jsonb_build_object('name', split_part(coalesce(p.full_name, ''), ' ', 1), 'photo', p.avatar_url, 'title', staff_title(p.role))
                  from profiles p where p.id = c.recruiter_id),
    'endorsements', coalesce((select jsonb_agg(jsonb_build_object('company', e.company, 'role', e.role_title, 'status', e.status, 'createdAt', e.created_at))
                              from candidate_endorsements e where e.candidate_id = c.id), '[]'::jsonb),
    -- Every role they are or were on, newest first, with what the progress tracker needs.
    'applications', coalesce((select jsonb_agg(jsonb_build_object(
        'linkId', l.id, 'role', j.role_title, 'company', j.client, 'location', j.location, 'workSetup', j.work_setup,
        'jobStatus', j.status, 'stage', l.stage, 'response', coalesce(l.candidate_response, 'accepted'),
        'createdAt', l.created_at, 'respondedAt', l.responded_at, 'submittedAt', l.submitted_at, 'outcomeAt', l.outcome_at,
        'rejectMessage', l.reject_message,
        'interviews', coalesce((select jsonb_agg(jsonb_build_object('round', i.round, 'startsAt', i.starts_at, 'status', i.status) order by i.starts_at)
                                from interviews i where i.link_id = l.id and i.status in ('scheduled', 'done', 'no_show')), '[]'::jsonb),
        'unread', (select count(*) from candidate_job_messages m where m.link_id = l.id and m.sender = 'recruiter' and m.candidate_read_at is null and m.deleted_at is null),
        -- Latest message they can still see (after any "clear chat"), for the conversation list.
        'lastMessage', (select jsonb_build_object('sender', m.sender, 'body', case when m.deleted_at is null then m.body else '' end,
                                                  'deleted', m.deleted_at is not null, 'file', m.attachment_name, 'createdAt', m.created_at)
                        from candidate_job_messages m where m.link_id = l.id
                          and m.created_at > coalesce((select x.cleared_at from chat_clears x where x.link_id = l.id and x.viewer = 'candidate'), '-infinity'::timestamptz)
                        order by m.created_at desc limit 1)
      ) order by l.created_at desc)
      from candidate_jobs l join jobs j on j.id = l.job_id
      where l.candidate_id = c.id), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client, 'location', j.location, 'workSetup', j.work_setup, 'fit', (m->>'fit')::int))
                         from jsonb_array_elements(c.matches) m
                         join jobs j on j.id::text = m->>'job_id'
                         where (m->>'fit')::int >= 60 and m ? 'reviewedAt' and coalesce(m->>'verdict', '') in ('Perfect fit', 'Good fit', 'Possible fit')
                           and coalesce(j.status, '') <> 'Closed'
                           and not exists (select 1 from candidate_jobs l where l.candidate_id = c.id and l.job_id = j.id)
                           and c.status not in ('Interview', 'Placed', 'Hired')
                           and not exists (select 1 from candidate_jobs l where l.candidate_id = c.id
                                             and l.candidate_response <> 'declined' and l.stage in ('Interview', 'Offer', 'Placed'))), '[]'::jsonb),
    'routed', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client, 'location', j.location) order by l.created_at)
                        from candidate_jobs l join jobs j on j.id = l.job_id
                        where l.candidate_id = c.id and l.candidate_response = 'pending'), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client,
                             'questions', (select coalesce(jsonb_agg(x->>'q'), '[]'::jsonb) from jsonb_array_elements(l.ai->'followups'->'questions') x)) order by l.created_at)
                           from candidate_jobs l join jobs j on j.id = l.job_id
                           where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'sent'), '[]'::jsonb),
    'answered', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client))
                          from candidate_jobs l join jobs j on j.id = l.job_id
                          where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'answered'), '[]'::jsonb),
    'threads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'linkId', l.id, 'role', j.role_title, 'company', j.client,
        'messages', coalesce((select jsonb_agg(jsonb_build_object('sender', m.sender, 'body', m.body, 'createdAt', m.created_at) order by m.created_at)
                               from candidate_job_messages m where m.link_id = l.id), '[]'::jsonb),
        'unread', (select count(*) from candidate_job_messages m where m.link_id = l.id and m.sender = 'recruiter' and m.candidate_read_at is null)
      ) order by l.created_at desc)
      from candidate_jobs l join jobs j on j.id = l.job_id
      where l.candidate_id = c.id and l.candidate_response <> 'declined'
    ), '[]'::jsonb),
    'interviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'linkId', i.link_id, 'round', i.round, 'role', j.role_title, 'company', j.client,
        'startsAt', i.starts_at, 'durationMin', i.duration_min, 'locationType', i.location_type,
        'location', case when i.location_type in ('phone', 'in_person') then i.location end,
        'joinUrl', case when i.location_type = 'meet' then i.meet_url when i.location_type = 'link' then i.location end,
        'status', i.status, 'confirmed', i.candidate_confirmed_at is not null,
        'recruiter', split_part(coalesce(p.full_name, ''), ' ', 1)
      ) order by i.starts_at)
      from interviews i
      left join jobs j on j.id = i.job_id
      left join profiles p on p.id = i.recruiter_id
      where i.candidate_id = c.id
        and ((i.status = 'scheduled' and i.starts_at + make_interval(mins => i.duration_min) > now() - interval '2 hours')
          or (i.status = 'no_show' and i.noshow_followup_sent_at is not null and i.starts_at > now() - interval '21 days'))
    ), '[]'::jsonb))
  from candidates c where c.portal_token = p_token
$function$;
