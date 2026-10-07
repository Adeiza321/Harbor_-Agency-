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
  phone text,
  avatar_url text,
  notification_prefs jsonb not null default
    '{"newCandidate":true,"screeningReady":true,"placementRecorded":true,"jobPosted":true}'::jsonb,
  is_owner boolean not null default false,
  created_at timestamptz not null default now()
);
-- At most one owner at any time.
create unique index if not exists profiles_single_owner_idx on public.profiles (is_owner) where is_owner;

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
  select role from public.profiles where id = auth.uid() and status = 'Active'
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
    check (status in ('In review','With client','Interview','Active file','Placed','Rejected','Hired')),
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
  portal_token text unique not null default replace(gen_random_uuid()::text,'-',''),  -- 32 chars (older rows: 12)
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
  -- on delete set null: deleting a candidate should not be blocked by their old inbox row.
  candidate_id uuid references public.candidates(id) on delete set null,
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
  ai_screening boolean not null default true,
  default_currency text not null default 'NGN',
  default_country text not null default 'Nigeria',
  retention_days int,
  integrations jsonb not null default '{}'::jsonb
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

-- profiles: everyone signed in can see names; only admins change roles.
-- Everyone can also update their own row (name/phone/avatar_url) via profiles_self_update below;
-- a trigger reverts role/level/status on that path so self-service can't grant admin.
create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_admin_write on public.profiles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.protect_profile_privileged_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.role := old.role;
    new.level := old.level;
    new.status := old.status;
  end if;
  return new;
end $$;
create trigger profiles_protect_privileged before update on public.profiles
  for each row execute function public.protect_profile_privileged_fields();

-- The agency owner: a single admin every other admin can never demote or disable, and who
-- alone can hand ownership to someone else. (Migration: add_agency_owner_concept)
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner from public.profiles where id = auth.uid()), false)
$$;

-- Guards the owner's row and the is_owner flag itself:
--  * role/status on the owner's own row can only be changed by the owner acting on themselves
--    (or by transfer_ownership() below, which runs as them) -- never by another admin.
--  * is_owner can only move from one row to another when the actor is already the current
--    owner (checked against whatever owner exists *before* this statement), or when no owner
--    exists yet at all (first-time setup).
create or replace function public.protect_owner_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  owner_exists boolean;
begin
  if OLD.is_owner and auth.uid() <> OLD.id then
    new.role := old.role;
    new.status := old.status;
  end if;
  if NEW.is_owner is distinct from OLD.is_owner then
    select exists(select 1 from public.profiles where is_owner) into owner_exists;
    if owner_exists and not public.is_owner() then
      new.is_owner := old.is_owner;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect_owner on public.profiles;
create trigger profiles_protect_owner before update on public.profiles
  for each row execute function public.protect_owner_row();

-- The only sanctioned way to hand ownership to someone else: atomic, and only the current
-- owner can call it.
create or replace function public.transfer_ownership(new_owner_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then
    raise exception 'Only the current owner can transfer ownership';
  end if;
  if not exists (select 1 from public.profiles where id = new_owner_id and status = 'Active') then
    raise exception 'The new owner must be an active account';
  end if;
  update public.profiles set is_owner = false where is_owner;
  update public.profiles set is_owner = true, role = 'admin', level = 'Admin, owner' where id = new_owner_id;
end $$;
grant execute on function public.transfer_ownership(uuid) to authenticated;

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
create policy jobs_delete on public.jobs for delete to authenticated using (public.is_admin());
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
create policy camp_delete on public.campaigns for delete to authenticated using (public.is_admin());

-- ads: agency-paid ads must start as 'Pending approval'; only staff can approve or end
create policy ads_read on public.ad_campaigns for select to authenticated
  using (public.is_staff() or created_by = auth.uid());
create policy ads_insert on public.ad_campaigns for insert to authenticated
  with check (created_by = auth.uid()
    and (public.is_staff() or payer_type = 'recruiter' or status = 'Pending approval'));
create policy ads_update on public.ad_campaigns for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy ads_delete on public.ad_campaigns for delete to authenticated using (public.is_admin());

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
-- AI reads every resume format below (ai-screen/resume.ts), so the bucket accepts them all.
update storage.buckets set allowed_mime_types = array[
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text','application/rtf','text/rtf','text/plain','text/markdown',
  'image/jpeg','image/png','image/webp','image/heic','image/heif']
where id = 'resumes';

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
-- Profile pictures: one public bucket, files at avatars/<user_id>/<file>.
-- Public read so the app can show them with a plain URL; only the owner
-- (or an admin) can write their own file.
-- (Migration: add_profile_self_service_fields_and_avatars)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;

create policy avatars_read on storage.objects for select to public using (bucket_id = 'avatars');
create policy avatars_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy avatars_update on storage.objects for update to authenticated using (
  bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy avatars_delete on storage.objects for delete to authenticated using (
  bucket_id = 'avatars' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

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
-- Audit log: an admin-readable trail of sensitive actions (deletes, edits,
-- account changes). Immutable from the app's side: authenticated users can
-- only insert rows attributed to themselves, and there is no update/delete
-- policy at all, so the app can log but never rewrite history.
-- (Migration: add_settings_notifications_audit_log)
-- =====================================================================
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  detail text,
  created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;
create policy audit_read on public.audit_log for select to authenticated using (public.is_admin());
create policy audit_insert on public.audit_log for insert to authenticated with check (actor_id = auth.uid());
create index audit_log_created_idx on public.audit_log(created_at desc);

-- =====================================================================
-- AFTER RUNNING: create your first user (Authentication > Users > Add user),
-- then make yourself admin and owner (replace the email):
--   update public.profiles set role = 'admin', level = 'Admin, owner', is_owner = true where email = 'you@example.com';
-- Also turn OFF "Allow new users to sign up" (Authentication > Sign In / Providers)
-- so only people you invite can get in.
-- =====================================================================

-- =====================================================================
-- Per-company AI screening cards, routing that the candidate accepts,
-- and follow-up questions answered on the candidate page.
-- =====================================================================

-- ai: the latest screening for this candidate on this job (replaced on every rescreen):
--   { stage: 'first'|'final', summary, strengths[], gaps[], score, verdict: 'Perfect fit'|'Possible fit'|'Reject',
--     usedResume, answersUsed, updatedAt,
--     followups: { state: 'draft'|'sent'|'answered', questions: [{q, a}], approvedBy, approvedAt, answeredAt } }
-- candidate_response: 'accepted' for a normal submission; 'pending' when a recruiter routes
--   the candidate to a role they must accept on their candidate page; 'declined' if they say no.
alter table public.candidate_jobs
  add column if not exists ai jsonb not null default '{}'::jsonb,
  add column if not exists candidate_response text not null default 'accepted'
    check (candidate_response in ('pending','accepted','declined')),
  add column if not exists responded_at timestamptz;

-- Only Rec Ops/Admins (and the ai-screen function, which runs as the service role)
-- may change the AI result or the candidate's response. This is what stops a recruiter
-- from approving follow-up questions themselves.
create or replace function public.protect_candidate_job_ai() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_staff() then
    if tg_op = 'INSERT' then
      if new.ai is distinct from '{}'::jsonb then
        raise exception 'Only Rec Ops or Admins can set screening results';
      end if;
    elsif new.ai is distinct from old.ai or new.candidate_response is distinct from old.candidate_response then
      raise exception 'Only Rec Ops or Admins can change screening results or candidate responses';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists candidate_jobs_protect_ai on public.candidate_jobs;
create trigger candidate_jobs_protect_ai before insert or update on public.candidate_jobs
  for each row execute function public.protect_candidate_job_ai();

-- Candidate page: also returns roles they've been routed to (to accept or decline) and
-- approved follow-up questions waiting for their answers.
-- (Migration portal_matches_live_job_names, 27 Sep 2026: "Roles that fit you" take their
-- names from the live job, so a renamed client shows its new name; closed jobs and jobs
-- they're already on are left out.)
create or replace function public.candidate_portal(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', c.name,
    'endorsements', coalesce((select jsonb_agg(jsonb_build_object('company', e.company, 'role', e.role_title, 'status', e.status))
                              from candidate_endorsements e where e.candidate_id = c.id), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client, 'fit', (m->>'fit')::int))
                         from jsonb_array_elements(c.matches) m
                         join jobs j on j.id::text = m->>'job_id'
                         where (m->>'fit')::int >= 70 and coalesce(j.status, '') <> 'Closed'
                           and not exists (select 1 from candidate_jobs l where l.candidate_id = c.id and l.job_id = j.id)), '[]'::jsonb),
    'routed', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client, 'location', j.location) order by l.created_at)
                        from candidate_jobs l join jobs j on j.id = l.job_id
                        where l.candidate_id = c.id and l.candidate_response = 'pending'), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client,
                             'questions', (select coalesce(jsonb_agg(x->>'q'), '[]'::jsonb) from jsonb_array_elements(l.ai->'followups'->'questions') x)) order by l.created_at)
                           from candidate_jobs l join jobs j on j.id = l.job_id
                           where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'sent'), '[]'::jsonb),
    'answered', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client))
                          from candidate_jobs l join jobs j on j.id = l.job_id
                          where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'answered'), '[]'::jsonb))
  from candidates c where c.portal_token = p_token
$$;

-- =====================================================================
-- Manual-review locking: once a candidate's review is locked, no AI run
-- can overwrite it. (Migration: lock_manual_reviews, applied 27 Sep 2026)
-- =====================================================================

alter table public.candidates
  add column if not exists ai_locked boolean not null default false,
  add column if not exists ai_locked_reason text;

-- Blocks changes to review fields on a locked candidate. Changing ai_locked itself
-- (unlocking) is always allowed. A deliberate manual edit can bypass with:
--   set local harbor.manual_review = 'on';
create or replace function public.guard_locked_candidate() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.ai_locked and new.ai_locked
     and coalesce(current_setting('harbor.manual_review', true), '') <> 'on'
     and (new.ai_score is distinct from old.ai_score
       or new.skills is distinct from old.skills
       or new.strengths is distinct from old.strengths
       or new.gaps is distinct from old.gaps
       or new.screening is distinct from old.screening) then
    raise exception 'This candidate''s review is locked (manually reviewed). Unlock it before re-running AI.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists candidates_guard_locked on public.candidates;
create trigger candidates_guard_locked before update on public.candidates
  for each row execute function public.guard_locked_candidate();

create or replace function public.guard_locked_candidate_job() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('harbor.manual_review', true), '') <> 'on'
     and (new.fit is distinct from old.fit or new.ai is distinct from old.ai)
     and exists (select 1 from candidates c where c.id = new.candidate_id and c.ai_locked) then
    raise exception 'This candidate''s review is locked (manually reviewed). Unlock it before re-running AI.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists candidate_jobs_guard_locked on public.candidate_jobs;
create trigger candidate_jobs_guard_locked before update on public.candidate_jobs
  for each row execute function public.guard_locked_candidate_job();

revoke execute on function public.guard_locked_candidate() from public, anon, authenticated;
revoke execute on function public.guard_locked_candidate_job() from public, anon, authenticated;

-- =====================================================================
-- A job's status is Rec Ops/Admin territory. The UI already hides "Change
-- status" from recruiters; this is the backing defense-in-depth, since the
-- jobs_update RLS policy also lets a job's own creator update it directly
-- (a recruiter can post a job, so without this a determined API call could
-- still flip status even though no button offers it).
-- =====================================================================
create or replace function public.guard_job_status() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status and not public.is_staff() then
    raise exception 'Only Rec Ops or Admins can change a job''s status' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists jobs_guard_status on public.jobs;
create trigger jobs_guard_status before update on public.jobs
  for each row execute function public.guard_job_status();
revoke execute on function public.guard_job_status() from public, anon, authenticated;

-- =====================================================================
-- A recruiter no longer moves a submitted candidate through the pipeline
-- (Hold/Not a fit/Reject/Forward/Mark placed) — that's Rec Ops/Admin's
-- call. The one thing they can still do is flag a candidate as Hired, a
-- lightweight signal that doesn't create a placement or billing entry;
-- Rec Ops/Admin then confirms it with the existing Mark placed flow,
-- which is what actually creates the placement.
-- =====================================================================
alter table public.candidates drop constraint if exists candidates_status_check;
alter table public.candidates add constraint candidates_status_check
  check (status in ('In review','With client','Interview','Active file','Placed','Rejected','Hired'));

create or replace function public.guard_candidate_status() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status and not public.is_staff() and new.status <> 'Hired' then
    raise exception 'Recruiters can only flag a candidate as Hired — Rec Ops or an Admin confirms the placement' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists candidates_guard_status on public.candidates;
create trigger candidates_guard_status before update on public.candidates
  for each row execute function public.guard_candidate_status();
revoke execute on function public.guard_candidate_status() from public, anon, authenticated;

-- =====================================================================
-- Draft candidates: the "Add candidate" flow lets a recruiter (or Rec
-- Ops/Admin) run a resume-only "check fit" pass against a job before
-- deciding whether to pursue a candidate at all. That check is saved on
-- the backend and logged to the audit log, but the candidate must stay
-- invisible to everyone except whoever created it — including staff —
-- until a full Submit (resume + answered screening questions) clears
-- is_draft. Enforced at the RLS layer, not just hidden in the UI.
-- =====================================================================
alter table public.candidates add column if not exists is_draft boolean not null default false;

drop policy if exists cand_read on public.candidates;
create policy cand_read on public.candidates for select to authenticated
  using (recruiter_id = auth.uid() or (public.is_staff() and not is_draft));

drop policy if exists cand_update on public.candidates;
create policy cand_update on public.candidates for update to authenticated
  using (recruiter_id = auth.uid() or (public.is_staff() and not is_draft))
  with check (recruiter_id = auth.uid() or (public.is_staff() and not is_draft));

-- =====================================================================
-- Industry experience per employer (migration candidate_industries, 28 Sep 2026).
-- Filled by the ai-screen "industries" action and on first screening: each employer on
-- the resume is looked up on the web. Item: {company, title, from, to, industry,
-- confidence: 'confirmed'|'unsure', big4_practice, source, note}. 'unsure' = the company
-- couldn't be identified, so no industry is claimed. Screening uses it for industry
-- alignment. Not a locked review field (employer facts), so it fills for locked candidates.
-- =====================================================================
alter table public.candidates
  add column if not exists industries jsonb not null default '[]'::jsonb,
  add column if not exists industries_checked_at timestamptz;

-- =====================================================================
-- Work setup per job (migration job_work_setup, 28 Sep 2026).
-- Onsite / Hybrid / Remote, set on "Post a job" (or by the "Upload a job brief" AI
-- extraction) and editable afterwards from "Edit job". Free text at the DB layer so a
-- stray value from an old client never blocks a save; the UI only offers the three.
-- =====================================================================
alter table public.jobs add column if not exists work_setup text;

-- =====================================================================
-- Pay basis, employment type, and billing/incentive frequency (migration
-- job_pay_and_billing_detail, 28 Sep 2026).
-- salary_period: how the min/max pay figures are quoted (Yearly/Monthly/Weekly/Daily/
--   Hourly) — ignored when commission_only is set, since there's no base figure.
-- commission_only: role pays on commission alone; min_pay/max_pay are left blank.
-- employment_type: Full-time / Part-time / Contract.
-- billing_frequency / incentive_frequency: whether the client fee, and the recruiter's
--   incentive, are billed as a One-off on placement or Monthly for a period; *_months is
--   how many months, only meaningful when its frequency is Monthly.
-- All free text / plain integers at the DB layer — the UI is what limits the choices.
-- =====================================================================
alter table public.jobs
  add column if not exists salary_period text,
  add column if not exists commission_only boolean not null default false,
  add column if not exists employment_type text,
  add column if not exists billing_frequency text,
  add column if not exists billing_months integer,
  add column if not exists incentive_frequency text,
  add column if not exists incentive_months integer;

-- When a candidate was first submitted to the client (migration candidate_jobs_submitted_at,
-- 28 Sep 2026). Stamped automatically the first time a card's stage reaches Submitted or
-- later, and kept if they're later rejected, so the dashboard can count submissions per
-- day/month/year and what happened to them (passed = Offer/Placed, failed = Rejected/Withdrawn).
-- =====================================================================
alter table public.candidate_jobs add column if not exists submitted_at timestamptz;

create or replace function public.stamp_submitted_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.submitted_at is null and new.stage in ('Submitted', 'Interview', 'Offer', 'Placed') then
    new.submitted_at := now();
  end if;
  return new;
end $$;
drop trigger if exists candidate_jobs_submitted_at on public.candidate_jobs;
create trigger candidate_jobs_submitted_at before insert or update of stage on public.candidate_jobs
  for each row execute function public.stamp_submitted_at();

-- =====================================================================
-- Head count per job (migration job_headcount, 28 Sep 2026).
-- Number of openings for this role; defaults to 1 so existing jobs behave as before.
-- =====================================================================
alter table public.jobs add column if not exists headcount integer not null default 1;

-- =====================================================================
-- When a SUBMITTED candidate reaches an outcome with the client: Placed (passed) or
-- Rejected/Withdrawn (failed). (Migration candidate_jobs_outcome_at, 28 Sep 2026.)
-- =====================================================================
alter table public.candidate_jobs add column if not exists outcome_at timestamptz;

create or replace function public.stamp_outcome_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.submitted_at is not null and new.stage in ('Placed', 'Rejected', 'Withdrawn')
     and (tg_op = 'INSERT' or new.stage is distinct from old.stage) then
    new.outcome_at := now();
  elsif new.stage not in ('Placed', 'Rejected', 'Withdrawn') then
    new.outcome_at := null;
  end if;
  return new;
end $$;

-- Runs after candidate_jobs_submitted_at (triggers fire in name order), so submitted_at is set first.
drop trigger if exists candidate_jobs_that_outcome_at on public.candidate_jobs;
create trigger candidate_jobs_that_outcome_at before insert or update of stage on public.candidate_jobs
  for each row execute function public.stamp_outcome_at();

-- =====================================================================
-- Require activation before a new account can use the app (migration
-- require_active_status, 28 Sep 2026). New accounts (created via the
-- create-user function) now start status = 'Invited' instead of 'Active', so an
-- admin has to click Activate on their row in Users and permissions first.
-- app_role() previously only blocked 'Disabled'; tightening it to require 'Active'
-- means 'Invited' accounts can sign in but can't read/write anything RLS-gated by
-- is_staff()/is_admin() (or app_role() directly) until activated. Existing users
-- already sitting at status = 'Active' are unaffected.
-- =====================================================================
create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and status = 'Active'
$$;

-- =====================================================================
-- Billing details and invoices (migration billing_details_and_invoices, 28 Sep 2026).
-- placements: start date, per-entry guarantee (0 = none), date billed, and the saved
-- invoice (number, dates, bill to / from, lines, tax, totals). agency_settings: company
-- details printed on invoices, and invoice numbering handed out by claim_invoice_number().
-- =====================================================================
alter table public.placements
  add column if not exists start_date date,
  add column if not exists guarantee_days integer check (guarantee_days is null or guarantee_days >= 0),
  add column if not exists billed_at timestamptz,
  add column if not exists invoice jsonb not null default '{}'::jsonb;

alter table public.agency_settings
  add column if not exists company jsonb not null default '{}'::jsonb,
  add column if not exists invoice_prefix text not null default 'INV',
  add column if not exists next_invoice_number integer not null default 1;

create or replace function public.claim_invoice_number() returns text
language plpgsql security definer set search_path = public as $$
declare n integer; p text;
begin
  if not public.is_staff() then raise exception 'Only Rec Ops or Admins can raise invoices'; end if;
  update agency_settings set next_invoice_number = next_invoice_number + 1 where id = 1
    returning next_invoice_number - 1, invoice_prefix into n, p;
  if n is null then raise exception 'Agency settings missing'; end if;
  return coalesce(nullif(p, ''), 'INV') || '-' || to_char(now(), 'YYYY') || '-' || lpad(n::text, 4, '0');
end $$;
revoke all on function public.claim_invoice_number() from public;
grant execute on function public.claim_invoice_number() to authenticated;

-- =====================================================================
-- Parallel titles (Migration parallel_titles_and_portal_fits, 28 Sep 2026).
alter table public.candidates add column if not exists parallel_titles jsonb not null default '[]'::jsonb;
alter table public.candidates add column if not exists parallel_titles_at timestamptz;

-- Parallel work (Migration portal_matches_reviewed_not_busy, 28 Sep 2026): "Roles that fit you"
-- only shows roles the full AI review rated Possible/Perfect fit at 60%+, and nothing while the
-- candidate is at Interview or Offer on another role, or already placed.
create or replace function public.candidate_portal(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', c.name,
    'endorsements', coalesce((select jsonb_agg(jsonb_build_object('company', e.company, 'role', e.role_title, 'status', e.status))
                              from candidate_endorsements e where e.candidate_id = c.id), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client, 'fit', (m->>'fit')::int))
                         from jsonb_array_elements(c.matches) m
                         join jobs j on j.id::text = m->>'job_id'
                         where (m->>'fit')::int >= 60 and m ? 'reviewedAt' and coalesce(m->>'verdict', '') in ('Perfect fit', 'Possible fit')
                           and coalesce(j.status, '') <> 'Closed'
                           and not exists (select 1 from candidate_jobs l where l.candidate_id = c.id and l.job_id = j.id)
                           -- parallel work: nothing new is pitched while they're at Interview/Offer elsewhere or placed
                           and c.status not in ('Interview', 'Placed', 'Hired')
                           and not exists (select 1 from candidate_jobs l where l.candidate_id = c.id
                                             and l.candidate_response <> 'declined' and l.stage in ('Interview', 'Offer', 'Placed'))), '[]'::jsonb),
    'routed', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client, 'location', j.location) order by l.created_at)
                        from candidate_jobs l join jobs j on j.id = l.job_id
                        where l.candidate_id = c.id and l.candidate_response = 'pending'), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client,
                             'questions', (select coalesce(jsonb_agg(x->>'q'), '[]'::jsonb) from jsonb_array_elements(l.ai->'followups'->'questions') x)) order by l.created_at)
                           from candidate_jobs l join jobs j on j.id = l.job_id
                           where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'sent'), '[]'::jsonb),
    'answered', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client))
                          from candidate_jobs l join jobs j on j.id = l.job_id
                          where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'answered'), '[]'::jsonb))
  from candidates c where c.portal_token = p_token
$$;

-- =====================================================================
-- (Migration candidate_email_check, 28 Sep 2026)
-- Candidate email check (no double registration, so no ownership disputes).
-- One email = one candidate. "+tags" are ignored (jane+x@gmail.com = jane@gmail.com).
create or replace function public.norm_email(e text) returns text
language sql immutable set search_path = public as $$
  select nullif(regexp_replace(lower(trim(coalesce(e, ''))), '\+[^@]*@', '@'), '')
$$;

-- Who already has this email (and people with the same name), for the Add candidate form.
-- Recruiters can't see each other's candidates, so this runs with elevated rights and returns
-- only what's needed to avoid a dispute: the candidate's name, the owning recruiter and the date.
create or replace function public.check_candidate_email(p_email text, p_name text default '') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  em text := public.norm_email(p_email);
  nm text := lower(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  r record;
  res jsonb := '{}'::jsonb;
  sim jsonb;
begin
  if me is null or not exists (select 1 from profiles where id = me and status = 'Active') then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if em is not null then
    select c.id, c.name, c.recruiter_id, c.created_at, c.status, p.full_name into r
      from candidates c left join profiles p on p.id = c.recruiter_id
     where not c.is_draft and public.norm_email(c.email) = em
     order by c.created_at limit 1;
    if found then
      res := jsonb_build_object('match', jsonb_build_object(
        'name', r.name, 'recruiter', coalesce(nullif(r.full_name, ''), 'another recruiter'), 'since', r.created_at, 'status', r.status,
        'mine', r.recruiter_id = me, 'candidateId', case when r.recruiter_id = me or public.is_staff() then r.id end));
    end if;
  end if;
  if length(nm) >= 3 then
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', x.name, 'recruiter', coalesce(nullif(x.full_name, ''), 'another recruiter'), 'since', x.created_at,
             'mine', x.recruiter_id = me, 'candidateId', case when x.recruiter_id = me or public.is_staff() then x.id end)), '[]'::jsonb)
      into sim
      from (select c.id, c.name, c.recruiter_id, c.created_at, p.full_name
              from candidates c left join profiles p on p.id = c.recruiter_id
             where not c.is_draft and lower(regexp_replace(trim(c.name), '\s+', ' ', 'g')) = nm
               and (em is null or coalesce(public.norm_email(c.email), '') <> em)
             order by c.created_at limit 5) x;
    res := res || jsonb_build_object('similar', sim);
  end if;
  return res;
end $$;
revoke execute on function public.check_candidate_email(text, text) from public, anon;
grant execute on function public.check_candidate_email(text, text) to authenticated;

-- Backstop for every way a candidate is created (Add candidate, Inbox, imports): a second
-- candidate with an email that's already registered is refused with a clear message.
create or replace function public.guard_candidate_email() returns trigger
language plpgsql security definer set search_path = public as $$
declare em text := public.norm_email(new.email); r record;
begin
  if em is null then return new; end if;
  if tg_op = 'UPDATE' and public.norm_email(old.email) is not distinct from em and old.is_draft = new.is_draft then return new; end if;
  select c.created_at, p.full_name into r
    from candidates c left join profiles p on p.id = c.recruiter_id
   where c.id <> new.id and not c.is_draft and public.norm_email(c.email) = em
   order by c.created_at limit 1;
  if found then
    raise exception 'This email is already registered in Harbor to % (since %). A candidate can only be registered once.',
      coalesce(nullif(r.full_name, ''), 'another recruiter'), to_char(r.created_at, 'DD Mon YYYY') using errcode = '23505';
  end if;
  return new;
end $$;
revoke execute on function public.guard_candidate_email() from public, anon, authenticated;
drop trigger if exists candidates_guard_email on public.candidates;
create trigger candidates_guard_email before insert or update of email, is_draft on public.candidates
  for each row execute function public.guard_candidate_email();
create unique index if not exists candidates_email_unique on public.candidates (public.norm_email(email))
  where not is_draft and public.norm_email(email) is not null;

-- =====================================================================
-- Candidate email check, per job (Migration candidate_email_check_per_job, 28 Sep 2026).
-- The same person (same email, "+tags" ignored) can be submitted to different jobs, but only
-- once to the same job, so two recruiters can't dispute one application.
drop trigger if exists candidates_guard_email on public.candidates;
drop function if exists public.guard_candidate_email();
drop index if exists public.candidates_email_unique;
create index if not exists candidates_norm_email_idx on public.candidates (public.norm_email(email));

-- Refuse a job card when someone with the same email is already on that job.
create or replace function public.guard_candidate_job_email() returns trigger
language plpgsql security definer set search_path = public as $$
declare em text; r record;
begin
  select public.norm_email(email) into em from candidates where id = new.candidate_id;
  if em is null then return new; end if;
  select c.name, p.full_name, l.created_at into r
    from candidate_jobs l join candidates c on c.id = l.candidate_id left join profiles p on p.id = c.recruiter_id
   where l.job_id = new.job_id and l.candidate_id <> new.candidate_id and not c.is_draft and public.norm_email(c.email) = em
   order by l.created_at limit 1;
  if found then
    raise exception 'This candidate (same email) is already on this job, submitted by % on %. A candidate can only be submitted once per job.',
      coalesce(nullif(r.full_name, ''), 'another recruiter'), to_char(r.created_at, 'DD Mon YYYY') using errcode = '23505';
  end if;
  return new;
end $$;
revoke execute on function public.guard_candidate_job_email() from public, anon, authenticated;
drop trigger if exists candidate_jobs_guard_email on public.candidate_jobs;
create trigger candidate_jobs_guard_email before insert or update of job_id, candidate_id on public.candidate_jobs
  for each row execute function public.guard_candidate_job_email();

-- Changing a candidate's email to one that's already on the same job is refused too.
create or replace function public.guard_candidate_email_jobs() returns trigger
language plpgsql security definer set search_path = public as $$
declare em text := public.norm_email(new.email); r record;
begin
  if em is null or new.is_draft or public.norm_email(old.email) is not distinct from em then return new; end if;
  select j.role_title, j.client into r
    from candidate_jobs mine join candidate_jobs other on other.job_id = mine.job_id and other.candidate_id <> new.id
    join candidates c on c.id = other.candidate_id join jobs j on j.id = mine.job_id
   where mine.candidate_id = new.id and not c.is_draft and public.norm_email(c.email) = em limit 1;
  if found then
    raise exception 'Another candidate with this email is already on % at %. A candidate can only be submitted once per job.', r.role_title, r.client using errcode = '23505';
  end if;
  return new;
end $$;
revoke execute on function public.guard_candidate_email_jobs() from public, anon, authenticated;
drop trigger if exists candidates_guard_email_jobs on public.candidates;
create trigger candidates_guard_email_jobs before update of email on public.candidates
  for each row execute function public.guard_candidate_email_jobs();

-- Lookup for the Add candidate form: is this email already on the chosen job (blocks), where
-- else is it registered (info only), and anyone with the same name under another email (warning).
drop function if exists public.check_candidate_email(text, text);
create or replace function public.check_candidate_email(p_email text, p_name text default '', p_job_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  em text := public.norm_email(p_email);
  nm text := lower(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  r record;
  res jsonb := '{}'::jsonb;
  x jsonb;
begin
  if me is null or not exists (select 1 from profiles where id = me and status = 'Active') then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if em is not null and p_job_id is not null then
    select c.id, c.name, c.recruiter_id, l.created_at, l.stage, p.full_name into r
      from candidate_jobs l join candidates c on c.id = l.candidate_id left join profiles p on p.id = c.recruiter_id
     where l.job_id = p_job_id and not c.is_draft and public.norm_email(c.email) = em
     order by l.created_at limit 1;
    if found then
      res := jsonb_build_object('match', jsonb_build_object(
        'name', r.name, 'recruiter', coalesce(nullif(r.full_name, ''), 'another recruiter'), 'since', r.created_at, 'stage', r.stage,
        'mine', r.recruiter_id = me, 'candidateId', case when r.recruiter_id = me or public.is_staff() then r.id end));
    end if;
  end if;
  if em is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', y.name, 'recruiter', coalesce(nullif(y.full_name, ''), 'another recruiter'), 'since', y.created_at,
             'mine', y.recruiter_id = me, 'candidateId', case when y.recruiter_id = me or public.is_staff() then y.id end,
             'jobs', y.jobs)), '[]'::jsonb) into x
      from (select c.id, c.name, c.recruiter_id, c.created_at, p.full_name,
                   coalesce((select jsonb_agg(j.role_title || ' – ' || j.client order by l.created_at)
                               from candidate_jobs l join jobs j on j.id = l.job_id
                              where l.candidate_id = c.id and (p_job_id is null or l.job_id <> p_job_id)), '[]'::jsonb) jobs
              from candidates c left join profiles p on p.id = c.recruiter_id
             where not c.is_draft and public.norm_email(c.email) = em
             order by c.created_at limit 5) y;
    res := res || jsonb_build_object('elsewhere', x);
  end if;
  if length(nm) >= 3 then
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', y.name, 'recruiter', coalesce(nullif(y.full_name, ''), 'another recruiter'), 'since', y.created_at,
             'mine', y.recruiter_id = me, 'candidateId', case when y.recruiter_id = me or public.is_staff() then y.id end)), '[]'::jsonb)
      into x
      from (select c.id, c.name, c.recruiter_id, c.created_at, p.full_name
              from candidates c left join profiles p on p.id = c.recruiter_id
             where not c.is_draft and lower(regexp_replace(trim(c.name), '\s+', ' ', 'g')) = nm
               and (em is null or coalesce(public.norm_email(c.email), '') <> em)
             order by c.created_at limit 5) y;
    res := res || jsonb_build_object('similar', x);
  end if;
  return res;
end $$;
revoke execute on function public.check_candidate_email(text, text, uuid) from public, anon;
grant execute on function public.check_candidate_email(text, text, uuid) to authenticated;


-- migration: candidate_current_title
alter table public.candidates add column if not exists current_title text;
alter table public.candidates add column if not exists current_company text;
alter table public.candidates add column if not exists profile_read_at timestamptz;

-- migration: followup_dismissals_and_ops_tokens
-- Removed follow-up questions (ai.dismissedQuestions) aren't part of the locked review either.
create or replace function public.guard_locked_candidate_job()
 returns trigger language plpgsql set search_path to 'public' as $function$
begin
  if coalesce(current_setting('harbor.manual_review', true), '') <> 'on'
     and (new.fit is distinct from old.fit
          or (coalesce(new.ai, '{}'::jsonb) - array['followups','dismissedQuestions']) is distinct from (coalesce(old.ai, '{}'::jsonb) - array['followups','dismissedQuestions']))
     and exists (select 1 from candidates c where c.id = new.candidate_id and c.ai_locked) then
    raise exception 'This candidate''s review is locked (manually reviewed). Unlock it before re-running AI.'
      using errcode = 'P0001';
  end if;
  return new;
end $function$;

-- Short-lived tokens for maintenance runs of the ai-screen function (e.g. a one-off refresh of
-- every candidate). Only the service role can read them: RLS on, no policies, no grants.
create table if not exists public.ops_tokens (
  token text primary key,
  purpose text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.ops_tokens enable row level security;
revoke all on public.ops_tokens from anon, authenticated;

-- migration: sourcing_and_client_machine
-- migration: sourcing_and_client_machine
-- Candidate sourcing (our database first, then Apollo), outreach to prospects, and the
-- "client machine": daily job feed -> match our bench -> pitch the hiring contact.
-- Everything here is inert until the matching API keys exist (see supabase/SOURCING_SETUP.md).

-- Jobs get their own parallel titles (other titles the same role is posted as), so the bench
-- is searched both ways, plus a small status record of the last sourcing run.
alter table public.jobs add column if not exists parallel_titles jsonb not null default '[]'::jsonb;
alter table public.jobs add column if not exists parallel_titles_at timestamptz;
alter table public.jobs add column if not exists sourcing jsonb not null default '{}'::jsonb;

-- Candidates choose whether we may present their profile anonymously to other employers.
alter table public.candidates add column if not exists pitch_consent boolean not null default false;
alter table public.candidates add column if not exists pitch_consent_at timestamptz;

-- Outreach settings (sender name, business address, approval mode, caps, target countries).
alter table public.agency_settings add column if not exists outreach jsonb not null default '{}'::jsonb;

-- Anyone who unsubscribed or asked us to delete their data: never contacted again.
create table if not exists public.outreach_suppressions (
  email_norm text primary key,
  reason text not null default 'unsubscribed',
  created_at timestamptz not null default now()
);

-- People found outside Harbor for a specific job (Apollo). Not candidates until they say yes.
create table if not exists public.prospects (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  source text not null default 'apollo',
  external_id text,
  first_name text, last_name text, full_name text,
  title text, company text, location text, country text, region text,
  linkedin_url text,
  email text, email_status text,
  fit integer, verdict text, fit_reason text,
  subject text, body text,
  status text not null default 'found'
    check (status in ('found','approved','queued','contacted','interested','not_interested','unsubscribed','bounced','rejected','converted')),
  unsub_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  candidate_id uuid references public.candidates(id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  contacted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (job_id, external_id)
);
create index if not exists prospects_job_idx on public.prospects(job_id);
create index if not exists prospects_email_idx on public.prospects(lower(email));

-- Client machine: new job postings elsewhere that our bench fits, and who posted them.
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'theirstack',
  external_id text unique,
  company text, company_domain text,
  job_title text, location text, country text, region text,
  url text, posted_at timestamptz, description text, salary text,
  matches jsonb not null default '[]'::jsonb,         -- [{candidate_id, verdict, fit, reason}]
  contact_name text, contact_first_name text, contact_role text,
  contact_linkedin text, contact_email text, contact_email_status text,
  channel text not null default 'none' check (channel in ('email','linkedin','none')),
  status text not null default 'new'
    check (status in ('new','approved','queued','contacted','replied','meeting','won','lost','ignored','unsubscribed')),
  pitch_subject text, pitch_body text, linkedin_message text,
  unsub_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  converted_job_id uuid references public.jobs(id) on delete set null,
  assigned_to uuid references public.profiles(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  contacted_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists leads_status_idx on public.leads(status, created_at desc);

-- Every outreach email: the send queue and the log.
create table if not exists public.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('candidate','client')),
  prospect_id uuid references public.prospects(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  to_email text not null, to_name text,
  subject text not null, body text not null,
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  provider text, provider_ref text, error text,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists outreach_messages_queue_idx on public.outreach_messages(status, created_at);

-- Staff only (Rec Ops and Admin). The edge functions use the service role.
alter table public.outreach_suppressions enable row level security;
alter table public.prospects enable row level security;
alter table public.leads enable row level security;
alter table public.outreach_messages enable row level security;
drop policy if exists suppressions_staff_read on public.outreach_suppressions;
create policy suppressions_staff_read on public.outreach_suppressions for select using (is_staff());
drop policy if exists prospects_staff on public.prospects;
create policy prospects_staff on public.prospects for all using (is_staff()) with check (is_staff());
drop policy if exists leads_staff on public.leads;
create policy leads_staff on public.leads for all using (is_staff()) with check (is_staff());
drop policy if exists outreach_messages_staff_read on public.outreach_messages;
create policy outreach_messages_staff_read on public.outreach_messages for select using (is_staff());

drop trigger if exists prospects_touch on public.prospects;
create trigger prospects_touch before update on public.prospects for each row execute function touch_updated_at();
drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads for each row execute function touch_updated_at();

-- Candidate page: turn anonymous presentation to other employers on or off.
create or replace function public.candidate_set_pitch_consent(p_token text, p_consent boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cand_id uuid;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  update candidates set pitch_consent = coalesce(p_consent, false), pitch_consent_at = now()
    where portal_token = p_token returning id into cand_id;
  if cand_id is null then raise exception 'Invalid link'; end if;
  insert into candidate_timeline (candidate_id, title, done)
    values (cand_id, case when p_consent then 'Agreed to be presented anonymously to other employers' else 'Turned off anonymous presentation to other employers' end, true);
  return jsonb_build_object('ok', true, 'pitchConsent', coalesce(p_consent, false));
end $$;
grant execute on function public.candidate_set_pitch_consent(text, boolean) to anon, authenticated;

-- Candidate page data: now also returns the consent setting, and lists Good fit matches too.
CREATE OR REPLACE FUNCTION public.candidate_portal(p_token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'name', c.name,
    'pitchConsent', c.pitch_consent,
    'endorsements', coalesce((select jsonb_agg(jsonb_build_object('company', e.company, 'role', e.role_title, 'status', e.status))
                              from candidate_endorsements e where e.candidate_id = c.id), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client, 'fit', (m->>'fit')::int))
                         from jsonb_array_elements(c.matches) m
                         join jobs j on j.id::text = m->>'job_id'
                         where (m->>'fit')::int >= 60 and m ? 'reviewedAt' and coalesce(m->>'verdict', '') in ('Perfect fit', 'Good fit', 'Possible fit')
                           and coalesce(j.status, '') <> 'Closed'
                           and not exists (select 1 from candidate_jobs l where l.candidate_id = c.id and l.job_id = j.id)
                           and c.status not in ('Interview', 'Placed', 'Hired')
                           and not exists (select 1 from candidate_jobs l where l.candidate_id = c.id
                                             and l.candidate_response <> 'declined' and l.stage in ('Interview', 'Offer', 'Placed'))), '[]'::jsonb),
    'routed', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client, 'location', j.location) order by l.created_at)
                        from candidate_jobs l join jobs j on j.id = l.job_id
                        where l.candidate_id = c.id and l.candidate_response = 'pending'), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client,
                             'questions', (select coalesce(jsonb_agg(x->>'q'), '[]'::jsonb) from jsonb_array_elements(l.ai->'followups'->'questions') x)) order by l.created_at)
                           from candidate_jobs l join jobs j on j.id = l.job_id
                           where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'sent'), '[]'::jsonb),
    'answered', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client))
                          from candidate_jobs l join jobs j on j.id = l.job_id
                          where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'answered'), '[]'::jsonb),
    -- One thread per job the candidate is (still) linked to, newest first, with the full
    -- message history and how many recruiter messages they haven't read yet.
    'threads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'linkId', l.id, 'role', j.role_title, 'company', j.client,
        'messages', coalesce((select jsonb_agg(jsonb_build_object('sender', m.sender, 'body', m.body, 'createdAt', m.created_at) order by m.created_at)
                               from candidate_job_messages m where m.link_id = l.id), '[]'::jsonb),
        'unread', (select count(*) from candidate_job_messages m where m.link_id = l.id and m.sender = 'recruiter' and m.candidate_read_at is null)
      ) order by l.created_at desc)
      from candidate_jobs l join jobs j on j.id = l.job_id
      where l.candidate_id = c.id and l.candidate_response <> 'declined'
    ), '[]'::jsonb))
  from candidates c where c.portal_token = p_token
$function$;

-- migration: sourcing_schedule
-- Sourcing, part 2: lead staging, "job goes live" trigger, and the schedules that run the
-- sourcing function. Safe to re-run.

alter table public.leads add column if not exists data jsonb not null default '{}';
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check check (status in
  ('pending','new','approved','queued','contacted','replied','meeting','won','lost','ignored','unsubscribed'));

-- When a job goes live (Open), queue it for sourcing: bench check first, then outside search.
create or replace function public.queue_job_sourcing() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status = 'Open' and (tg_op = 'INSERT' or old.status is distinct from 'Open') then
    new.sourcing := coalesce(new.sourcing, '{}'::jsonb) || jsonb_build_object('state', 'pending', 'queuedAt', now());
  end if;
  return new;
end $$;
drop trigger if exists jobs_queue_sourcing on public.jobs;
create trigger jobs_queue_sourcing before insert or update of status on public.jobs
  for each row execute function public.queue_job_sourcing();

-- Scheduler: a long-lived ops token kept in the vault, used by pg_cron to call the function.
create extension if not exists pg_cron;

do $$
declare tok text;
begin
  if not exists (select 1 from vault.secrets where name = 'harbor_ops_token') then
    tok := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.ops_tokens(token, purpose, expires_at) values (tok, 'cron', now() + interval '10 years');
    perform vault.create_secret(tok, 'harbor_ops_token', 'Ops token used by pg_cron to call the sourcing function');
  end if;
end $$;

create or replace function public.call_sourcing(p_action text) returns bigint
language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/sourcing',
    body := jsonb_build_object('action', p_action),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 300000);
$$;
revoke all on function public.call_sourcing(text) from public, anon, authenticated;

-- Every 10 minutes: next sourcing step, lead checks, sending, clean-up.
select cron.schedule('harbor-sourcing-tick', '*/10 * * * *', $$select public.call_sourcing('tick')$$);
-- Daily 06:00 UTC: pull yesterday's job postings (only runs if client leads are switched on).
select cron.schedule('harbor-leads-daily', '0 6 * * *', $$select public.call_sourcing('leads_daily')$$);

-- migration: interview_calendar
-- Interview calendar: interviews, per-recruiter Google Calendar connections, candidate page
-- support, and the schedule that sends reminders and syncs Google. Safe to re-run.

create table if not exists public.interviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  link_id uuid references public.candidate_jobs(id) on delete set null,
  round text not null default '1st round',
  starts_at timestamptz not null,
  duration_min int not null default 60 check (duration_min between 5 and 600),
  location_type text not null default 'meet' check (location_type in ('meet','link','phone','in_person')),
  location text,                       -- video link, phone number or address
  meet_url text,                       -- Google Meet link created with the calendar event
  notes text,                          -- internal: client interviewers etc. Never shown to candidates.
  recruiter_id uuid references public.profiles(id) on delete set null,
  scheduler_tz text,                   -- time zone of the person who booked it (display only)
  candidate_tz text,
  client_tz text,
  status text not null default 'scheduled' check (status in ('scheduled','done','no_show','client_cancelled','rescheduled','cancelled')),
  decision text check (decision in ('next_round','offer','client_reject','waiting')),
  feedback text,
  candidate_confirmed_at timestamptz,
  google_event_id text,
  google_owner uuid references public.profiles(id) on delete set null,
  google_synced_at timestamptz,
  google_error text,
  send_reminders boolean not null default true,
  reminder_day_sent_at timestamptz,
  reminder_hour_sent_at timestamptz,
  noshow_followup_sent_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists interviews_starts_idx on public.interviews(starts_at);
create index if not exists interviews_candidate_idx on public.interviews(candidate_id);
create or replace trigger interviews_touch before update on public.interviews for each row execute function public.touch_updated_at();

alter table public.interviews enable row level security;
-- Same reach as candidates: staff see all; recruiters see their own candidates, roles they're on,
-- and interviews they run.
create or replace function public.can_see_interview(p_candidate uuid, p_job uuid, p_recruiter uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff()
      or p_recruiter = auth.uid()
      or exists (select 1 from candidates c where c.id = p_candidate and c.recruiter_id = auth.uid())
      or exists (select 1 from job_recruiters jr where jr.job_id = p_job and jr.recruiter_id = auth.uid());
$$;
revoke all on function public.can_see_interview(uuid, uuid, uuid) from public, anon;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='interviews' and policyname='interviews_read') then
    create policy interviews_read on public.interviews for select to authenticated using (public.can_see_interview(candidate_id, job_id, recruiter_id)); end if;
  if not exists (select 1 from pg_policies where tablename='interviews' and policyname='interviews_insert') then
    create policy interviews_insert on public.interviews for insert to authenticated with check (public.can_see_interview(candidate_id, job_id, recruiter_id)); end if;
  if not exists (select 1 from pg_policies where tablename='interviews' and policyname='interviews_update') then
    create policy interviews_update on public.interviews for update to authenticated using (public.can_see_interview(candidate_id, job_id, recruiter_id)) with check (public.can_see_interview(candidate_id, job_id, recruiter_id)); end if;
  if not exists (select 1 from pg_policies where tablename='interviews' and policyname='interviews_delete') then
    create policy interviews_delete on public.interviews for delete to authenticated using (public.is_staff() or recruiter_id = auth.uid()); end if;
end $$;

-- Google Calendar connection per person. Holds a refresh token, so no app access at all:
-- only the interviews Edge Function (service role) reads or writes it.
create table if not exists public.google_calendar_connections (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  google_email text,
  refresh_token text not null,
  calendar_id text not null default 'primary',
  sync_token text,
  settings jsonb not null default '{"separateCalendar": true, "clashCheck": true, "inviteCandidate": false}',
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_error text
);
alter table public.google_calendar_connections enable row level security;
revoke all on public.google_calendar_connections from anon, authenticated;

create table if not exists public.google_oauth_states (
  state text primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  return_to text,
  created_at timestamptz not null default now()
);
alter table public.google_oauth_states enable row level security;
revoke all on public.google_oauth_states from anon, authenticated;

-- Candidate page: the candidate confirms they'll attend.
create or replace function public.candidate_confirm_interview(p_token text, p_interview_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update interviews i set candidate_confirmed_at = coalesce(i.candidate_confirmed_at, now())
    from candidates c
   where i.id = p_interview_id and c.id = i.candidate_id and c.portal_token = p_token and i.status = 'scheduled';
  get diagnostics n = row_count;
  return n > 0;
end $$;
grant execute on function public.candidate_confirm_interview(text, uuid) to anon, authenticated;

-- Candidate page data: add upcoming interviews and recent missed ones (with the follow-up).
create or replace function public.candidate_portal(p_token text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'name', c.name,
    'pitchConsent', c.pitch_consent,
    'endorsements', coalesce((select jsonb_agg(jsonb_build_object('company', e.company, 'role', e.role_title, 'status', e.status))
                              from candidate_endorsements e where e.candidate_id = c.id), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client, 'fit', (m->>'fit')::int))
                         from jsonb_array_elements(c.matches) m
                         join jobs j on j.id::text = m->>'job_id'
                         where (m->>'fit')::int >= 60 and m ? 'reviewedAt' and coalesce(m->>'verdict', '') in ('Perfect fit', 'Good fit', 'Possible fit')
                           and coalesce(j.status, '') <> 'Closed'
                           and not exists (select 1 from candidate_jobs l where l.candidate_id = c.id and l.job_id = j.id)
                           and c.status not in ('Interview', 'Placed', 'Hired')
                           and not exists (select 1 from candidate_jobs l where l.candidate_id = c.id
                                             and l.candidate_response <> 'declined' and l.stage in ('Interview', 'Offer', 'Placed'))), '[]'::jsonb),
    'routed', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client, 'location', j.location) order by l.created_at)
                        from candidate_jobs l join jobs j on j.id = l.job_id
                        where l.candidate_id = c.id and l.candidate_response = 'pending'), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'role', j.role_title, 'company', j.client,
                             'questions', (select coalesce(jsonb_agg(x->>'q'), '[]'::jsonb) from jsonb_array_elements(l.ai->'followups'->'questions') x)) order by l.created_at)
                           from candidate_jobs l join jobs j on j.id = l.job_id
                           where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'sent'), '[]'::jsonb),
    'answered', coalesce((select jsonb_agg(jsonb_build_object('role', j.role_title, 'company', j.client))
                          from candidate_jobs l join jobs j on j.id = l.job_id
                          where l.candidate_id = c.id and l.ai->'followups'->>'state' = 'answered'), '[]'::jsonb),
    'threads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'linkId', l.id, 'role', j.role_title, 'company', j.client,
        'messages', coalesce((select jsonb_agg(jsonb_build_object('sender', m.sender, 'body', m.body, 'createdAt', m.created_at) order by m.created_at)
                               from candidate_job_messages m where m.link_id = l.id), '[]'::jsonb),
        'unread', (select count(*) from candidate_job_messages m where m.link_id = l.id and m.sender = 'recruiter' and m.candidate_read_at is null)
      ) order by l.created_at desc)
      from candidate_jobs l join jobs j on j.id = l.job_id
      where l.candidate_id = c.id and l.candidate_response <> 'declined'
    ), '[]'::jsonb),
    'interviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'linkId', i.link_id, 'round', i.round, 'role', j.role_title, 'company', j.client,
        'startsAt', i.starts_at, 'durationMin', i.duration_min, 'locationType', i.location_type,
        'location', case when i.location_type in ('phone', 'in_person') then i.location end,
        'joinUrl', case when i.location_type = 'meet' then i.meet_url when i.location_type = 'link' then i.location end,
        'status', i.status, 'confirmed', i.candidate_confirmed_at is not null,
        'recruiter', split_part(coalesce(p.full_name, ''), ' ', 1)
      ) order by i.starts_at)
      from interviews i
      left join jobs j on j.id = i.job_id
      left join profiles p on p.id = i.recruiter_id
      where i.candidate_id = c.id
        and ((i.status = 'scheduled' and i.starts_at + make_interval(mins => i.duration_min) > now() - interval '2 hours')
          or (i.status = 'no_show' and i.noshow_followup_sent_at is not null and i.starts_at > now() - interval '21 days'))
    ), '[]'::jsonb))
  from candidates c where c.portal_token = p_token
$function$;

-- Schedule: reminders, no-show follow-ups and Google sync every 10 minutes (reuses the vault
-- ops token created for sourcing).
create or replace function public.call_interviews(p_action text) returns bigint
language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/interviews',
    body := jsonb_build_object('action', p_action),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 120000);
$$;
revoke all on function public.call_interviews(text) from public, anon, authenticated;
select cron.schedule('harbor-interviews-tick', '*/10 * * * *', $$select public.call_interviews('tick')$$);

-- migration: idle_timeout
alter table public.agency_settings add column if not exists idle_timeout_minutes int not null default 30 check (idle_timeout_minutes between 5 and 480);

-- migration: spend_approvals
-- Paid work (Apollo, TheirStack) waits here until an Admin approves it.
create table if not exists public.spend_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('apollo_search','leads_fetch')),
  job_id uuid references public.jobs(id) on delete cascade,
  title text not null,
  est_apollo int not null default 0,
  est_theirstack int not null default 0,
  cost_text text,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','approved','declined','done','failed')),
  requested_by uuid references public.profiles(id) on delete set null,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists spend_requests_status_idx on public.spend_requests(status, created_at desc);
alter table public.spend_requests enable row level security;
revoke insert, update, delete on public.spend_requests from anon, authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='spend_requests' and policyname='spend_requests_staff_read') then
    create policy spend_requests_staff_read on public.spend_requests for select to authenticated using (public.is_staff()); end if;
end $$;

-- migration: reject_reasons
-- Why a candidate was rejected on a role, and what they were told.
alter table public.candidate_jobs add column if not exists reject_kind text, add column if not exists reject_reason text,
  add column if not exists reject_feedback text, add column if not exists reject_message text,
  add column if not exists rejected_at timestamptz, add column if not exists rejected_by uuid references public.profiles(id) on delete set null;

-- migration: job_hold_status_sync_auto_screen
-- Job statuses are Open, On hold and Closed (plus Draft). "Engaged" is no longer a job status:
-- engaging is per person (job_recruiters / job_engagements). On hold stops new candidates.
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status in ('Draft','Open','On hold','Closed'));
alter table public.jobs add column if not exists hold_reason text;
alter table public.jobs add column if not exists hold_until date;
alter table public.jobs add column if not exists held_at timestamptz;
alter table public.jobs add column if not exists held_by uuid references public.profiles(id) on delete set null;

-- Candidate status follows their roles; Offer is a candidate status too.
alter table public.candidates drop constraint if exists candidates_status_check;
alter table public.candidates add constraint candidates_status_check check (status in ('In review','With client','Interview','Offer','Active file','Placed','Rejected','Hired'));

-- Status changes made by Harbor itself (status sync, reopening held jobs) pass the guards.
create or replace function public.guard_job_status() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status and not public.is_staff()
     and coalesce(current_setting('harbor.status_sync', true), '') <> 'on' then
    raise exception 'Only Rec Ops or Admins can change a job''s status' using errcode = 'P0001';
  end if;
  if new.status = 'On hold' and old.status is distinct from 'On hold' then
    new.held_at := now(); new.held_by := coalesce(auth.uid(), new.held_by);
  elsif new.status <> 'On hold' then
    new.hold_reason := null; new.hold_until := null; new.held_at := null; new.held_by := null;
  end if;
  return new;
end $$;

create or replace function public.guard_candidate_status() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status and not public.is_staff() and new.status <> 'Hired'
     and coalesce(current_setting('harbor.status_sync', true), '') <> 'on' then
    raise exception 'Recruiters can only flag a candidate as Hired — Rec Ops or an Admin confirms the placement' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Coming back from hold doesn't restart sourcing; only a newly live job does.
create or replace function public.queue_job_sourcing() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status = 'Open' and (tg_op = 'INSERT' or old.status not in ('Open', 'On hold')) then
    new.sourcing := coalesce(new.sourcing, '{}'::jsonb) || jsonb_build_object('state', 'pending', 'queuedAt', now());
  end if;
  return new;
end $$;

-- The candidate's overall status, from their roles (declined and not-yet-accepted routes don't count).
create or replace function public.derive_candidate_status(p_cand uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when count(*) = 0 then null
    when bool_or(stage = 'Placed') then 'Placed'
    when bool_or(stage = 'Offer') then 'Offer'
    when bool_or(stage = 'Interview') then 'Interview'
    when bool_or(stage = 'Submitted') then 'With client'
    when bool_or(stage in ('Sourced', 'In review', 'Screening')) then 'In review'
    else 'Active file' end
  from public.candidate_jobs
  where candidate_id = p_cand and coalesce(candidate_response, 'accepted') = 'accepted'
$$;

create or replace function public.sync_candidate_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare cid uuid; cur text; d text; was_placed boolean := false;
begin
  if tg_op = 'DELETE' then cid := old.candidate_id; was_placed := old.stage = 'Placed';
  else cid := new.candidate_id; if tg_op = 'UPDATE' then was_placed := old.stage = 'Placed'; end if; end if;
  select status into cur from public.candidates where id = cid;
  if cur is null then return null; end if;
  d := public.derive_candidate_status(cid);
  if d is null or d = cur then return null; end if;
  -- "Hired" is a recruiter's flag waiting for Rec Ops/Admin; it holds until placed or rejected.
  if cur = 'Hired' and d in ('In review', 'With client', 'Interview', 'Offer') then return null; end if;
  -- A placement stays Placed unless the placed role itself is moved off Placed.
  if cur = 'Placed' and not was_placed then return null; end if;
  perform set_config('harbor.status_sync', 'on', true);
  update public.candidates set status = d where id = cid;
  perform set_config('harbor.status_sync', 'off', true);
  return null;
end $$;

drop trigger if exists candidate_jobs_sync_status on public.candidate_jobs;
create trigger candidate_jobs_sync_status after insert or delete or update of stage, candidate_response
  on public.candidate_jobs for each row execute function public.sync_candidate_status();

-- A status typed in by hand can't contradict the roles (Hired and Placed are confirmed by hand).
create or replace function public.align_candidate_status() returns trigger
language plpgsql set search_path = public as $$
declare d text;
begin
  if new.status is distinct from old.status and new.status not in ('Hired', 'Placed')
     and coalesce(current_setting('harbor.status_sync', true), '') <> 'on' then
    d := public.derive_candidate_status(new.id);
    if d is not null then new.status := d; end if;
  end if;
  return new;
end $$;
drop trigger if exists candidates_align_status on public.candidates;
create trigger candidates_align_status before update of status on public.candidates
  for each row execute function public.align_candidate_status();

-- Bring every candidate in line once.
do $$
declare r record; d text;
begin
  perform set_config('harbor.status_sync', 'on', true);
  for r in select id, status from public.candidates loop
    d := public.derive_candidate_status(r.id);
    if d is not null and d <> r.status
       and not (r.status = 'Hired' and d in ('In review', 'With client', 'Interview', 'Offer'))
       and not (r.status = 'Placed') then
      update public.candidates set status = d where id = r.id;
    end if;
  end loop;
  perform set_config('harbor.status_sync', 'off', true);
end $$;

-- A job on hold (or closed) takes no new candidates, from anyone or any door.
create or replace function public.guard_job_accepting() returns trigger
language plpgsql security definer set search_path = public as $$
declare s text; t text;
begin
  select status, role_title into s, t from public.jobs where id = new.job_id;
  if s = 'On hold' then
    raise exception '% is on hold and isn''t taking new candidates right now.', coalesce(t, 'This role') using errcode = 'P0001';
  elsif s = 'Closed' then
    raise exception '% is closed and isn''t taking new candidates.', coalesce(t, 'This role') using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists candidate_jobs_job_accepting on public.candidate_jobs;
create trigger candidate_jobs_job_accepting before insert or update of job_id on public.candidate_jobs
  for each row execute function public.guard_job_accepting();

-- Holds with an end date reopen by themselves.
create or replace function public.reopen_held_jobs() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('harbor.status_sync', 'on', true);
  update public.jobs set status = 'Open' where status = 'On hold' and hold_until is not null and hold_until <= current_date;
  perform set_config('harbor.status_sync', 'off', true);
end $$;
revoke all on function public.reopen_held_jobs() from public, anon, authenticated;
select cron.schedule('harbor-reopen-held-jobs', '7 * * * *', $$select public.reopen_held_jobs()$$);

-- Automatic screening: a candidate added to a role is screened (and follow-up questions drafted)
-- on the server straight away, with a sweep every 2 minutes as a safety net.
create or replace function public.call_ai_screen(p_action text, p_link uuid) returns bigint
language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/ai-screen',
    body := jsonb_build_object('action', p_action, 'linkId', p_link),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 150000);
$$;
revoke all on function public.call_ai_screen(text, uuid) from public, anon, authenticated;

create or replace function public.auto_screen_new_links() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; n int;
begin
  select count(*) into n from new_links where coalesce(candidate_response, 'accepted') = 'accepted';
  -- One or a few at a time are screened now; a bulk import is left to the sweep, a few per run.
  if n between 1 and 3 then
    for r in select id from new_links where coalesce(candidate_response, 'accepted') = 'accepted' loop
      perform public.call_ai_screen('screen_link', r.id);
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists candidate_jobs_auto_screen on public.candidate_jobs;
create trigger candidate_jobs_auto_screen after insert on public.candidate_jobs
  referencing new table as new_links for each statement execute function public.auto_screen_new_links();

-- Links still waiting: accepted, never screened, added in the last 3 days, not locked, fewer than
-- 3 automatic attempts and none in the last 10 minutes.
create or replace function public.screen_sweep() returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.candidate_jobs cj join public.candidates c on c.id = cj.candidate_id
    where coalesce(cj.candidate_response, 'accepted') = 'accepted'
      and coalesce(cj.ai->>'stage', '') = ''
      and cj.created_at > now() - interval '3 days' and cj.created_at < now() - interval '90 seconds'
      and not coalesce(c.ai_locked, false) and not coalesce(c.is_draft, false)
      and coalesce((cj.ai->'auto'->>'tries')::int, 0) < 3
      and coalesce((cj.ai->'auto'->>'at')::timestamptz, 'epoch') < now() - interval '10 minutes')
  then perform public.call_ai_screen('screen_pending', null);
  end if;
end $$;
revoke all on function public.screen_sweep() from public, anon, authenticated;
select cron.schedule('harbor-screen-sweep', '*/2 * * * *', $$select public.screen_sweep()$$);

-- migration: candidate_linkedin
-- LinkedIn profile URL read from the resume (or typed in by staff).
alter table public.candidates add column if not exists linkedin_url text;

-- migration: candidate_email_opt_out
-- The "click here" unsubscribe link at the bottom of every candidate email. Once a candidate
-- unsubscribes, ProNext sends them no more emails (status updates, messages, interviews).
alter table public.candidates add column if not exists email_opt_out boolean not null default false;
alter table public.candidates add column if not exists email_opt_out_at timestamptz;

-- Candidate page: read (p_out null) or change the email setting, by the candidate's page token.
create or replace function public.candidate_email_prefs(p_token text, p_out boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cand_id uuid; cur boolean;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  select id, email_opt_out into cand_id, cur from candidates where portal_token = p_token;
  if cand_id is null then raise exception 'Invalid link'; end if;
  if p_out is not null and p_out is distinct from cur then
    update candidates set email_opt_out = p_out, email_opt_out_at = now() where id = cand_id;
    insert into candidate_timeline (candidate_id, title, done)
      values (cand_id, case when p_out then 'Unsubscribed from ProNext emails' else 'Turned ProNext emails back on' end, true);
    cur := p_out;
  end if;
  return jsonb_build_object('ok', true, 'optedOut', coalesce(cur, false));
end $$;
revoke all on function public.candidate_email_prefs(text, boolean) from public;
grant execute on function public.candidate_email_prefs(text, boolean) to anon, authenticated;

-- =====================================================================
-- Objects that were live in the database but missing from this file
-- (captured from the live project on 7 Oct 2026).
-- =====================================================================

-- Password reset codes (forgot-password Edge Function only; service role, no policies).
create table if not exists public.password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  email text not null,
  otp_code text not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  attempts integer not null default 0,
  requested_ip text,
  created_at timestamptz not null default now()
);
create index if not exists password_resets_user_id_idx on public.password_resets (user_id, created_at desc);
alter table public.password_resets enable row level security;

-- Last sign-in IP / location per user (record-login Edge Function). Admins or the user can read.
create table if not exists public.profile_security (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_ip text,
  last_location text,
  last_login_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.profile_security enable row level security;
create policy "admin or self can read profile_security" on public.profile_security for select using (
  user_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.status = 'Active'));

-- Recruiter <-> candidate messages, one thread per candidate_jobs row.
create table if not exists public.candidate_job_messages (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.candidate_jobs(id) on delete cascade,
  sender text not null check (sender in ('candidate', 'recruiter')),
  author_id uuid references public.profiles(id),
  body text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  created_at timestamptz not null default now(),
  recruiter_read_at timestamptz,
  candidate_read_at timestamptz
);
create index if not exists candidate_job_messages_link_idx on public.candidate_job_messages (link_id, created_at);
alter table public.candidate_job_messages enable row level security;
create policy cjmsg_read on public.candidate_job_messages for select using (
  is_staff() or exists (select 1 from candidate_jobs cj join candidates c on c.id = cj.candidate_id
    where cj.id = candidate_job_messages.link_id and (c.recruiter_id = auth.uid()
      or exists (select 1 from job_recruiters jr where jr.job_id = cj.job_id and jr.recruiter_id = auth.uid()))));
create policy cjmsg_insert on public.candidate_job_messages for insert with check (
  sender = 'recruiter' and author_id = auth.uid() and (is_staff() or exists (select 1 from candidate_jobs cj join candidates c on c.id = cj.candidate_id
    where cj.id = candidate_job_messages.link_id and (c.recruiter_id = auth.uid()
      or exists (select 1 from job_recruiters jr where jr.job_id = cj.job_id and jr.recruiter_id = auth.uid())))));
create policy cjmsg_update on public.candidate_job_messages for update using (
  is_staff() or exists (select 1 from candidate_jobs cj join candidates c on c.id = cj.candidate_id
    where cj.id = candidate_job_messages.link_id and (c.recruiter_id = auth.uid()
      or exists (select 1 from job_recruiters jr where jr.job_id = cj.job_id and jr.recruiter_id = auth.uid()))))
  with check (
  is_staff() or exists (select 1 from candidate_jobs cj join candidates c on c.id = cj.candidate_id
    where cj.id = candidate_job_messages.link_id and (c.recruiter_id = auth.uid()
      or exists (select 1 from job_recruiters jr where jr.job_id = cj.job_id and jr.recruiter_id = auth.uid()))));

create or replace function public.candidate_send_message(p_token text, p_link_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cand_id uuid;
  link_ok boolean;
  body_clean text := left(trim(coalesce(p_body, '')), 4000);
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  select id into cand_id from candidates where portal_token = p_token;
  if cand_id is null then raise exception 'Invalid link'; end if;
  if body_clean = '' then raise exception 'Write a message first'; end if;
  select true into link_ok from candidate_jobs where id = p_link_id and candidate_id = cand_id;
  if not link_ok then raise exception 'This conversation is no longer available'; end if;
  insert into candidate_job_messages (link_id, sender, body, candidate_read_at, recruiter_read_at)
    values (p_link_id, 'candidate', body_clean, now(), null);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.candidate_send_message(text, uuid, text) to anon, authenticated;

create or replace function public.candidate_mark_read(p_token text, p_link_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cand_id uuid;
begin
  if length(coalesce(p_token, '')) < 12 then raise exception 'Invalid link'; end if;
  select id into cand_id from candidates where portal_token = p_token;
  if cand_id is null then raise exception 'Invalid link'; end if;
  update candidate_job_messages set candidate_read_at = now()
    where link_id = p_link_id and sender = 'recruiter' and candidate_read_at is null
      and exists (select 1 from candidate_jobs l where l.id = p_link_id and l.candidate_id = cand_id);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.candidate_mark_read(text, uuid) to anon, authenticated;

-- Blind, anonymized candidate profile shared with a client (/?t=<client_token>).
alter table public.candidate_jobs
  add column if not exists client_token text default replace(gen_random_uuid()::text, '-', ''),
  add column if not exists client_revealed boolean not null default false,
  add column if not exists client_revealed_at timestamptz,
  add column if not exists client_viewed_at timestamptz;

create or replace function public.client_view(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  result jsonb;
begin
  update public.candidate_jobs set client_viewed_at = now()
    where client_token = p_token and client_viewed_at is null;

  select jsonb_build_object(
    'role', j.role_title, 'client', j.client, 'stage', cj.stage,
    'revealed', cj.client_revealed,
    'score', (cj.ai->>'score')::int, 'verdict', cj.ai->>'verdict', 'summary', cj.ai->>'summary',
    'experience', c.experience, 'location', c.location, 'notice', c.notice,
    'skills', coalesce(c.skills, '{}'), 'strengths', coalesce(c.strengths, '{}'),
    'industries', coalesce((select jsonb_agg(x->>'industry') from jsonb_array_elements(coalesce(c.industries,'[]'::jsonb)) x where x->>'confidence' = 'confirmed'), '[]'::jsonb),
    'parallelTitles', coalesce(c.parallel_titles, '[]'::jsonb),
    'currentTitle', c.current_title,
    'name', case when cj.client_revealed then c.name else null end,
    'email', case when cj.client_revealed then c.email else null end,
    'phone', case when cj.client_revealed then c.phone else null end,
    'linkedin', case when cj.client_revealed then c.linkedin_url else null end,
    'currentCompany', case when cj.client_revealed then c.current_company else null end,
    'hasResume', (c.resume_path is not null or c.cv_path is not null)
  ) into result
  from public.candidate_jobs cj
  join public.candidates c on c.id = cj.candidate_id
  join public.jobs j on j.id = cj.job_id
  where cj.client_token = p_token;

  return result;
end; $$;
grant execute on function public.client_view(text) to anon, authenticated;

-- 7 Oct 2026 review fixes: see supabase/migrations/20261007_security_fixes.sql
-- (token checks accept 12+ characters, 32-character tokens for new rows, internal
-- functions no longer callable by anon, password-reset rate-limit index).
