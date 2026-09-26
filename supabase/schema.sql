-- =====================================================================
-- HARBOR: Supabase schema
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Roles: admin, recops, recruiter. Security is enforced by the database
-- (row-level security), so hiding things in the app is not what protects data.
-- =====================================================================

-- ---------- Profiles (one per login) ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  role text not null default 'recruiter' check (role in ('admin','recops','recruiter')),
  level text not null default 'Recruiter',
  status text not null default 'Active' check (status in ('Active','Invited','Disabled')),
  created_at timestamptz not null default now()
);

-- Role comes from app_metadata (only settable server-side), never from user-editable metadata.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, coalesce(new.email,''), coalesce(new.raw_user_meta_data->>'full_name',''),
          coalesce(new.raw_app_meta_data->>'role','recruiter'));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and status <> 'Disabled'
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() in ('admin','recops'), false)
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() = 'admin', false)
$$;

-- ---------- Candidates ----------
create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role_title text not null default 'Unspecified',
  location text not null default '',
  recruiter_id uuid references public.profiles(id) on delete set null,
  status text not null default 'In review'
    check (status in ('In review','With client','Interview','Active file','Placed','Rejected')),
  ai_score int check (ai_score between 0 and 100),
  email text,
  email_verified boolean not null default false,
  opens int not null default 0,
  experience text, notice text, pay text,
  skills text[] not null default '{}',
  strengths text[] not null default '{}',
  gaps text[] not null default '{}',
  screening jsonb not null default '{"state":"pending"}',
  matches jsonb not null default '[]',
  source text,
  portal_token text unique not null default substr(replace(gen_random_uuid()::text,'-',''),1,12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.candidates (recruiter_id);
create index on public.candidates (status);

create table public.candidate_endorsements (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  company text not null, role_title text not null,
  status text not null default 'With client', next_step text,
  endorsed_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create table public.candidate_comments (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  author_id uuid not null references public.profiles(id) default auth.uid(),
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);
create table public.candidate_timeline (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  title text not null, done boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- Jobs ----------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  role_title text not null, client text not null,
  location text, min_pay numeric, max_pay numeric, description text,
  status text not null default 'Open' check (status in ('Draft','Open','Engaged','Closing','Closed')),
  link_slug text unique not null default substr(replace(gen_random_uuid()::text,'-',''),1,8),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  -- Recruiter-authored screening questions, set when the job is posted. Shown to any
  -- recruiter working the job (so they can copy them straight to a candidate) and
  -- answered per-candidate on candidate_jobs.screening_answers below.
  screening_questions jsonb not null default '[]'::jsonb
);
create table public.job_recruiters (
  job_id uuid references public.jobs(id) on delete cascade,
  recruiter_id uuid references public.profiles(id) on delete cascade,
  primary key (job_id, recruiter_id)
);

-- Engage/disengage log: one row per engagement, closed out with disengaged_at + a
-- reason when the recruiter steps back from the job. Duration and history are
-- derived from this table; job_recruiters stays the simple "currently on it" list.
create table public.job_engagements (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  recruiter_id uuid not null references public.profiles(id),
  engaged_at timestamptz not null default now(),
  disengaged_at timestamptz,
  reason text,
  created_at timestamptz not null default now()
);
create index job_engagements_job_idx on public.job_engagements(job_id);
create index job_engagements_recruiter_idx on public.job_engagements(recruiter_id);
alter table public.job_engagements enable row level security;
create policy jeng_read on public.job_engagements for select to authenticated
  using (public.is_staff() or recruiter_id = auth.uid());
create policy jeng_insert on public.job_engagements for insert to authenticated
  with check (recruiter_id = auth.uid());
create policy jeng_update on public.job_engagements for update to authenticated
  using (recruiter_id = auth.uid() or public.is_staff())
  with check (recruiter_id = auth.uid() or public.is_staff());

-- ---------- Inbox (unassigned applications) ----------
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  name text not null, role_title text not null, source text,
  ai_score int, assigned_to uuid references public.profiles(id),
  candidate_id uuid references public.candidates(id),
  created_at timestamptz not null default now()
);

-- ---------- Billing ----------
create table public.placements (
  id uuid primary key default gen_random_uuid(),
  candidate_name text not null, role_desc text not null,
  recruiter_id uuid references public.profiles(id),
  fee numeric not null default 0,
  guarantee_ends date,
  status text not null default 'Guarantee' check (status in ('Guarantee','Ready','Invoiced','Paid','Fallout')),
  created_at timestamptz not null default now()
);

-- ---------- Campaigns and ads ----------
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null, audience int, delivered int, opened_pct int,
  status text not null default 'Draft' check (status in ('Draft','Scheduled','Sent')),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create table public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.jobs(id) on delete set null,
  job_title text not null, client text,
  channels text[] not null default '{}',
  payer_type text not null default 'agency' check (payer_type in ('agency','recruiter')),
  budget numeric not null default 0, spent numeric not null default 0, applicants int not null default 0,
  status text not null default 'Pending approval' check (status in ('Live','Pending approval','Ended')),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.agency_settings (
  id int primary key default 1 check (id = 1),
  agency_name text not null default 'Harbor Agency',
  guarantee_days int not null default 60,
  ai_screening boolean not null default true
);
insert into public.agency_settings default values;

-- Keep updated_at fresh
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger candidates_touch before update on public.candidates
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- Row-level security
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.candidates enable row level security;
alter table public.candidate_endorsements enable row level security;
alter table public.candidate_comments enable row level security;
alter table public.candidate_timeline enable row level security;
alter table public.jobs enable row level security;
alter table public.job_recruiters enable row level security;
alter table public.applications enable row level security;
alter table public.placements enable row level security;
alter table public.campaigns enable row level security;
alter table public.ad_campaigns enable row level security;
alter table public.agency_settings enable row level security;

-- profiles: everyone signed in can see names; only admins change roles
create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_admin_write on public.profiles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- candidates: staff see all, recruiters see only their own
create policy cand_read on public.candidates for select to authenticated
  using (public.is_staff() or recruiter_id = auth.uid());
create policy cand_insert on public.candidates for insert to authenticated
  with check (public.is_staff() or recruiter_id = auth.uid());
create policy cand_update on public.candidates for update to authenticated
  using (public.is_staff() or recruiter_id = auth.uid())
  with check (public.is_staff() or recruiter_id = auth.uid());
create policy cand_delete on public.candidates for delete to authenticated using (public.is_admin());

-- candidate children: allowed when the parent candidate is visible to you
create policy endorse_all on public.candidate_endorsements for all to authenticated
  using (exists (select 1 from public.candidates c where c.id = candidate_id))
  with check (exists (select 1 from public.candidates c where c.id = candidate_id));
create policy comments_read on public.candidate_comments for select to authenticated
  using (exists (select 1 from public.candidates c where c.id = candidate_id));
create policy comments_insert on public.candidate_comments for insert to authenticated
  with check (author_id = auth.uid() and exists (select 1 from public.candidates c where c.id = candidate_id));
create policy timeline_all on public.candidate_timeline for all to authenticated
  using (exists (select 1 from public.candidates c where c.id = candidate_id))
  with check (exists (select 1 from public.candidates c where c.id = candidate_id));

-- jobs: everyone signed in reads; staff or the creator edit
create policy jobs_read on public.jobs for select to authenticated using (true);
create policy jobs_insert on public.jobs for insert to authenticated with check (created_by = auth.uid());
create policy jobs_update on public.jobs for update to authenticated
  using (public.is_staff() or created_by = auth.uid()) with check (public.is_staff() or created_by = auth.uid());
create policy jobrec_read on public.job_recruiters for select to authenticated using (true);
-- Staff can manage anyone's row; a recruiter can also engage/disengage themselves.
create policy jobrec_write on public.job_recruiters for all to authenticated
  using (public.is_staff() or recruiter_id = auth.uid())
  with check (public.is_staff() or recruiter_id = auth.uid());

-- inbox and billing writes: staff only (recruiters can read their own placements)
create policy apps_staff on public.applications for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy place_read on public.placements for select to authenticated
  using (public.is_staff() or recruiter_id = auth.uid());
create policy place_write on public.placements for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- campaigns: everyone reads; staff or creator edit
create policy camp_read on public.campaigns for select to authenticated using (true);
create policy camp_insert on public.campaigns for insert to authenticated with check (created_by = auth.uid());
create policy camp_update on public.campaigns for update to authenticated
  using (public.is_staff() or created_by = auth.uid()) with check (public.is_staff() or created_by = auth.uid());

-- ads: agency-paid ads must start as 'Pending approval'; only staff can approve or end
create policy ads_read on public.ad_campaigns for select to authenticated
  using (public.is_staff() or created_by = auth.uid());
create policy ads_insert on public.ad_campaigns for insert to authenticated
  with check (created_by = auth.uid()
    and (public.is_staff() or payer_type = 'recruiter' or status = 'Pending approval'));
create policy ads_update on public.ad_campaigns for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy settings_read on public.agency_settings for select to authenticated using (true);
create policy settings_write on public.agency_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- Candidate portal: secure link, no login. Returns only safe fields.
-- =====================================================================
create or replace function public.candidate_portal(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', c.name,
    'endorsements', coalesce((select jsonb_agg(jsonb_build_object('company', e.company, 'role', e.role_title, 'status', e.status))
                              from candidate_endorsements e where e.candidate_id = c.id), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(m) from jsonb_array_elements(c.matches) m
                         where (m->>'fit')::int >= 70), '[]'::jsonb))
  from candidates c where c.portal_token = p_token
$$;
revoke all on function public.candidate_portal(text) from public;
grant execute on function public.candidate_portal(text) to anon, authenticated;

-- =====================================================================
-- Candidate <-> job pipeline. A candidate can sit on several jobs, each
-- with its own stage and fit score. (Migration: candidate_job_pipeline_and_resume_storage)
-- =====================================================================
create table public.candidate_jobs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  stage text not null default 'In review'
    check (stage in ('Sourced','In review','Screening','Submitted','Interview','Offer','Placed','Rejected','Withdrawn')),
  fit integer check (fit between 0 and 100),
  notes text,
  added_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (candidate_id, job_id),
  -- Recruiter-filled answers to the job's own screening_questions, entered alongside
  -- the rest of this candidate's details rather than through a separate AI flow.
  screening_answers jsonb not null default '[]'::jsonb
);
create index candidate_jobs_job_idx on public.candidate_jobs(job_id);
create index candidate_jobs_candidate_idx on public.candidate_jobs(candidate_id);
create trigger candidate_jobs_touch before update on public.candidate_jobs
  for each row execute function public.touch_updated_at();
alter table public.candidate_jobs enable row level security;
create policy cj_read on public.candidate_jobs for select using (
  is_staff() or exists (select 1 from candidates c where c.id = candidate_id and c.recruiter_id = auth.uid())
  or exists (select 1 from job_recruiters jr where jr.job_id = candidate_jobs.job_id and jr.recruiter_id = auth.uid()));
create policy cj_write on public.candidate_jobs for insert with check (
  is_staff() or exists (select 1 from candidates c where c.id = candidate_id and c.recruiter_id = auth.uid()));
create policy cj_update on public.candidate_jobs for update using (
  is_staff() or exists (select 1 from candidates c where c.id = candidate_id and c.recruiter_id = auth.uid()))
  with check (is_staff() or exists (select 1 from candidates c where c.id = candidate_id and c.recruiter_id = auth.uid()));
create policy cj_delete on public.candidate_jobs for delete using (is_staff());

alter table public.applications add column job_id uuid references public.jobs(id) on delete set null;
create index applications_job_idx on public.applications(job_id);

-- =====================================================================
-- Resumes: one private bucket, files at resumes/<candidate_id>/<file>.
-- Both the app (upload/view) and the ai-screen function use it.
-- cv_path + the "cvs" bucket are the older single-file store; ai-screen
-- still reads them as a fallback.
-- =====================================================================
alter table public.candidates add column resume_path text, add column resume_name text;
alter table public.candidates add column if not exists cv_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes','resumes', false, 10485760,
  array['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

create policy resumes_read on storage.objects for select to authenticated using (
  bucket_id = 'resumes' and (is_staff() or exists (
    select 1 from public.candidates c where c.id::text = (storage.foldername(name))[1] and c.recruiter_id = auth.uid())));
create policy resumes_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'resumes' and (is_staff() or exists (
    select 1 from public.candidates c where c.id::text = (storage.foldername(name))[1] and c.recruiter_id = auth.uid())));
create policy resumes_update on storage.objects for update to authenticated using (
  bucket_id = 'resumes' and (is_staff() or exists (
    select 1 from public.candidates c where c.id::text = (storage.foldername(name))[1] and c.recruiter_id = auth.uid())));
create policy resumes_delete on storage.objects for delete to authenticated using (
  bucket_id = 'resumes' and is_staff());

-- =====================================================================
-- Jobs: salary currency, hiring country, AI SEO data.
-- (Migration: job_currency_country_seo)
-- =====================================================================
alter table public.jobs
  add column currency text not null default 'NGN' check (currency ~ '^[A-Z]{3}$'),
  add column country text,
  add column seo jsonb;   -- { meta_description, keywords[], original_title, original_description }

-- Hardening (migration: tighten_function_security)
revoke execute on function public.handle_new_user() from anon, authenticated, public;
alter function public.touch_updated_at() set search_path = public;

-- =====================================================================
-- Candidate phone number, job billing terms, and recruiter incentives.
-- (Migration: phone_billing_incentive_placement_links)
-- =====================================================================
alter table public.candidates add column if not exists phone text;

alter table public.jobs
  add column if not exists billing_type text not null default 'percent' check (billing_type in ('flat','percent')),
  add column if not exists billing_amount numeric,
  add column if not exists billing_currency text,
  add column if not exists incentive_type text not null default 'percent' check (incentive_type in ('flat','percent')),
  add column if not exists incentive_amount numeric,
  add column if not exists incentive_currency text;

-- Placements (billing entries) were only ever free text with no link back to
-- the actual candidate/job records, and never recorded a recruiter incentive
-- or a currency for the fee. Tie them properly.
alter table public.placements
  add column if not exists candidate_id uuid references public.candidates(id) on delete set null,
  add column if not exists job_id uuid references public.jobs(id) on delete set null,
  add column if not exists fee_currency text not null default 'NGN',
  add column if not exists recruiter_incentive numeric,
  add column if not exists recruiter_incentive_currency text;
create index if not exists placements_candidate_idx on public.placements(candidate_id);
create index if not exists placements_job_idx on public.placements(job_id);

-- Recruiters could never actually create a placement: the existing write
-- policy on placements ("place_write") is staff-only for every operation,
-- so the app's "Mark placed" flow silently failed RLS for a recruiter.
-- Let a recruiter insert their own; status changes (invoice, mark paid)
-- stay staff-only via the existing place_write policy.
create policy place_insert_recruiter on public.placements for insert to authenticated
  with check (recruiter_id = auth.uid());

-- =====================================================================
-- AFTER RUNNING: create your first user (Authentication > Users > Add user),
-- then make yourself admin (replace the email):
--   update public.profiles set role = 'admin', level = 'Admin, owner' where email = 'you@example.com';
-- Also turn OFF "Allow new users to sign up" (Authentication > Sign In / Providers)
-- so only people you invite can get in.
-- =====================================================================
