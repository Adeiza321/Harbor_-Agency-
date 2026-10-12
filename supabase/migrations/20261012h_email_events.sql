-- Email tracking stored in ProNext instead of re-reading Brevo on every page load.
--   email_events     one row per Brevo event (sent, delivered, opened, clicked, bounced...), kept
--                    for a year. Filled two ways:
--                      1. Brevo's transactional webhook pushes each event as it happens
--                         (edge function brevo-webhook, checked against the token below);
--                      2. a catch-up every 15 minutes asks Brevo only for events since the newest
--                         one stored (email-tracking, action "sync"), so a missed webhook is filled in.
--   The Email tracking page reads this table, so it loads instantly and keeps history Brevo drops.

create table if not exists public.email_events (
  id bigint generated always as identity primary key,
  dedupe text not null unique,               -- message|event|minute|link: the same event from webhook and sync is stored once
  message_id text,
  email text not null,
  event text not null,                       -- request, delivered, opened, unique_opened, proxy_open, click, hard_bounce,
                                             -- soft_bounce, blocked, invalid, deferred, spam, unsubscribed, error
  subject text,
  tag text,
  link text,
  reason text,
  at timestamptz not null,
  source text not null default 'sync',       -- 'webhook' | 'sync'
  created_at timestamptz not null default now()
);
create index if not exists email_events_at on public.email_events (at desc);
create index if not exists email_events_msg on public.email_events (message_id);
alter table public.email_events enable row level security;  -- no policies: only the edge functions (service role) read and write it

-- The secret part of the webhook address given to Brevo.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'brevo_webhook_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'brevo_webhook_token', 'Token in the Brevo webhook URL (brevo-webhook function)');
  end if;
end $$;

create or replace function public.check_brevo_webhook(p_token text)
returns boolean language sql security definer set search_path = public, extensions as $$
  select coalesce(length(p_token) >= 32 and p_token = (select decrypted_secret from vault.decrypted_secrets where name = 'brevo_webhook_token' limit 1), false);
$$;
revoke all on function public.check_brevo_webhook(text) from public, anon, authenticated;
grant execute on function public.check_brevo_webhook(text) to service_role;

-- Catch-up sync, every 15 minutes.
create or replace function public.call_email_tracking_sync()
returns bigint language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/email-tracking',
    body := jsonb_build_object('action', 'sync'),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 120000);
$$;
revoke all on function public.call_email_tracking_sync() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'harbor-email-events-sync') then
    perform cron.schedule('harbor-email-events-sync', '7-59/15 * * * *', 'select public.call_email_tracking_sync()');
  end if;
end $$;
