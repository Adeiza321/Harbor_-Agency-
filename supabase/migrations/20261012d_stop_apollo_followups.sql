-- Stop Apollo follow-ups when a conversation is over.
-- Pronext adds each emailed person to an Apollo sequence (first email + follow-ups). When the
-- person applies, says no, unsubscribes, bounces, is skipped or converted, or asks to be deleted
-- (or a client lead replies, books a meeting, is won/lost or unsubscribes), the sourcing function
-- is told their Apollo contact ids and marks them "finished" in the sequence, so no more
-- follow-ups go out. Works for every route: public links, applications and recruiters' own
-- status changes in the app.

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
    if tg_table_name = 'prospects' and new.status not in ('interested', 'not_interested', 'unsubscribed', 'bounced', 'rejected', 'converted') then return new; end if;
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

revoke all on function public.stop_apollo_followups() from public, anon, authenticated;

create or replace trigger prospects_stop_apollo
  after update of status on public.prospects
  for each row execute function public.stop_apollo_followups();

-- Before delete: the sent messages (and their Apollo contact ids) are removed with the prospect.
create or replace trigger prospects_stop_apollo_delete
  before delete on public.prospects
  for each row execute function public.stop_apollo_followups();

create or replace trigger leads_stop_apollo
  after update of status on public.leads
  for each row execute function public.stop_apollo_followups();

create or replace trigger leads_stop_apollo_delete
  before delete on public.leads
  for each row execute function public.stop_apollo_followups();
