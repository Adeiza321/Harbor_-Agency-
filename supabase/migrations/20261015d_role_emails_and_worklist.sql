-- Role emails to recruiters (role-emails function) and "worklist first" for submissions.
--   1. A role going live (new, or Draft -> Open) and every later status change (On hold, Closed,
--      reopened) emails every active recruiter.
--   2. A role added to someone's worklist (job_recruiters row: they engaged, or Admin / Rec Ops
--      added them) emails that person.
--   3. Recruiters can only put a candidate forward for a role on their worklist (they must Engage
--      first). Admin and Rec Ops are not limited; applications and the server are not affected.

create or replace function public.post_role_email(payload jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/role-emails',
    body := payload,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 30000);
exception when others then null;  -- an email never blocks saving a job
end $$;
revoke all on function public.post_role_email(jsonb) from public, anon, authenticated;

create or replace function public.jobs_role_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'Open' then perform public.post_role_email(jsonb_build_object('kind', 'status', 'jobId', new.id, 'from', '', 'to', new.status)); end if;
  elsif new.status is distinct from old.status and new.status <> 'Draft' then
    perform public.post_role_email(jsonb_build_object('kind', 'status', 'jobId', new.id, 'from', coalesce(old.status, ''), 'to', new.status));
  end if;
  return new;
end $$;
revoke all on function public.jobs_role_email() from public, anon, authenticated;
drop trigger if exists jobs_role_email on public.jobs;
create trigger jobs_role_email after insert or update of status on public.jobs
  for each row execute function public.jobs_role_email();

create or replace function public.worklist_role_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.post_role_email(jsonb_build_object('kind', 'worklist', 'jobId', new.job_id, 'recruiterId', new.recruiter_id, 'actorId', auth.uid()));
  return new;
end $$;
revoke all on function public.worklist_role_email() from public, anon, authenticated;
drop trigger if exists job_recruiters_role_email on public.job_recruiters;
create trigger job_recruiters_role_email after insert on public.job_recruiters
  for each row execute function public.worklist_role_email();

-- Worklist first: a recruiter's own candidate can only be put forward for a role they're engaged on.
drop policy if exists cj_write on public.candidate_jobs;
create policy cj_write on public.candidate_jobs for insert to authenticated with check (
  (select public.is_staff())
  or (
    exists (select 1 from public.candidates c where c.id = candidate_jobs.candidate_id and c.recruiter_id = (select auth.uid()))
    and exists (select 1 from public.job_recruiters jr where jr.job_id = candidate_jobs.job_id and jr.recruiter_id = (select auth.uid()))
  )
);
