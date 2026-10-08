-- Jobs board, Indeed style, and Google for Jobs: public_jobs() also returns each job's full
-- description and its SEO description (client name always swapped for "our client"), plus the
-- agency details Google needs for hiringOrganization. Used by the board and by the hourly page
-- build (scripts/build-job-pages.mjs) that writes /jobs/<code>/ pages, sitemap.xml and robots.txt.
create or replace function public.anon_client(p_text text, p_client text)
returns text language sql immutable set search_path to 'public' as $fn$
  select case when length(trim(coalesce(p_client, ''))) >= 2
    then regexp_replace(coalesce(p_text, ''), '\m' || regexp_replace(trim(p_client), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '(''s)?\M', 'our client', 'gi')
    else coalesce(p_text, '') end
$fn$;

create or replace function public.public_jobs()
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  select jsonb_build_object(
    'agency', coalesce(nullif(trim(max(s.agency_name)), ''), 'Pronext'),
    'legalName', coalesce(nullif(trim(max(s.company->>'legalName')), ''), nullif(trim(max(s.agency_name)), ''), 'Pronext'),
    'logoUrl', nullif(trim(max(s.company->>'logoUrl')), ''),
    'website', nullif(trim(max(s.company->>'website')), ''),
    'jobs', coalesce(jsonb_agg(jsonb_build_object(
      'slug', j.link_slug, 'title', j.role_title, 'location', j.location, 'workSetup', j.work_setup,
      'employmentType', j.employment_type, 'country', j.country, 'headcount', j.headcount, 'postedAt', j.created_at,
      'description', anon_client(j.description, j.client),
      'summary', left(regexp_replace(anon_client(j.description, j.client), '\s+', ' ', 'g'), 260),
      'metaDescription', nullif(anon_client(j.seo->>'meta_description', j.client), ''),
      'pay', case when coalesce((s.outreach->>'includePay')::boolean, false) and not coalesce(j.commission_only, false) and (j.min_pay is not null or j.max_pay is not null)
        then jsonb_build_object('min', j.min_pay, 'max', j.max_pay, 'currency', j.currency, 'period', j.salary_period) end,
      'commissionOnly', coalesce(j.commission_only, false)
    ) order by j.created_at desc) filter (where j.id is not null), '[]'::jsonb))
  from (select agency_name, outreach, company from agency_settings limit 1) s
  left join jobs j on j.status = 'Open' and j.link_slug is not null
$fn$;
grant execute on function public.public_jobs() to anon, authenticated;
