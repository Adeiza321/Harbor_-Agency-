-- Talent pool: when a role closes, everyone sourced for it (X-ray and Apollo, emailed or not) is
-- archived into the talent pool, except people who opted out (unsubscribed, bounced) and people who
-- already became ProNext candidates (converted). Emails still waiting to send are cancelled, and
-- anyone in an Apollo sequence is marked finished there, so no follow-ups go out.
-- Pooled people come back on their own when a new role fits them (sourcing/pool.ts): they reappear
-- under that job as "Needs approval" with a fresh draft. They're kept for 12 months after the role
-- closed (sourcing cleanup), then deleted.
-- Reopening a closed role puts its people back where they were (emails that were waiting go back
-- to "Needs approval"; Apollo sequences that were stopped stay stopped).

alter table public.prospects drop constraint if exists prospects_status_check;
alter table public.prospects add constraint prospects_status_check check (status = any (array[
  'found', 'approved', 'queued', 'contacted', 'interested', 'not_interested', 'unsubscribed', 'bounced', 'rejected', 'converted', 'archived']));
alter table public.prospects add column if not exists archived_at timestamptz;
create index if not exists prospects_pool_idx on public.prospects (archived_at desc) where status = 'archived';

create or replace function public.archive_job_prospects()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'Closed' and old.status is distinct from 'Closed' then
    update public.outreach_messages set status = 'skipped', error = 'Role closed'
    where status = 'queued' and prospect_id in (select id from public.prospects where job_id = new.id);
    update public.prospects
    set status = 'archived', archived_at = now(),
        data = coalesce(data, '{}'::jsonb) || jsonb_build_object('archived_from', status, 'archived_role', new.role_title)
    where job_id = new.id and status not in ('unsubscribed', 'bounced', 'converted', 'archived');
  elsif old.status = 'Closed' and new.status is distinct from 'Closed' then
    update public.prospects
    set status = case coalesce(data->>'archived_from', 'found') when 'approved' then 'found' when 'queued' then 'found' else coalesce(data->>'archived_from', 'found') end,
        archived_at = null, data = data - 'archived_from' - 'archived_role'
    where job_id = new.id and status = 'archived';
  end if;
  return new;
end $$;
revoke all on function public.archive_job_prospects() from public, anon, authenticated;

drop trigger if exists jobs_archive_prospects on public.jobs;
create trigger jobs_archive_prospects after update of status on public.jobs
  for each row execute function public.archive_job_prospects();

-- Archiving also finishes the person's Apollo sequence (same as applying, saying no, unsubscribing).
create or replace function public.stop_apollo_followups()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_ids text[];
  v_kind text := case when tg_table_name = 'leads' then 'client' else 'candidate' end;
  v_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status then return new; end if;
    if tg_table_name = 'prospects' and new.status not in ('interested', 'not_interested', 'unsubscribed', 'bounced', 'rejected', 'converted', 'archived') then return new; end if;
    if tg_table_name = 'leads' and new.status not in ('replied', 'meeting', 'won', 'lost', 'unsubscribed', 'ignored') then return new; end if;
  end if;

  select array_agg(distinct m.provider_ref) into v_ids
  from public.outreach_messages m
  where m.provider = 'apollo' and m.status = 'sent' and coalesce(m.provider_ref, '') <> ''
    and ((tg_table_name = 'prospects' and m.prospect_id = v_id) or (tg_table_name = 'leads' and m.lead_id = v_id));

  if v_ids is not null and array_length(v_ids, 1) > 0 then
    perform net.http_post(
      url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/sourcing',
      body := jsonb_build_object('action', 'apollo_stop', 'kind', v_kind, 'contactIds', to_jsonb(v_ids)),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
        'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
      timeout_milliseconds := 60000);
  end if;

  return case when tg_op = 'DELETE' then old else new end;
exception when others then
  -- Never block the status change itself; the sequence just keeps running.
  raise warning 'stop_apollo_followups: %', sqlerrm;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Roles closed before this change: their sourced people go into the pool now.
update public.outreach_messages set status = 'skipped', error = 'Role closed'
where status = 'queued' and prospect_id in (select p.id from public.prospects p join public.jobs j on j.id = p.job_id where j.status = 'Closed');
update public.prospects p
set status = 'archived', archived_at = now(),
    data = coalesce(p.data, '{}'::jsonb) || jsonb_build_object('archived_from', p.status, 'archived_role', j.role_title)
from public.jobs j
where j.id = p.job_id and j.status = 'Closed' and p.status not in ('unsubscribed', 'bounced', 'converted', 'archived');
