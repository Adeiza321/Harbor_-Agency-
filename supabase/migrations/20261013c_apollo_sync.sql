-- Apollo -> ProNext: replies, unsubscribes and bounces on emails sent through Apollo sequences
-- (edge function apollo-sync, every 15 minutes).
--   apollo_events   one row per Apollo event already handled, so each is applied once and a
--                   recruiter's later change to a prospect or lead is never undone by a re-sync.

create table if not exists public.apollo_events (
  id text primary key,                 -- <Apollo email id>:<reply | unsubscribed | bounced>
  kind text not null check (kind in ('reply', 'unsubscribed', 'bounced')),
  reply_class text,                    -- Apollo's reading of the reply: willing_to_meet, not_interested...
  contact_id text,
  email text,
  sequence_id text,
  at timestamptz,
  prospect_id uuid references public.prospects(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  status_change text,                  -- e.g. 'prospect:interested', when the status moved
  created_at timestamptz not null default now()
);
create index if not exists apollo_events_created on public.apollo_events (created_at desc);
alter table public.apollo_events enable row level security;
-- Staff can see what came back (for the outreach page); only the function writes.
drop policy if exists apollo_events_staff_read on public.apollo_events;
create policy apollo_events_staff_read on public.apollo_events for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.status = 'Active'));

create or replace function public.call_apollo_sync()
returns bigint language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/apollo-sync',
    body := jsonb_build_object('action', 'sync'),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 120000);
$$;
revoke all on function public.call_apollo_sync() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'harbor-apollo-sync') then
    perform cron.schedule('harbor-apollo-sync', '11-59/15 * * * *', 'select public.call_apollo_sync()');
  end if;
end $$;
