-- Assistant updates: the assistant tells each person about their own work without being asked.
--   event     something happened to their candidates / roles / tasks, done by someone else or by the
--             system: a candidate replied in chat, an outreach contact said they're interested, a
--             candidate accepted or declined, a stage change, the client viewed a profile, an
--             interview confirmed or decided, a task or a candidate given to them, a teammate's note
--   job       a background job they started finished (X-ray search, sourcing run)
--   reminder  an interview within the hour; weekday mornings, tasks due and interviews awaiting feedback
--   roundup   the end-of-day round-up (written by the assistant function, action roundup_next)
-- Shown in the assistant panel (badge, sound, desktop pop-up); anything not seen in ProNext after a
-- few minutes is emailed by the assistant-updates function, except what another email already covers
-- (chat replies: notify-staff; recruiters' activity emails: role-emails) — email_ok = false for those.
-- Switches (profiles.notification_prefs): assistUpdates, assistEmail, assistDesktop, assistRoundup.

create table if not exists public.assistant_updates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('event', 'job', 'reminder', 'roundup')),
  title text not null,
  body text not null default '',
  link jsonb not null default '{}'::jsonb,   -- { page, candidateId, jobId, threadId }
  dedupe text,
  email_ok boolean not null default true,
  emailed_at timestamptz,
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe)
);
create index if not exists assistant_updates_user_idx on public.assistant_updates(user_id, created_at desc);
create index if not exists assistant_updates_email_idx on public.assistant_updates(created_at) where seen_at is null and emailed_at is null and email_ok;
alter table public.assistant_updates enable row level security;
drop policy if exists assistant_updates_read on public.assistant_updates;
create policy assistant_updates_read on public.assistant_updates for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists assistant_updates_seen on public.assistant_updates;
create policy assistant_updates_seen on public.assistant_updates for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke insert, update, delete on public.assistant_updates from anon, authenticated;
grant select on public.assistant_updates to authenticated;
grant update (seen_at) on public.assistant_updates to authenticated;

-- Adds one update for a staff member (never for something they did themselves; skipped if they
-- turned assistant updates off). p_covered: another email already tells them about it.
create or replace function public.push_update(p_user uuid, p_kind text, p_title text, p_body text, p_link jsonb, p_dedupe text, p_covered boolean default false, p_actor uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  if p_user is null or p_user is not distinct from p_actor then return; end if;
  select status, role, coalesce(notification_prefs, '{}'::jsonb) prefs into u from profiles where id = p_user;
  if not found or u.status <> 'Active' or u.role not in ('admin', 'recops', 'recruiter') then return; end if;
  if (u.prefs ->> 'assistUpdates') = 'false' then return; end if;
  insert into assistant_updates (user_id, kind, title, body, link, dedupe, email_ok)
    values (p_user, p_kind, left(p_title, 200), left(coalesce(p_body, ''), 2000), coalesce(p_link, '{}'::jsonb), p_dedupe, not coalesce(p_covered, false))
    on conflict (user_id, dedupe) do nothing;
exception when others then
  raise warning 'push_update: %', sqlerrm;   -- never block the change that triggered it
end $$;
revoke all on function public.push_update(uuid, text, text, text, jsonb, text, boolean, uuid) from public, anon, authenticated;

-- Recruiters with activity emails on already get an email for these events (role-emails).
create or replace function public.activity_email_covers(p_user uuid, p_actor uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'recruiter' and coalesce(notification_prefs ->> 'activityEmail', '') <> 'false'
                     and p_user is distinct from p_actor from profiles where id = p_user), false)
$$;
revoke all on function public.activity_email_covers(uuid, uuid) from public, anon, authenticated;

-- Whose work a candidate on a role is: the candidate's recruiter, else whoever created the role.
create or replace function public.link_owner(p_link uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(c.recruiter_id, j.created_by) from candidate_jobs l join candidates c on c.id = l.candidate_id left join jobs j on j.id = l.job_id where l.id = p_link
$$;
revoke all on function public.link_owner(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- events

-- A candidate replied in chat (one update per burst of 10 minutes; notify-staff emails it).
create or replace function public.upd_chat_reply()
returns trigger language plpgsql security definer set search_path = public as $$
declare c record; msg_email boolean;
begin
  if new.sender <> 'candidate' or new.staff_id is null then return new; end if;
  select cd.id, cd.name, j.role_title into c from candidate_jobs l join candidates cd on cd.id = l.candidate_id left join jobs j on j.id = l.job_id where l.id = new.link_id;
  select coalesce(notification_prefs ->> 'msgEmail', '') <> 'false' into msg_email from profiles where id = new.staff_id;
  perform push_update(new.staff_id, 'event', coalesce(c.name, 'A candidate') || ' sent you a message',
    coalesce(nullif(left(new.body, 300), ''), case when new.attachment_name ~ '^Voice message' then '🎤 Voice message' when new.attachment_name is not null then '📎 ' || new.attachment_name else '' end)
      || case when c.role_title is not null then E'\nAbout ' || c.role_title else '' end,
    jsonb_build_object('page', 'messages', 'linkId', new.link_id, 'candidateId', c.id),
    'chat:' || new.link_id || ':' || floor(extract(epoch from new.created_at) / 600)::bigint, coalesce(msg_email, true));
  return new;
end $$;
drop trigger if exists candidate_job_messages_update on public.candidate_job_messages;
create trigger candidate_job_messages_update after insert on public.candidate_job_messages for each row execute function public.upd_chat_reply();

-- Outreach / referral contacts saying they're interested: the role's creator and its recruiters.
create or replace function public.upd_interest()
returns trigger language plpgsql security definer set search_path = public as $$
declare j record; r uuid; why text;
begin
  if tg_op = 'INSERT' and new.source = 'outreach' then why := 'They answered your outreach email.';
  elsif tg_op = 'UPDATE' and old.interest_at is null and new.interest_at is not null then why := 'They said yes to the referral.';
  else return new; end if;
  select id, role_title, client, created_by into j from jobs where id = new.job_id;
  for r in select distinct x from (select j.created_by x union select recruiter_id from job_recruiters where job_id = new.job_id) s where x is not null loop
    perform push_update(r, 'event', coalesce(new.name, 'Someone') || ' is interested in ' || coalesce(j.role_title, new.role_title, 'a role'),
      why || ' They''re waiting in the Inbox.', jsonb_build_object('page', 'inbox', 'jobId', new.job_id), 'interest:' || new.id);
  end loop;
  return new;
end $$;
drop trigger if exists applications_update on public.applications;
create trigger applications_update after insert or update of interest_at on public.applications for each row execute function public.upd_interest();

-- A candidate on a role: accepted / declined, moved stage by someone else (or the client), client viewed.
create or replace function public.upd_link()
returns trigger language plpgsql security definer set search_path = public as $$
declare c record; owner uuid := link_owner(new.id); actor uuid := auth.uid(); lnk jsonb;
begin
  select cd.id, cd.name, j.role_title, j.client into c from candidates cd, jobs j where cd.id = new.candidate_id and j.id = new.job_id;
  lnk := jsonb_build_object('page', 'candidates', 'candidateId', new.candidate_id, 'jobId', new.job_id);
  if new.candidate_response is distinct from old.candidate_response and new.candidate_response in ('accepted', 'declined') then
    perform push_update(owner, 'event', c.name || ' ' || new.candidate_response || ' ' || c.role_title,
      case when new.candidate_response = 'accepted' then 'They''re happy to be put forward for ' || c.role_title || coalesce(' at ' || c.client, '') || '.' else 'They don''t want to go ahead with ' || c.role_title || '.' end,
      lnk, 'resp:' || new.id || ':' || new.candidate_response, activity_email_covers(owner, actor), actor);
  end if;
  if new.stage is distinct from old.stage then
    perform push_update(owner, 'event', c.name || ' moved to ' || new.stage,
      c.role_title || coalesce(' at ' || c.client, '') || ' (was ' || coalesce(old.stage, 'new') || ')'
        || case when actor is null then E'\nUpdated by the client or the system.' else '' end
        || case when new.stage = 'Rejected' and new.reject_reason is not null then E'\nReason: ' || new.reject_reason else '' end,
      lnk, 'stage:' || new.id || ':' || new.stage || ':' || floor(extract(epoch from now()) / 60)::bigint, activity_email_covers(owner, actor), actor);
  end if;
  if old.client_viewed_at is null and new.client_viewed_at is not null then
    perform push_update(owner, 'event', 'The client viewed ' || c.name || '''s profile',
      'For ' || c.role_title || coalesce(' at ' || c.client, '') || '. A good moment to ask them for feedback.', lnk, 'viewed:' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists candidate_jobs_update on public.candidate_jobs;
create trigger candidate_jobs_update after update of stage, candidate_response, client_viewed_at on public.candidate_jobs for each row execute function public.upd_link();

-- Interviews: the candidate confirmed; a decision or feedback recorded by someone else.
create or replace function public.upd_interview()
returns trigger language plpgsql security definer set search_path = public as $$
declare c record; actor uuid := auth.uid(); who uuid := coalesce(new.recruiter_id, new.created_by); lnk jsonb;
begin
  select cd.name, j.role_title into c from candidates cd left join jobs j on j.id = new.job_id where cd.id = new.candidate_id;
  lnk := jsonb_build_object('page', 'candidates', 'candidateId', new.candidate_id, 'jobId', new.job_id);
  if old.candidate_confirmed_at is null and new.candidate_confirmed_at is not null then
    perform push_update(who, 'event', coalesce(c.name, 'The candidate') || ' confirmed the interview',
      coalesce(new.round, 'Interview') || coalesce(' for ' || c.role_title, '') || ', ' || to_char(new.starts_at at time zone coalesce(new.scheduler_tz, 'Africa/Lagos'), 'Dy DD Mon, HH24:MI') || '.',
      lnk, 'ivconf:' || new.id || ':' || new.starts_at);
  end if;
  if (new.decision is distinct from old.decision and new.decision is not null) or (new.feedback is distinct from old.feedback and coalesce(new.feedback, '') <> '') then
    perform push_update(who, 'event', 'Interview feedback for ' || coalesce(c.name, 'your candidate'),
      coalesce('Decision: ' || new.decision || E'\n', '') || coalesce(left(new.feedback, 400), ''),
      lnk, 'ivdec:' || new.id || ':' || md5(coalesce(new.decision, '') || coalesce(new.feedback, '')), activity_email_covers(who, actor), actor);
  end if;
  return new;
end $$;
drop trigger if exists interviews_update on public.interviews;
create trigger interviews_update after update of candidate_confirmed_at, decision, feedback on public.interviews for each row execute function public.upd_interview();

-- A task given to you by someone else.
create or replace function public.upd_task()
returns trigger language plpgsql security definer set search_path = public as $$
declare by_name text;
begin
  if new.assigned_to is null or new.assigned_to is not distinct from new.created_by then return new; end if;
  select split_part(full_name, ' ', 1) into by_name from profiles where id = new.created_by;
  perform push_update(new.assigned_to, 'event', coalesce(by_name, 'Someone') || ' gave you a task',
    new.title || coalesce(E'\nDue ' || to_char(new.due_on, 'Dy DD Mon'), ''),
    jsonb_build_object('page', 'todo', 'candidateId', new.candidate_id, 'jobId', new.job_id), 'task:' || new.id, activity_email_covers(new.assigned_to, new.created_by), new.created_by);
  return new;
end $$;
drop trigger if exists tasks_update on public.tasks;
create trigger tasks_update after insert on public.tasks for each row execute function public.upd_task();

-- A candidate assigned to you by someone else.
create or replace function public.upd_assigned()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor uuid := auth.uid(); by_name text;
begin
  if new.recruiter_id is null or new.recruiter_id is not distinct from old.recruiter_id then return new; end if;
  select split_part(full_name, ' ', 1) into by_name from profiles where id = actor;
  perform push_update(new.recruiter_id, 'event', new.name || ' is now your candidate',
    coalesce(by_name || ' assigned them to you.', 'They were assigned to you.') || coalesce(E'\n' || new.role_title, ''),
    jsonb_build_object('page', 'candidates', 'candidateId', new.id), 'assigned:' || new.id || ':' || new.recruiter_id || ':' || floor(extract(epoch from now()) / 60)::bigint,
    activity_email_covers(new.recruiter_id, actor), actor);
  return new;
end $$;
drop trigger if exists candidates_assigned_update on public.candidates;
create trigger candidates_assigned_update after update of recruiter_id on public.candidates for each row execute function public.upd_assigned();

-- A teammate's note on your candidate.
create or replace function public.upd_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare c record; by_name text;
begin
  select id, name, recruiter_id into c from candidates where id = new.candidate_id;
  select split_part(full_name, ' ', 1) into by_name from profiles where id = new.author_id;
  perform push_update(c.recruiter_id, 'event', coalesce(by_name, 'A teammate') || ' added a note on ' || c.name,
    left(new.body, 400), jsonb_build_object('page', 'candidates', 'candidateId', c.id), 'note:' || new.id, activity_email_covers(c.recruiter_id, new.author_id), new.author_id);
  return new;
end $$;
drop trigger if exists candidate_comments_update on public.candidate_comments;
create trigger candidate_comments_update after insert on public.candidate_comments for each row execute function public.upd_comment();

-- ---------------------------------------------------------------- finished jobs
-- X-ray search or sourcing run finished: whoever started it (X-ray keeps "by" while running), else the role's creator.
create or replace function public.upd_job_runs()
returns trigger language plpgsql security definer set search_path = public as $$
declare who uuid; n int; lnk jsonb := jsonb_build_object('page', 'jobDetail', 'jobId', new.id, 'tab', 'sourcing');
begin
  if coalesce(old.xray ->> 'state', '') in ('running', 'queued') and new.xray ->> 'state' = 'done' then
    who := coalesce(nullif(old.xray ->> 'by', '')::uuid, new.created_by);
    n := coalesce((new.xray ->> 'found')::int, 0);
    perform push_update(who, 'job', 'X-ray search finished: ' || new.role_title,
      case when n > 0 then n || ' new ' || case when n = 1 then 'person' else 'people' end || ' found for ' || new.role_title || coalesce(' at ' || new.client, '') || '. Review them on the role''s Sourcing tab.'
           else 'No new people this time' || coalesce(': ' || left(new.xray ->> 'note', 300), '.') end,
      lnk, 'xray:' || new.id || ':' || coalesce(new.xray ->> 'at', now()::text));
  end if;
  if coalesce(old.sourcing ->> 'state', '') in ('running', 'queued') and new.sourcing ->> 'state' = 'done' then
    n := coalesce((new.sourcing -> 'external' ->> 'kept')::int, 0);
    perform push_update(new.created_by, 'job', 'Sourcing finished: ' || new.role_title,
      case when n > 0 then n || ' strong ' || case when n = 1 then 'match' else 'matches' end || ' kept for ' || new.role_title || '. Review them on the role''s Sourcing tab.' else 'No new matches this time.' end,
      lnk, 'sourcing:' || new.id || ':' || coalesce(new.sourcing ->> 'queuedAt', now()::text));
  end if;
  return new;
exception when others then
  raise warning 'upd_job_runs: %', sqlerrm; return new;
end $$;
drop trigger if exists jobs_runs_update on public.jobs;
create trigger jobs_runs_update after update of xray, sourcing on public.jobs for each row execute function public.upd_job_runs();

-- ---------------------------------------------------------------- reminders
-- Every 5 minutes: interviews starting within the hour. Weekday mornings (08:30 Lagos): tasks due
-- or overdue and interviews still waiting for feedback, in one update per person.
create or replace function public.assistant_reminders()
returns void language plpgsql security definer set search_path = public as $$
declare iv record; p record; lines text; n int; lagos timestamp := now() at time zone 'Africa/Lagos';
begin
  for iv in select i.*, cd.name cname, j.role_title from interviews i join candidates cd on cd.id = i.candidate_id left join jobs j on j.id = i.job_id
            where i.status = 'scheduled' and i.starts_at between now() + interval '2 minutes' and now() + interval '65 minutes' loop
    perform push_update(coalesce(iv.recruiter_id, iv.created_by), 'reminder',
      'Interview in ' || greatest(1, round(extract(epoch from iv.starts_at - now()) / 60))::int || ' min: ' || iv.cname,
      coalesce(iv.round, 'Interview') || coalesce(' for ' || iv.role_title, '') || ' at ' || to_char(iv.starts_at at time zone coalesce(iv.scheduler_tz, 'Africa/Lagos'), 'HH24:MI')
        || case when iv.meet_url is not null then E'\nJoin: ' || iv.meet_url when iv.location is not null then E'\nWhere: ' || iv.location else '' end,
      jsonb_build_object('page', 'candidates', 'candidateId', iv.candidate_id, 'jobId', iv.job_id), 'ivsoon:' || iv.id || ':' || iv.starts_at);
  end loop;

  if extract(isodow from lagos) <= 5 and lagos::time between time '08:30' and time '08:59' then
    for p in select id from profiles where status = 'Active' and role in ('admin', 'recops', 'recruiter') loop
      lines := ''; n := 0;
      select coalesce(string_agg('• ' || t.title || case when t.due_on < lagos::date then ' (overdue since ' || to_char(t.due_on, 'DD Mon') || ')' else ' (due today)' end, E'\n' order by t.due_on), ''), count(*)
        into lines, n from (select * from tasks where assigned_to = p.id and status = 'open' and due_on <= lagos::date order by due_on limit 8) t;
      select lines || coalesce(string_agg(E'\n• Feedback needed: ' || cd.name || ' (' || coalesce(i.round, 'interview') || ', ' || to_char(i.starts_at at time zone 'Africa/Lagos', 'DD Mon') || ')', ''), ''), n + count(*)
        into lines, n from interviews i join candidates cd on cd.id = i.candidate_id
        where coalesce(i.recruiter_id, i.created_by) = p.id and i.status = 'scheduled' and i.decision is null
          and i.starts_at between now() - interval '14 days' and now() - interval '2 hours';
      if n > 0 then
        perform push_update(p.id, 'reminder', 'Today: ' || n || ' thing' || case when n = 1 then '' else 's' end || ' to do', ltrim(lines, E'\n'),
          jsonb_build_object('page', 'todo'), 'daily:' || lagos::date);
      end if;
    end loop;
  end if;
end $$;
revoke all on function public.assistant_reminders() from public, anon, authenticated;
select cron.unschedule('harbor-assistant-reminders') where exists (select 1 from cron.job where jobname = 'harbor-assistant-reminders');
select cron.schedule('harbor-assistant-reminders', '*/5 * * * *', 'select public.assistant_reminders()');

-- ---------------------------------------------------------------- round-up and emails
-- Weekdays 17:30-18:55 Lagos (16:30-17:55 UTC): the assistant writes each person's round-up, 2 per call.
create or replace function public.call_assistant_roundup()
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.profiles p where p.status = 'Active' and p.role in ('admin','recops','recruiter')
             and coalesce(p.notification_prefs ->> 'assistRoundup', '') <> 'false' and coalesce(p.notification_prefs ->> 'assistUpdates', '') <> 'false'
             and not exists (select 1 from public.assistant_threads t where t.user_id = p.id and t.kind = 'roundup' and t.created_at > now() - interval '12 hours')) then
    perform net.http_post(
      url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/assistant',
      body := jsonb_build_object('action', 'roundup_next', 'max', 2),
      headers := jsonb_build_object('Content-Type', 'application/json',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
        'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
      timeout_milliseconds := 150000);
  end if;
end $$;
revoke all on function public.call_assistant_roundup() from public, anon, authenticated;
select cron.unschedule('harbor-assistant-roundup') where exists (select 1 from cron.job where jobname = 'harbor-assistant-roundup');
select cron.schedule('harbor-assistant-roundup', '30-55/5 16 * * 1-5', 'select public.call_assistant_roundup()');
select cron.unschedule('harbor-assistant-roundup-2') where exists (select 1 from cron.job where jobname = 'harbor-assistant-roundup-2');
select cron.schedule('harbor-assistant-roundup-2', '*/5 17 * * 1-5', 'select public.call_assistant_roundup()');

-- Every 5 minutes: email what people haven't seen in ProNext (assistant-updates function).
create or replace function public.call_assistant_update_emails()
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.assistant_updates where seen_at is null and emailed_at is null and email_ok
             and created_at < now() - interval '1 minute' and created_at > now() - interval '36 hours') then
    perform net.http_post(
      url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/assistant-updates',
      body := jsonb_build_object('action', 'email'),
      headers := jsonb_build_object('Content-Type', 'application/json',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
        'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
      timeout_milliseconds := 60000);
  end if;
end $$;
revoke all on function public.call_assistant_update_emails() from public, anon, authenticated;
select cron.unschedule('harbor-assistant-update-emails') where exists (select 1 from cron.job where jobname = 'harbor-assistant-update-emails');
select cron.schedule('harbor-assistant-update-emails', '2-59/5 * * * *', 'select public.call_assistant_update_emails()');

-- Tidy: updates older than 30 days go.
select cron.unschedule('harbor-assistant-updates-tidy') where exists (select 1 from cron.job where jobname = 'harbor-assistant-updates-tidy');
select cron.schedule('harbor-assistant-updates-tidy', '17 3 * * *', $$delete from public.assistant_updates where created_at < now() - interval '30 days'$$);
