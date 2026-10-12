-- Emails for X-ray results are found automatically: every 10 minutes the sourcing function looks
-- up the best X-ray people without an email (action "auto_emails": Apollo by LinkedIn profile for
-- fit >= outreach.xrayEmailMinFit, within outreach.xrayEmailsPerDay a day; GitHub public emails free)
-- and writes each one's usual draft. No approval step; the daily limit stands in for it.
--
-- A first version briefly ran as its own xray-emails function (12 lookups on 12 Oct); its markers are
-- moved to the ones sourcing uses (data.email_lookup.apollo, data.email_source) so nobody is looked up
-- twice. That function is no longer scheduled and can be deleted from the dashboard.

create or replace function public.call_xray_emails()
returns void language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/sourcing',
    body := jsonb_build_object('action', 'auto_emails'),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 300000);
$$;
revoke all on function public.call_xray_emails() from public, anon, authenticated;

select cron.unschedule('harbor-xray-emails') where exists (select 1 from cron.job where jobname = 'harbor-xray-emails');
select cron.schedule('harbor-xray-emails', '3-59/10 * * * *', 'select public.call_xray_emails()');

update public.prospects
set data = (data - 'emailLookup')
  || jsonb_build_object('email_lookup', coalesce(data->'email_lookup', '{}'::jsonb) || jsonb_build_object(
       case when data->'emailLookup'->>'by' = 'github' then 'github' else 'apollo' end, data->'emailLookup'->>'at'))
  || case when email is not null then jsonb_build_object('email_source', case when data->'emailLookup'->>'by' = 'github' then 'GitHub profile' else 'Apollo (from their LinkedIn profile)' end) else '{}'::jsonb end
where data ? 'emailLookup';
