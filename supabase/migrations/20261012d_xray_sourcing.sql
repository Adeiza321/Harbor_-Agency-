-- X-ray sourcing: public profiles found through free search engines (LinkedIn X-ray, GitHub and
-- technical sites), reviewed by the AI against the job and saved as prospects next to Apollo's.
--   * jobs.xray      the job's last X-ray run (kept apart from jobs.sourcing so the Apollo step
--                    and the X-ray step never overwrite each other)
--   * search_usage   how many searches each free engine has used this day / month / ever, so
--                    ProNext stops before any free allowance runs out (nothing is ever charged)
-- Written without drops or data updates so it can go through apply_migration.

alter table public.jobs add column if not exists xray jsonb;

create table if not exists public.search_usage (
  provider text not null,
  period text not null,          -- '2026-10-12' (daily), '2026-10' (monthly) or 'total' (one-time allowance)
  used int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (provider, period)
);
alter table public.search_usage enable row level security;
-- Staff can see the counters (Outreach > Setup); only the server changes them.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'search_usage' and policyname = 'search_usage_staff_read') then
    create policy search_usage_staff_read on public.search_usage for select to authenticated
      using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'recops') and p.status = 'Active'));
  end if;
end $$;

-- Takes one search from an engine's allowance. Returns false (and uses nothing) once the limit is reached.
create or replace function public.use_search_quota(p_provider text, p_period text, p_limit int)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  if p_limit is null or p_limit <= 0 then return false; end if;
  insert into public.search_usage as u (provider, period, used) values (p_provider, p_period, 1)
  on conflict (provider, period) do update set used = u.used + 1, updated_at = now()
    where u.used < p_limit
  returning true into ok;
  return coalesce(ok, false);
end $$;
revoke all on function public.use_search_quota(text, text, int) from public, anon, authenticated;
grant execute on function public.use_search_quota(text, text, int) to service_role;
