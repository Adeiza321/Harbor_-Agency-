-- Morning brief: on weekday mornings each active person gets a saved assistant conversation
-- (kind 'brief') with what changed, the roles closest to a hire and the actions to approve today.
-- The cron calls the assistant function (ops token) only while someone still has no brief; it does
-- 2 people per call. seen_at marks a brief as opened (it's shown first until then).
alter table public.assistant_threads add column if not exists kind text not null default 'chat';
alter table public.assistant_threads add column if not exists seen_at timestamptz;
create index if not exists assistant_threads_kind_idx on public.assistant_threads(kind, created_at desc);

create or replace function public.call_assistant_brief()
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.profiles p where p.status = 'Active' and p.role in ('admin','recops','recruiter')
             and not exists (select 1 from public.assistant_threads t where t.user_id = p.id and t.kind = 'brief' and t.created_at > now() - interval '20 hours')) then
    perform net.http_post(
      url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/assistant',
      body := jsonb_build_object('action', 'brief_next', 'max', 2),
      headers := jsonb_build_object('Content-Type', 'application/json',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
        'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
      timeout_milliseconds := 150000);
  end if;
end $$;
revoke all on function public.call_assistant_brief() from public, anon, authenticated;

-- Weekdays 06:45-08:55 Lagos (05:45-07:55 UTC), every 5 minutes.
select cron.schedule('harbor-morning-brief', '45,50,55 5 * * 1-5', 'select public.call_assistant_brief()');
select cron.schedule('harbor-morning-brief-2', '*/5 6-7 * * 1-5', 'select public.call_assistant_brief()');
