-- Ready-made results that are slow to build (first use: the Apollo email tracking view, rebuilt by
-- apollo-sync every 15 minutes). Read and written only by edge functions with the service role.
create table if not exists public.app_cache (
  key text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.app_cache enable row level security;
revoke all on public.app_cache from anon, authenticated;
