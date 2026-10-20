-- Candidate-first pitching: when the job feed finds a role that a candidate on file fits (Active
-- file, or someone who agreed to be pitched), the candidate is asked first, with the role shown
-- WITHOUT the employer's name. Only once they say yes and confirm their details on file is the
-- lead pitched to the employer (with a blind resume made from their own CV).

create table if not exists public.lead_offers (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  fit int, verdict text, reason text, bullets jsonb not null default '[]'::jsonb,
  status text not null default 'suggested' check (status in ('suggested','sent','interested','confirmed','declined','skipped')),
  token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  client_token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  blind_pages int, blind_at timestamptz, blind_by uuid,
  sent_at timestamptz, sent_by uuid, responded_at timestamptz, confirmed_at timestamptz, client_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lead_id, candidate_id)
);
alter table public.lead_offers enable row level security;
create policy lead_offers_staff on public.lead_offers for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
grant select, insert, update, delete on public.lead_offers to authenticated;

-- 'awaiting': matched, waiting for candidates to say yes before anything goes to the employer.
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check check (status in ('pending','awaiting','new','approved','queued','contacted','replied','meeting','won','lost','ignored','unsubscribed'));

-- The role as the candidate sees it: no employer name or website anywhere.
create or replace function public.offer_role_anon(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare l record; d text; pat text;
begin
  select job_title, location, country, salary, description, company, company_domain, data into l from leads where id = p_lead;
  if not found then return null; end if;
  d := left(coalesce(l.description, ''), 1500);
  foreach pat in array array[l.company, l.company_domain, split_part(coalesce(l.company_domain, ''), '.', 1)] loop
    if length(coalesce(pat, '')) >= 3 then
      d := regexp_replace(d, regexp_replace(pat, '([.*+?^${}()|\[\]\\])', '\\\1', 'g'), 'the company', 'gi');
    end if;
  end loop;
  d := regexp_replace(d, 'https?://\S+|www\.\S+', '', 'gi');
  return jsonb_build_object('title', l.job_title, 'location', l.location, 'country', l.country, 'salary', l.salary,
    'remote', coalesce((l.data ->> 'remote')::boolean, false), 'summary', d);
end $$;
revoke all on function public.offer_role_anon(uuid) from public, anon, authenticated;

-- Candidate page: the offer, and what we have on file for them.
create or replace function public.candidate_offer(p_token text, p_offer text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare cid uuid := portal_candidate_id(p_token); o record; c record;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid and status <> 'suggested' and status <> 'skipped';
  if not found then return null; end if;
  select name, email, phone, location, current_title, experience, notice, pay, linkedin_url into c from candidates where id = cid;
  return jsonb_build_object('offer', o.token, 'status', o.status, 'role', offer_role_anon(o.lead_id),
    'profile', jsonb_build_object('name', c.name, 'email', c.email, 'phone', c.phone, 'location', c.location, 'currentTitle', c.current_title,
      'experience', nullif(c.experience, '-'), 'notice', nullif(c.notice, '-'), 'pay', nullif(c.pay, '-'), 'linkedin', c.linkedin_url));
end $$;

-- Yes / No on the role.
create or replace function public.candidate_offer_respond(p_token text, p_offer text, p_interested boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare cid uuid := portal_candidate_id(p_token); o record; l record; c record;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid and status in ('sent', 'interested', 'declined');
  if not found then raise exception 'This role is no longer available'; end if;
  update lead_offers set status = case when p_interested then 'interested' else 'declined' end, responded_at = now() where id = o.id;
  select job_title into l from leads where id = o.lead_id;
  select recruiter_id into c from candidates where id = cid;
  insert into candidate_timeline (candidate_id, title, done)
    values (cid, case when p_interested then 'Interested in a matched role: ' else 'Not interested in a matched role: ' end || coalesce(l.job_title, ''), true);
  if not p_interested then
    -- Nobody left who might still say yes: the lead is dropped.
    if not exists (select 1 from lead_offers where lead_id = o.lead_id and status in ('suggested', 'sent', 'interested', 'confirmed')) then
      update leads set status = 'ignored', notes = concat_ws(E'\n', notes, 'Every matched candidate said no') where id = o.lead_id and status = 'awaiting';
    end if;
  end if;
  return jsonb_build_object('ok', true, 'status', case when p_interested then 'interested' else 'declined' end);
end $$;

-- "Yes, and here are my details": saves their edits, confirms, and readies the lead to pitch.
create or replace function public.candidate_offer_confirm(p_token text, p_offer text, p_profile jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare cid uuid := portal_candidate_id(p_token); o record; l record; c record; p jsonb := coalesce(p_profile, '{}'::jsonb);
  t text;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid and status in ('sent', 'interested', 'confirmed');
  if not found then raise exception 'This role is no longer available'; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'Invalid details'; end if;
  update candidates set
    phone = coalesce(nullif(left(trim(p ->> 'phone'), 40), ''), phone),
    location = coalesce(nullif(left(trim(p ->> 'location'), 120), ''), location),
    current_title = coalesce(nullif(left(trim(p ->> 'currentTitle'), 120), ''), current_title),
    experience = coalesce(nullif(left(trim(p ->> 'experience'), 80), ''), experience),
    notice = coalesce(nullif(left(trim(p ->> 'notice'), 80), ''), notice),
    pay = coalesce(nullif(left(trim(p ->> 'pay'), 80), ''), pay),
    linkedin_url = coalesce(nullif(left(trim(p ->> 'linkedin'), 300), ''), linkedin_url)
  where id = cid;
  update lead_offers set status = 'confirmed', confirmed_at = now(), responded_at = coalesce(responded_at, now()) where id = o.id;
  select job_title into l from leads where id = o.lead_id;
  select name, recruiter_id into c from candidates where id = cid;
  t := c.name || ' confirmed interest in ' || coalesce(l.job_title, 'a matched role');
  insert into candidate_timeline (candidate_id, title, done) values (cid, 'Confirmed their details for a matched role: ' || coalesce(l.job_title, ''), true);
  perform push_update(c.recruiter_id, 'event', t, 'They checked their details on file. The role is ready to pitch to the employer in Outreach > Client leads.', jsonb_build_object('page', 'campaigns'), 'offer:' || o.id, false, null);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.candidate_offer(text, text) from public;
revoke all on function public.candidate_offer_respond(text, text, boolean) from public;
revoke all on function public.candidate_offer_confirm(text, text, jsonb) from public;
grant execute on function public.candidate_offer(text, text) to anon, authenticated;
grant execute on function public.candidate_offer_respond(text, text, boolean) to anon, authenticated;
grant execute on function public.candidate_offer_confirm(text, text, jsonb) to anon, authenticated;

-- Blind resumes for a lead pitch live under offer-<offer id>/ (staff only).
create or replace function public.can_manage_link(p_link text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select case when p_link like 'offer-%' then public.is_staff()
    else exists (select 1 from public.candidate_jobs cj join public.candidates c on c.id = cj.candidate_id
                  where cj.id::text = p_link and (public.is_staff() or (c.recruiter_id = auth.uid() and public.app_role() is not null))) end
$$;
