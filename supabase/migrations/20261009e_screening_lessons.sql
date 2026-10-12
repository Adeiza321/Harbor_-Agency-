-- Screening lessons: what recruiters teach the AI when they correct a screening result.
-- Applied live on 9 Oct 2026 (migration 20261009143410); recovered into the repo from Supabase.
create table if not exists public.screening_lessons (
  id uuid primary key default gen_random_uuid(),
  source_link_id uuid unique references public.candidate_jobs(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  client text not null default '',
  role_title text not null default '',
  role_titles text[] not null default '{}',
  scope text not null default 'client' check (scope in ('client', 'role')),
  reason text,
  feedback text,
  lesson text not null,
  look_for text not null default '',
  question text not null default '',
  candidate_name text,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists screening_lessons_job_idx on public.screening_lessons(job_id);
create index if not exists screening_lessons_created_by_idx on public.screening_lessons(created_by);
create index if not exists screening_lessons_client_idx on public.screening_lessons(lower(client));

alter table public.screening_lessons enable row level security;
create policy screening_lessons_read on public.screening_lessons for select to authenticated using ((select app_role()) is not null);
create policy screening_lessons_update on public.screening_lessons for update to authenticated using ((select is_staff())) with check ((select is_staff()));
create policy screening_lessons_delete on public.screening_lessons for delete to authenticated using ((select is_staff()));
