-- AI spend per person: every assistant answer logs its tokens and cost here (written only by edge
-- functions). Read by the recruiter audit (spend per hire, including AI spend).
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  feature text not null,                 -- 'assistant', later 'screening', 'sourcing'...
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_time on public.ai_usage (user_id, created_at desc);
alter table public.ai_usage enable row level security;
-- Your own usage; Admins see everyone's.
drop policy if exists ai_usage_read on public.ai_usage;
create policy ai_usage_read on public.ai_usage for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
