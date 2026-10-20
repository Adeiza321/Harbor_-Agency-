-- "Ask for an update" on a job: Admin / Rec Ops email the recruiters engaged on a role asking how
-- sourcing is going and whether anything is in their way. Each recruiter answers from a one-time
-- link in the email (/?checkin=<code>, no sign-in needed) or on the job page; the answer shows
-- on the job and is emailed back to whoever asked. Written only by the job-checkin function.
create table if not exists public.job_checkins (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  recruiter_id uuid not null references public.profiles(id) on delete cascade,
  sent_by uuid references public.profiles(id) on delete set null,
  subject text not null,
  message text not null,
  token_hash text unique,
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  answered_at timestamptz,
  progress text check (progress in ('on_track', 'slow', 'stuck')),
  candidates_in_progress int,
  issues text,
  reply text,
  created_at timestamptz not null default now()
);
create index if not exists job_checkins_job_idx on public.job_checkins (job_id, sent_at desc);
create index if not exists job_checkins_recruiter_idx on public.job_checkins (recruiter_id, answered_at);
alter table public.job_checkins enable row level security;
-- Admin / Rec Ops see every update request; a recruiter sees only the ones sent to them.
drop policy if exists job_checkins_read on public.job_checkins;
create policy job_checkins_read on public.job_checkins for select to authenticated
  using (public.is_staff() or (recruiter_id = auth.uid() and public.app_role() is not null));
revoke insert, update, delete on public.job_checkins from anon, authenticated;
grant select on public.job_checkins to authenticated;

