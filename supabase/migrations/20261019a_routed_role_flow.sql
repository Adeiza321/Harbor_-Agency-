-- Routed roles on the candidate page (see CandidatePortal / RoutedRoleCard in app.jsx):
-- 1) candidate_role: the full job description and facts for one role a candidate has been put
--    forward for, read with their own candidate-page token (no login). Only their own links.
create or replace function public.candidate_role(p_token text, p_link_id uuid)
returns jsonb language sql stable security definer
set search_path to 'public' as $$
  select jsonb_build_object(
    'linkId', l.id, 'role', j.role_title, 'company', j.client, 'location', j.location, 'country', j.country,
    'workSetup', j.work_setup, 'employmentType', j.employment_type, 'minPay', j.min_pay, 'maxPay', j.max_pay,
    'currency', j.currency, 'salaryPeriod', j.salary_period, 'commissionOnly', coalesce(j.commission_only, false),
    'description', j.description, 'jobStatus', j.status, 'response', l.candidate_response)
  from candidates c
  join candidate_jobs l on l.candidate_id = c.id and l.id = p_link_id
  join jobs j on j.id = l.job_id
  where length(coalesce(p_token, '')) >= 12 and c.portal_token = p_token
$$;
revoke all on function public.candidate_role(text, uuid) from public;
grant execute on function public.candidate_role(text, uuid) to anon, authenticated;

-- 2) Reminders for a role a candidate hasn't answered yet: at most two (24 hours after routing,
--    then 3 days after the first), sent by send-message (action route_reminders, ops token).
alter table public.candidate_jobs add column if not exists route_reminders int not null default 0;
alter table public.candidate_jobs add column if not exists route_reminded_at timestamptz;

create or replace function public.call_route_reminders()
returns bigint language sql security definer set search_path to 'public', 'extensions' as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/send-message',
    body := jsonb_build_object('action', 'route_reminders'),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 120000);
$$;
revoke all on function public.call_route_reminders() from public, anon, authenticated;
-- Every hour at :23 (cron.schedule replaces a job with the same name).
select cron.schedule('harbor-route-reminders', '23 * * * *', 'select public.call_route_reminders()');
