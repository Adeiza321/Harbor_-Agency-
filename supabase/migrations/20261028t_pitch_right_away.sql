-- Pitches written straight away (28 Oct 2026), instead of on the next 10-minute run:
--   * when a candidate's blind resume is checked (or saved already checked), every lead waiting on
--     it gets its pitch;
--   * when a candidate on a pitch becomes ready (acknowledged / answered our questions), that lead.
-- The call goes out after the change is saved (pg_net), so saving isn't slowed down.
create or replace function public.call_sourcing_with(p_action text, p_body jsonb) returns bigint
language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/sourcing',
    body := coalesce(p_body, '{}'::jsonb) || jsonb_build_object('action', p_action),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 300000);
$$;
revoke all on function public.call_sourcing_with(text, jsonb) from public, anon, authenticated;

create or replace function public.candidates_blind_pitch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.blind_checked_at is not null and coalesce(new.blind_pages, 0) > 0
     and (old.blind_checked_at is distinct from new.blind_checked_at)
     and exists (select 1 from leads l where (l.status = 'awaiting' or (l.status = 'new' and l.pitch_body is null))
                   and l.matches @> jsonb_build_array(jsonb_build_object('candidate_id', new.id::text))) then
    perform call_sourcing_with('pitch_ready', jsonb_build_object('candidateId', new.id));
  end if;
  return new;
end $$;
drop trigger if exists candidates_blind_pitch on public.candidates;
create trigger candidates_blind_pitch after update of blind_checked_at on public.candidates
  for each row execute function public.candidates_blind_pitch();

create or replace function public.lead_offers_ready_pitch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'ready' and old.status is distinct from 'ready'
     and exists (select 1 from leads l where l.id = new.lead_id and (l.status = 'awaiting' or (l.status = 'new' and l.pitch_body is null))) then
    perform call_sourcing_with('pitch_ready', jsonb_build_object('leadId', new.lead_id));
  end if;
  return new;
end $$;
drop trigger if exists lead_offers_ready_pitch on public.lead_offers;
create trigger lead_offers_ready_pitch after update of status on public.lead_offers
  for each row execute function public.lead_offers_ready_pitch();
