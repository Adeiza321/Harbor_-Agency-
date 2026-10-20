-- Recruiters' own X-ray sourcing.
--   * prospects.sourced_by: who started the search that found the person (null for automatic runs).
--     Within one role a person is only ever found once (job_id + profile), so whoever finds them first
--     keeps them: later searches by anyone skip people already found for that role.
--   * Recruiters see only the people they found, without emails or phone numbers
--     (my_sourced_prospects), and can only open the profile, mark that they connected on LinkedIn,
--     or say the person is interested. Admins and Rec Ops see everything (prospects_staff).
--   * When someone a recruiter found becomes interested (their "I'm interested" click, applying, or the
--     recruiter marking it), the sourcing function makes them that recruiter's candidate on the role.
--   * xray_requests: a recruiter's search waits here while another search runs on the same role, and
--     starts by itself when that one finishes.
alter table public.prospects add column if not exists sourced_by uuid references public.profiles(id) on delete set null;
create index if not exists prospects_sourced_by_idx on public.prospects (job_id, sourced_by);

create table if not exists public.xray_requests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  found int,
  error text
);
create unique index if not exists xray_requests_one_open on public.xray_requests (job_id, requested_by) where finished_at is null;
alter table public.xray_requests enable row level security;
drop policy if exists xray_requests_read on public.xray_requests;
create policy xray_requests_read on public.xray_requests for select to authenticated
  using (public.is_staff() or (requested_by = auth.uid() and public.app_role() is not null));
revoke insert, update, delete on public.xray_requests from anon, authenticated;
grant select on public.xray_requests to authenticated;

-- The people this recruiter found for a role: everything they need to judge and connect, nothing to contact them with.
create or replace function public.my_sourced_prospects(p_job uuid)
returns table (id uuid, full_name text, title text, company text, location text, profile_url text, source text, fit int, verdict text,
  summary text, checklist jsonb, gaps jsonb, status text, connected_at text, candidate_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, coalesce(p.full_name, trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))), p.title, p.company, p.location,
         coalesce(p.data->>'profile_url', p.linkedin_url), p.source, p.fit, p.verdict,
         coalesce(p.data->>'overview', p.fit_reason), coalesce(p.data->'checklist', '[]'::jsonb), coalesce(p.data->'gaps', '[]'::jsonb),
         p.status, p.data->'linkedin_connected'->>'at', p.candidate_id, p.created_at
    from public.prospects p
   where p.job_id = p_job and p.sourced_by = auth.uid() and public.app_role() is not null
   order by p.fit desc nulls last, p.created_at desc
   limit 300
$$;
revoke all on function public.my_sourced_prospects(uuid) from public, anon;
grant execute on function public.my_sourced_prospects(uuid) to authenticated;

-- "Mark connected" (or undo) on someone you found.
create or replace function public.prospect_mark_connected(p_id uuid, p_on boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() is null then raise exception 'Your account is not active.'; end if;
  update public.prospects
     set data = case when p_on then coalesce(data, '{}'::jsonb) || jsonb_build_object('linkedin_connected', jsonb_build_object('by', auth.uid(), 'at', now()))
                     else coalesce(data, '{}'::jsonb) - 'linkedin_connected' end,
         updated_at = now()
   where id = p_id and (sourced_by = auth.uid() or public.is_staff());
  if not found then raise exception 'You can only update people you found.'; end if;
end $$;
revoke all on function public.prospect_mark_connected(uuid, boolean) from public, anon;
grant execute on function public.prospect_mark_connected(uuid, boolean) to authenticated;

-- "Interested": the person said yes on LinkedIn. They become the recruiter's candidate (trigger below).
create or replace function public.prospect_mark_interested(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() is null then raise exception 'Your account is not active.'; end if;
  update public.prospects set status = 'interested', updated_at = now()
   where id = p_id and (sourced_by = auth.uid() or public.is_staff()) and status in ('found', 'approved', 'queued', 'contacted');
  if not found then raise exception 'This person is already interested or was moved on. Refresh the page.'; end if;
end $$;
revoke all on function public.prospect_mark_interested(uuid) from public, anon;
grant execute on function public.prospect_mark_interested(uuid) to authenticated;

-- Someone a recruiter found is now interested: the sourcing function makes them that recruiter's candidate.
create or replace function public.prospects_sourced_interest()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status = 'interested' and old.status is distinct from 'interested' and new.sourced_by is not null and new.candidate_id is null then
    begin
      perform net.http_post(
        url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/sourcing',
        body := jsonb_build_object('action', 'sourced_interest', 'prospectId', new.id),
        headers := jsonb_build_object('Content-Type', 'application/json',
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
          'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
          'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
        timeout_milliseconds := 30000);
    exception when others then null; -- never blocks saving the prospect; the sweep in the tick picks it up
    end;
  end if;
  return new;
end $$;
revoke all on function public.prospects_sourced_interest() from public, anon, authenticated;
drop trigger if exists prospects_sourced_interest on public.prospects;
create trigger prospects_sourced_interest after update of status on public.prospects
  for each row execute function public.prospects_sourced_interest();
