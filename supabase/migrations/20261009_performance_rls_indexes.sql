-- Faster queries as the data grows.
-- 1. Access rules (RLS) called auth.uid(), is_staff() and app_role() once per row. Wrapped in
--    (select ...), Postgres works each one out once per query instead. Same rules, same results.
-- 2. Every foreign key gets an index on its columns, so lookups by candidate, job, recruiter etc.
--    (and deletes of the parent row) don't scan the whole table.

do $$
declare
  r record;
  q text;
  c text;
  stmt text;
  wrap constant text[] := array['auth.uid()', 'auth.jwt()', 'auth.role()', 'is_staff()', 'app_role()', 'is_admin()'];
  f text;
begin
  for r in
    select tablename, policyname, qual, with_check from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') || coalesce(with_check, '')) ~ '(auth\.(uid|jwt|role)|is_staff|app_role|is_admin)\(\)'
  loop
    q := r.qual; c := r.with_check;
    foreach f in array wrap loop
      -- Leave calls that are already wrapped as they are.
      q := replace(replace(q, '(SELECT ' || f, chr(1)), f, '(select ' || f || ')');
      q := replace(q, chr(1), '(SELECT ' || f);
      c := replace(replace(c, '(SELECT ' || f, chr(1)), f, '(select ' || f || ')');
      c := replace(c, chr(1), '(SELECT ' || f);
    end loop;
    stmt := format('alter policy %I on public.%I', r.policyname, r.tablename);
    if q is not null then stmt := stmt || ' using (' || q || ')'; end if;
    if c is not null then stmt := stmt || ' with check (' || c || ')'; end if;
    execute stmt;
  end loop;
end $$;

do $$
declare
  r record;
begin
  for r in
    select con.conrelid::regclass as tbl, cl.relname as tblname, con.conname,
           string_agg(quote_ident(a.attname), ', ' order by k.ord) as cols
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
    where con.contype = 'f' and n.nspname = 'public'
      and not exists (
        select 1 from pg_index i
        where i.indrelid = con.conrelid
          and (i.indkey::int2[])[0:array_length(con.conkey, 1) - 1] = con.conkey
      )
    group by con.conrelid, cl.relname, con.conname
  loop
    execute format('create index if not exists %I on %s (%s)', left(r.conname || '_idx', 63), r.tbl, r.cols);
  end loop;
end $$;
