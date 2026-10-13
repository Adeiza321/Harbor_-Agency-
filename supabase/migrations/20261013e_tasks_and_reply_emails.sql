-- 1. Workspace to-do list: personal tasks, and tasks an Admin / Rec Ops assigns to a recruiter.
--    status: open -> done (ticked off) or dismissed (no longer needed).
-- 2. Email to the staff member when a candidate replies in their chat (edge function
--    notify-staff, called by a trigger on each candidate message; it skips repeats within 10 minutes).

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 300),
  notes text check (notes is null or length(notes) <= 4000),
  assigned_to uuid not null references public.profiles(id) on delete cascade,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete set null,
  due_on date,
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  candidate_id uuid references public.candidates(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists tasks_assigned on public.tasks (assigned_to, status, due_on);
alter table public.tasks enable row level security;

-- See: your own tasks, ones you assigned, or all of them as Admin / Rec Ops.
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (assigned_to = (select auth.uid()) or created_by = (select auth.uid()) or (select public.is_staff()));
-- Add: for yourself; Admins and Rec Ops can assign to anyone.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (created_by = (select auth.uid()) and (assigned_to = (select auth.uid()) or (select public.is_staff())));
-- Change (tick off, dismiss, edit): the person it's for, whoever assigned it, or Admin / Rec Ops.
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (assigned_to = (select auth.uid()) or created_by = (select auth.uid()) or (select public.is_staff()))
  with check (assigned_to = (select auth.uid()) or created_by = (select auth.uid()) or (select public.is_staff()));
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (created_by = (select auth.uid()) or (select public.is_admin()));

-- Reply emails.
create or replace function public.notify_staff_of_reply()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.sender = 'candidate' and new.staff_id is not null then
    begin
      perform net.http_post(
        url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/notify-staff',
        body := jsonb_build_object('messageId', new.id),
        headers := jsonb_build_object('Content-Type', 'application/json',
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
          'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
          'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
        timeout_milliseconds := 30000);
    exception when others then null;  -- never block a candidate's message
    end;
  end if;
  return new;
end $$;
revoke all on function public.notify_staff_of_reply() from public, anon, authenticated;
drop trigger if exists candidate_job_messages_notify on public.candidate_job_messages;
create trigger candidate_job_messages_notify after insert on public.candidate_job_messages
  for each row execute function public.notify_staff_of_reply();
