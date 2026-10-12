-- Jobs read "City, Country" on the candidate page too ("Kuala Lumpur, Malaysia"), matching the app's
-- jobPlace(): the country isn't repeated when the location already names it ("Lagos, Nigeria",
-- "Austin, TX, USA"), and a worldwide-remote role reads "Remote – worldwide".

create or replace function public.job_place(p_location text, p_country text)
returns text language sql immutable set search_path = public as $$
  with v as (select nullif(trim(coalesce(p_location, '')), '') as loc, nullif(trim(coalesce(p_country, '')), '') as c),
  w as (select loc, c, lower(coalesce(loc, '')) as low,
          case c when 'United States' then array['united states', 'usa', 'us', 'u.s.', 'united states of america']
                 when 'United Kingdom' then array['united kingdom', 'uk', 'u.k.', 'england', 'scotland', 'wales', 'great britain']
                 when 'United Arab Emirates' then array['united arab emirates', 'uae']
                 else array[lower(coalesce(c, ''))] end as names
        from v)
  select case
    when c is null then loc
    when c ~* '^remote.*worldwide' then case when loc is null then c when loc ~* 'remote|worldwide|anywhere' then loc else loc || ' · Remote' end
    when loc is null then c
    when exists (select 1 from unnest(names) n
                 where low ~ ('(^|[\s,(/-])' || regexp_replace(n, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g') || '($|[\s,)/-])')) then loc
    else loc || ', ' || c
  end
  from w
$$;

-- candidate_portal sends a job's location in three places (roles, matches, routed roles). Swap each
-- for city + country, editing the live definition so nothing else in it changes.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.candidate_portal(text)'::regprocedure);
  if position('''location'', j.location' in d) > 0 then
    d := replace(d, '''location'', j.location', '''location'', public.job_place(j.location, j.country)');
    execute d;
  end if;
end $$;
