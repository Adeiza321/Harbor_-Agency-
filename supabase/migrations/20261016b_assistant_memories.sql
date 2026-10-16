-- The assistant's memory (supabase/functions/assistant/memory.ts): what it has learned working with
-- each person (scope 'personal') and what Admins and Rec Ops taught it for everyone (scope 'team'),
-- plus suggestions a person declined (kind 'declined'). Written by the assistant function; people
-- see and delete their own (and staff the team's) in the assistant panel's Memory view.
create table if not exists public.assistant_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  scope text not null default 'personal' check (scope in ('personal', 'team')),
  kind text not null default 'note',
  text text not null,
  source text not null default 'learned',
  thread_id uuid references public.assistant_threads(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assistant_memories_user_idx on public.assistant_memories(user_id, active, created_at desc);
create index if not exists assistant_memories_team_idx on public.assistant_memories(scope, active, created_at desc);
create index if not exists assistant_memories_thread_idx on public.assistant_memories(thread_id);
alter table public.assistant_memories enable row level security;
create policy assistant_memories_read on public.assistant_memories for select to authenticated
  using (user_id = (select auth.uid()) or (scope = 'team' and (select public.app_role()) is not null));
create policy assistant_memories_update on public.assistant_memories for update to authenticated
  using (user_id = (select auth.uid()) or (scope = 'team' and (select public.is_staff())))
  with check (user_id = (select auth.uid()) or (scope = 'team' and (select public.is_staff())));
