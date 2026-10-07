-- =====================================================================
-- 7 Oct 2026 — candidate page redesign + WhatsApp-style chat
--   * candidates.photo_url: profile photo the candidate adds on their page
--     (uploaded by the candidate-photo Edge Function to the public avatars bucket)
--   * candidate_job_messages.delivered_at: the recipient's app has fetched it
--     (sent = 1 tick, delivered = 2 grey ticks, read = 2 blue ticks)
--   * chat_typing: "typing…" heartbeat per conversation and side
--   * chat RPCs for the candidate (portal token) and for staff (signed in)
--   * candidate_portal returns photo, recruiter and every application with its progress
-- =====================================================================

alter table public.candidates add column if not exists photo_url text;
alter table public.candidate_job_messages add column if not exists delivered_at timestamptz;

create table if not exists public.chat_typing (
  link_id uuid not null references public.candidate_jobs(id) on delete cascade,
  who text not null check (who in ('candidate', 'recruiter')),
  at timestamptz not null default now(),
  primary key (link_id, who)
);
alter table public.chat_typing enable row level security;  -- RPC access only, no policies

-- Candidate behind a portal token (12+ characters), or an error.
create or replace function public.portal_candidate_id(p_token text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare cand_id uuid;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  select id into cand_id from candidates where portal_token = p_token;
  if cand_id is null then raise exception 'Invalid link'; end if;
  return cand_id;
end $$;
revoke all on function public.portal_candidate_id(text) from public, anon, authenticated;

-- Can the signed-in user see this conversation? (same reach as the message RLS policies)
create or replace function public.can_chat(p_link_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (is_staff() or exists (
    select 1 from candidate_jobs cj join candidates c on c.id = cj.candidate_id
    where cj.id = p_link_id and (c.recruiter_id = auth.uid()
      or exists (select 1 from job_recruiters jr where jr.job_id = cj.job_id and jr.recruiter_id = auth.uid()))))
$$;
revoke all on function public.can_chat(uuid) from public, anon;
grant execute on function public.can_chat(uuid) to authenticated;

-- One conversation as JSON, seen from `side` ('candidate' or 'recruiter').
create or replace function public.chat_payload(p_link_id uuid, p_side text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'linkId', l.id, 'role', j.role_title, 'company', j.client,
    'candidate', jsonb_build_object('name', c.name, 'photo', c.photo_url),
    'recruiter', jsonb_build_object('name', split_part(coalesce(p.full_name, ''), ' ', 1), 'photo', p.avatar_url),
    'peerTypingAt', (select t.at from chat_typing t where t.link_id = l.id and t.who <> p_side),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender', m.sender, 'body', m.body, 'createdAt', m.created_at,
        'deliveredAt', m.delivered_at,
        'readAt', case when m.sender = 'candidate' then m.recruiter_read_at else m.candidate_read_at end)
        order by m.created_at)
      from candidate_job_messages m where m.link_id = l.id), '[]'::jsonb))
  from candidate_jobs l
  join jobs j on j.id = l.job_id
  join candidates c on c.id = l.candidate_id
  left join profiles p on p.id = c.recruiter_id
  where l.id = p_link_id
$$;
revoke all on function public.chat_payload(uuid, text) from public, anon, authenticated;

-- Candidate side --------------------------------------------------------------
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
  return chat_payload(p_link_id, 'candidate');
end $$;
revoke all on function public.candidate_chat(text, uuid, boolean) from public;
grant execute on function public.candidate_chat(text, uuid, boolean) to anon, authenticated;

create or replace function public.candidate_typing(p_token text, p_link_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token);
begin
  if exists (select 1 from candidate_jobs where id = p_link_id and candidate_id = cand_id) then
    insert into chat_typing (link_id, who, at) values (p_link_id, 'candidate', now())
      on conflict (link_id, who) do update set at = now();
  end if;
end $$;
revoke all on function public.candidate_typing(text, uuid) from public;
grant execute on function public.candidate_typing(text, uuid) to anon, authenticated;

-- Opening the candidate page counts as delivery of everything waiting for them.
create or replace function public.candidate_mark_delivered(p_token text) returns void
language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token);
begin
  update candidate_job_messages m set delivered_at = now()
    from candidate_jobs l
    where l.id = m.link_id and l.candidate_id = cand_id and m.sender = 'recruiter' and m.delivered_at is null;
end $$;
revoke all on function public.candidate_mark_delivered(text) from public;
grant execute on function public.candidate_mark_delivered(text) to anon, authenticated;

-- Staff side --------------------------------------------------------------------
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
  return chat_payload(p_link_id, 'recruiter');
end $$;
revoke all on function public.staff_chat(uuid, boolean) from public, anon;
grant execute on function public.staff_chat(uuid, boolean) to authenticated;

create or replace function public.staff_typing(p_link_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if can_chat(p_link_id) then
    insert into chat_typing (link_id, who, at) values (p_link_id, 'recruiter', now())
      on conflict (link_id, who) do update set at = now();
  end if;
end $$;
revoke all on function public.staff_typing(uuid) from public, anon;
grant execute on function public.staff_typing(uuid) to authenticated;

-- A recruiter's app loading counts as delivery of candidate messages they can see.
create or replace function public.staff_mark_delivered() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update candidate_job_messages m set delivered_at = now()
    where m.sender = 'candidate' and m.delivered_at is null and can_chat(m.link_id);
end $$;
revoke all on function public.staff_mark_delivered() from public, anon;
grant execute on function public.staff_mark_delivered() to authenticated;

-- Candidate page data ------------------------------------------------------------
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
    'recruiter', (select jsonb_build_object('name', split_part(coalesce(p.full_name, ''), ' ', 1), 'photo', p.avatar_url)
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
        'unread', (select count(*) from candidate_job_messages m where m.link_id = l.id and m.sender = 'recruiter' and m.candidate_read_at is null),
        'lastMessage', (select jsonb_build_object('sender', m.sender, 'body', m.body, 'createdAt', m.created_at)
                        from candidate_job_messages m where m.link_id = l.id order by m.created_at desc limit 1)
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
