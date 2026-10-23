-- Client sourcing, candidate first (23 Oct 2026).
-- A candidate who said Yes once (to future roles / the Active file) is never asked for permission
-- again. Before a pitch goes to an employer, each candidate on it gets an information email: the
-- role (never the employer), how it meets what they're looking for, and the fit score, with
-- "Acknowledge" and "Withdraw my profile". Acknowledging opens any questions we have; their
-- acknowledgement and answers come back to their recruiter in the chat (the pitch has its own
-- thread: the candidate is linked to the lead's role, a private client-lead role). Withdrawing
-- takes them off the pitch and asks whether they still want other roles. The pitch waits for them;
-- after 2 days a reminder goes out, and Rec Ops / Admins can push them through or take them off.
--
-- lead_offers is the one row per candidate per lead (their own status on that pitch):
--   notified      information email sent, waiting for them
--   reminded      reminder sent, still waiting
--   no_email      couldn't be emailed: waits for Rec Ops / an Admin to push or take them off
--   acknowledged  acknowledged, questions still to answer
--   ready         acknowledged (no questions / answered) or pushed through by us
--   pitched       in the pitch that went to the employer
--   withdrawn     they withdrew (withdrawn_by 'candidate') or we did ('agency')
--   removed       taken off by us ("remove from consideration")
-- (the older suggested / sent / interested / confirmed / processing / declined / skipped stay valid)

alter table public.lead_offers
  add column if not exists requirements jsonb not null default '[]',
  add column if not exists questions jsonb not null default '[]',
  add column if not exists answers jsonb,
  add column if not exists notified_at timestamptz,
  add column if not exists reminded_at timestamptz,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists withdrawn_at timestamptz,
  add column if not exists withdrawn_by text,
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid,
  add column if not exists ready_at timestamptz,
  add column if not exists pitched_at timestamptz,
  add column if not exists other_roles boolean,
  add column if not exists note text;

alter table public.lead_offers drop constraint if exists lead_offers_status_check;
alter table public.lead_offers add constraint lead_offers_status_check check (status = any (array[
  'suggested', 'sent', 'interested', 'confirmed', 'processing', 'declined', 'skipped',
  'notified', 'reminded', 'no_email', 'acknowledged', 'ready', 'pitched', 'withdrawn', 'removed']));

-- The candidate's page never names the employer of a client-lead role.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.candidate_portal(text)'::regprocedure);
  d := replace(d, '''company'', j.client', '''company'', case when j.lead_role then ''Confidential client'' else j.client end');
  execute d;
end $$;

-- A message from the candidate in the pitch's chat (their recruiter sees it and is notified).
create or replace function public.pitch_chat(p_offer uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from lead_offers where id = p_offer;
  if o.candidate_job_id is null then return; end if;
  insert into candidate_job_messages (link_id, sender, body, staff_id)
    values (o.candidate_job_id, 'candidate', left(p_body, 4000), public.chat_default_staff(o.candidate_job_id));
end $$;
revoke all on function public.pitch_chat(uuid, text) from public, anon, authenticated;

-- What the candidate sees for one pitch (?c=<portal token>&offer=<token>).
create or replace function public.candidate_pitch(p_token text, p_offer text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := portal_candidate_id(p_token); o record; c record;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid
    and status in ('notified', 'reminded', 'no_email', 'acknowledged', 'ready', 'pitched', 'withdrawn', 'removed');
  if not found then return null; end if;
  select open_to_roles, open_paused_until into c from candidates where id = cid;
  return jsonb_build_object('offer', o.token, 'status', o.status, 'role', offer_role_anon(o.lead_id),
    'fit', o.fit, 'verdict', o.verdict, 'requirements', coalesce(o.requirements, '[]'::jsonb),
    'questions', coalesce(o.questions, '[]'::jsonb), 'answers', o.answers,
    'acknowledgedAt', o.acknowledged_at, 'withdrawnBy', o.withdrawn_by, 'otherRoles', o.other_roles,
    'open', coalesce(c.open_to_roles, true),
    'facts', (select coalesce(data -> 'role', '{}'::jsonb) from leads where id = o.lead_id));
end $$;
revoke all on function public.candidate_pitch(text, text) from public;
grant execute on function public.candidate_pitch(text, text) to anon, authenticated;

-- "Acknowledge": no permission asked, just noted. With no questions to answer they're ready to pitch.
create or replace function public.candidate_pitch_ack(p_token text, p_offer text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := portal_candidate_id(p_token); o record; l record; nq int;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid;
  if not found then raise exception 'This role is no longer available'; end if;
  if o.status in ('withdrawn', 'removed') then raise exception 'You''re no longer being put forward for this role'; end if;
  nq := jsonb_array_length(coalesce(o.questions, '[]'::jsonb));
  if o.status in ('notified', 'reminded', 'no_email') then
    update lead_offers set acknowledged_at = now(), responded_at = coalesce(responded_at, now()),
        status = case when nq > 0 then 'acknowledged' else 'ready' end,
        ready_at = case when nq > 0 then ready_at else now() end
      where id = o.id;
    select job_title into l from leads where id = o.lead_id;
    insert into candidate_timeline (candidate_id, title, done) values (cid, 'Acknowledged being put forward for ' || coalesce(l.job_title, 'a role'), true);
    perform pitch_chat(o.id, 'Acknowledged: happy to be put forward for ' || coalesce(l.job_title, 'this role') || '.'
      || case when nq > 0 then ' Answering your questions next.' else '' end);
  end if;
  return jsonb_build_object('ok', true, 'questions', coalesce(o.questions, '[]'::jsonb), 'needsAnswers', nq > 0 and o.answers is null);
end $$;
revoke all on function public.candidate_pitch_ack(text, text) from public;
grant execute on function public.candidate_pitch_ack(text, text) to anon, authenticated;

-- Their answers to our questions: back to the recruiter in the chat; then they're ready to pitch.
create or replace function public.candidate_pitch_answer(p_token text, p_offer text, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := portal_candidate_id(p_token); o record; l record; qs jsonb; txt text := ''; i int;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid;
  if not found then raise exception 'This role is no longer available'; end if;
  if o.status in ('withdrawn', 'removed') then raise exception 'You''re no longer being put forward for this role'; end if;
  if jsonb_typeof(coalesce(p_answers, 'null'::jsonb)) <> 'array' then raise exception 'Please answer the questions'; end if;
  qs := coalesce(o.questions, '[]'::jsonb);
  for i in 0 .. jsonb_array_length(qs) - 1 loop
    if length(trim(coalesce(p_answers ->> i, ''))) = 0 then raise exception 'Please answer every question'; end if;
    txt := txt || E'\n\n' || coalesce(qs -> i ->> 'q', qs ->> i) || E'\n' || left(trim(p_answers ->> i), 1500);
  end loop;
  update lead_offers set answers = p_answers, acknowledged_at = coalesce(acknowledged_at, now()), responded_at = coalesce(responded_at, now()),
      status = case when status = 'pitched' then status else 'ready' end, ready_at = coalesce(ready_at, now())
    where id = o.id;
  select job_title into l from leads where id = o.lead_id;
  insert into candidate_timeline (candidate_id, title, done) values (cid, 'Answered our questions about ' || coalesce(l.job_title, 'a role'), true);
  perform pitch_chat(o.id, 'My answers about ' || coalesce(l.job_title, 'the role') || ':' || txt);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.candidate_pitch_answer(text, text, jsonb) from public;
grant execute on function public.candidate_pitch_answer(text, text, jsonb) to anon, authenticated;

-- "Withdraw my profile": off this pitch (and the lead's role), told to their recruiter.
create or replace function public.candidate_pitch_withdraw(p_token text, p_offer text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := portal_candidate_id(p_token); o record; l record;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid;
  if not found then raise exception 'This role is no longer available'; end if;
  if o.status in ('withdrawn', 'removed') then return jsonb_build_object('ok', true); end if;
  update lead_offers set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'candidate', responded_at = coalesce(responded_at, now()) where id = o.id;
  if o.candidate_job_id is not null then
    update candidate_jobs set stage = 'Withdrawn' where id = o.candidate_job_id and stage not in ('Withdrawn', 'Rejected', 'Placed');
  end if;
  select job_title into l from leads where id = o.lead_id;
  insert into candidate_timeline (candidate_id, title, done) values (cid, 'Withdrew their profile from ' || coalesce(l.job_title, 'a role'), true);
  perform pitch_chat(o.id, 'I''d like to withdraw my profile from ' || coalesce(l.job_title, 'this role') || '.');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.candidate_pitch_withdraw(text, text) from public;
grant execute on function public.candidate_pitch_withdraw(text, text) to anon, authenticated;

-- After withdrawing: still open to other roles? Yes / No (No pauses them for a year, as the
-- "Open to new roles" switch on their page does).
create or replace function public.candidate_pitch_other_roles(p_token text, p_offer text, p_yes boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := portal_candidate_id(p_token); o record;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid;
  if not found then raise exception 'This link is no longer valid'; end if;
  update lead_offers set other_roles = coalesce(p_yes, true) where id = o.id;
  perform candidate_set_open(p_token, coalesce(p_yes, true));
  perform pitch_chat(o.id, case when coalesce(p_yes, true) then 'I''m still open to other roles.' else 'I''m not looking for other roles right now.' end);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.candidate_pitch_other_roles(text, text, boolean) from public;
grant execute on function public.candidate_pitch_other_roles(text, text, boolean) to anon, authenticated;
