-- Job views: someone who had a job page open for 10 seconds (tab visible) or scrolled halfway
-- down it. One per anonymous visitor (a code kept only for that browser tab), per job, per day.
-- No personal data. Shown under each job in Pronext with its application counts.

create table if not exists public.job_views (
  job_id uuid not null references public.jobs (id) on delete cascade,
  day date not null default current_date,
  visitor text not null,
  source text not null default 'direct',
  created_at timestamptz not null default now(),
  primary key (job_id, day, visitor)
);
alter table public.job_views enable row level security;   -- only the two functions below touch it

-- Called by the public job pages.
create or replace function public.record_job_view(p_slug text, p_visitor text, p_source text default 'direct')
returns void language plpgsql security definer set search_path = public as $$
declare jid uuid; today_count int;
begin
  if coalesce(p_visitor, '') !~ '^[A-Za-z0-9_-]{16,64}$' then return; end if;
  select id into jid from jobs where link_slug = p_slug and status in ('Open', 'On hold') limit 1;
  if jid is null then return; end if;
  -- A ceiling per job per day, so a script can't inflate the count without limit.
  select count(*) into today_count from job_views where job_id = jid and day = current_date;
  if today_count >= 5000 then return; end if;
  insert into job_views (job_id, visitor, source)
  values (jid, p_visitor, left(regexp_replace(lower(coalesce(p_source, 'direct')), '[^a-z0-9_-]', '', 'g'), 30))
  on conflict do nothing;
end $$;
revoke all on function public.record_job_view(text, text, text) from public;
grant execute on function public.record_job_view(text, text, text) to anon, authenticated;

-- For the dashboard: per job, views (all time and last 7 days) and applications. Staff only.
create or replace function public.job_view_stats()
returns table (job_id uuid, views bigint, views_7d bigint, applications bigint, referrals bigint)
language sql stable security definer set search_path = public as $$
  select j.id,
    (select count(*) from job_views v where v.job_id = j.id),
    (select count(*) from job_views v where v.job_id = j.id and v.day > current_date - 7),
    (select count(*) from applications a where a.job_id = j.id and coalesce(a.source, '') <> 'referral'),
    (select count(*) from applications a where a.job_id = j.id and a.source = 'referral')
  from jobs j
  where app_role() is not null
$$;
revoke all on function public.job_view_stats() from public;
grant execute on function public.job_view_stats() to authenticated;
