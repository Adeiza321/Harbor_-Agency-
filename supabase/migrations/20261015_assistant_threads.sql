-- Saved assistant conversations: each person's own (row security), newest first. Messages are kept
-- as the chat shows them (text plus the action cards and whether they were approved).
create table if not exists public.assistant_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null default 'New conversation',
  mode text not null default 'work' check (mode in ('work', 'brainstorm')),
  messages jsonb not null default '[]'::jsonb,
  job_id uuid references public.jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assistant_threads_user_idx on public.assistant_threads(user_id, updated_at desc);
create index if not exists assistant_threads_job_idx on public.assistant_threads(job_id);
alter table public.assistant_threads enable row level security;
create policy assistant_threads_own_select on public.assistant_threads for select to authenticated using (user_id = (select auth.uid()));
create policy assistant_threads_own_insert on public.assistant_threads for insert to authenticated with check (user_id = (select auth.uid()));
create policy assistant_threads_own_update on public.assistant_threads for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy assistant_threads_own_delete on public.assistant_threads for delete to authenticated using (user_id = (select auth.uid()));
