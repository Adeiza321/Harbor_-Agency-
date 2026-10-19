-- Share window (app.jsx PromoteModal): views and applications for one job, per platform.
-- Views come from job_views.source (the ?utm_source=<platform> on shared links), applications
-- from applications.source (the apply page sends the platform). Staff only.
create or replace function public.job_share_stats(p_job uuid)
returns table(source text, views bigint, applications bigint)
language sql stable security definer set search_path to 'public' as $$
  with v as (select source, count(*) n from job_views where job_id = p_job group by source),
       a as (select source, count(*) n from applications where job_id = p_job group by source)
  select coalesce(v.source, a.source), coalesce(v.n, 0), coalesce(a.n, 0)
  from v full join a on a.source = v.source
  where app_role() is not null
$$;
revoke all on function public.job_share_stats(uuid) from public, anon;
grant execute on function public.job_share_stats(uuid) to authenticated;
