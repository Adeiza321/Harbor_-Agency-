-- Two-factor once per browser, then again after 30 days. After someone enters their code, that
-- browser is remembered (trusted_devices, only a hash of its secret is kept). Signing in again on it
-- within 30 days of the code needs only the password: the trust-device function vouches for the new
-- session (trusted_sessions), and app_role() accepts it like a full two-factor session.
-- A new browser, cleared browser data, an Admin turning two-factor off, or 30 days passing all mean
-- the code is asked for again. Neither table can be read or written from the app directly.
create table if not exists public.trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  last_used_at timestamptz
);
create index if not exists trusted_devices_user_idx on public.trusted_devices (user_id);
create table if not exists public.trusted_sessions (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.trusted_devices(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists trusted_sessions_user_idx on public.trusted_sessions (user_id);
alter table public.trusted_devices enable row level security;
alter table public.trusted_sessions enable row level security;
revoke all on public.trusted_devices from anon, authenticated;
revoke all on public.trusted_sessions from anon, authenticated;

create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select p.role from public.profiles p
   where p.id = auth.uid() and p.status = 'Active'
     and (coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
          or not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified')
          or exists (select 1 from public.trusted_sessions t
                      where t.session_id::text = auth.jwt() ->> 'session_id' and t.user_id = p.id and t.expires_at > now()))
$$;

-- Removing someone's two-factor (an Admin, or them turning it off) forgets their trusted browsers too.
create or replace function public.forget_trusted_on_factor_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from auth.mfa_factors f where f.user_id = old.user_id and f.status = 'verified' and f.id <> old.id) then
    delete from public.trusted_devices where user_id = old.user_id;
    delete from public.trusted_sessions where user_id = old.user_id;
  end if;
  return old;
end $$;
revoke all on function public.forget_trusted_on_factor_delete() from public, anon, authenticated;
drop trigger if exists forget_trusted_on_factor_delete on auth.mfa_factors;
create trigger forget_trusted_on_factor_delete after delete on auth.mfa_factors
  for each row execute function public.forget_trusted_on_factor_delete();
