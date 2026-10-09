-- Welcome email for new staff: a one-time "Set your password" link instead of a shared password.
-- Only a SHA-256 of the link code is stored; links expire after 72 hours and work once.
create table if not exists public.account_setup_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists account_setup_tokens_user_idx on public.account_setup_tokens(user_id);
create index if not exists account_setup_tokens_created_by_idx on public.account_setup_tokens(created_by);
-- Only the edge functions (service role) touch this table.
alter table public.account_setup_tokens enable row level security;

alter table public.profiles add column if not exists welcome_sent_at timestamptz;
