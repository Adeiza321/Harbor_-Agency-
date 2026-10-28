-- Tell people straight away when an email didn't reach someone (28 Oct 2026: a chat message to
-- John Falbo couldn't be delivered because his new address had a stray space, and nobody knew).
-- An in-app update (the bell, and the assistant's update emails) goes to:
--   * a chat message to a candidate that couldn't be sent or bounced: whoever wrote it, the
--     candidate's recruiter and the Admins;
--   * any other email to a candidate that bounced, was blocked, was invalid or was marked as spam
--     (pitch emails, reminders, interviews...): the candidate's recruiter and the Admins;
--   * a pitch or other email to a client contact with the same problems: whoever approved it and
--     the Admins.
-- Delays and soft bounces (Brevo keeps trying) don't count. One update per email per person.

create or replace function public.notify_email_problem(p_users uuid[], p_title text, p_body text, p_link jsonb, p_key text)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  for u in select distinct x from unnest(p_users || array(select id from profiles where role = 'admin' and status = 'Active')) x where x is not null loop
    perform push_update(u, 'event', p_title, p_body, p_link, 'email-problem:' || p_key, false, null);
  end loop;
end $$;
revoke all on function public.notify_email_problem(uuid[], text, text, jsonb, text) from public, anon, authenticated;

-- 1. Chat messages: not sent (no address, Brevo refused it) or bounced. Not when they unsubscribed
--    (their choice, already shown on the message).
create or replace function public.chat_email_problem() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if new.sender <> 'recruiter' or new.email_status not in ('not_sent', 'bounced') then return new; end if;
  if tg_op = 'UPDATE' and old.email_status is not distinct from new.email_status then return new; end if;
  if coalesce(new.email_error, '') ilike '%unsubscribed%' then return new; end if;
  select ca.id, ca.name, ca.email, ca.recruiter_id into c from candidate_jobs cj join candidates ca on ca.id = cj.candidate_id where cj.id = new.link_id;
  if not found then return new; end if;
  perform notify_email_problem(array[new.author_id, c.recruiter_id],
    'A chat message to ' || coalesce(c.name, 'a candidate') || ' didn''t reach them',
    coalesce(nullif(new.email_error, ''), 'The email didn''t arrive') || '. Check the email address on their profile' ||
      case when coalesce(c.email, '') = '' then ' (there isn''t one)' else ' (' || c.email || ')' end || ', or contact them another way.',
    jsonb_build_object('page', 'candidates', 'candidateId', c.id),
    coalesce(nullif(btrim(new.email_message_id, '<> '), ''), 'chat:' || new.id::text));
  return new;
end $$;
drop trigger if exists candidate_job_messages_email_problem on public.candidate_job_messages;
create trigger candidate_job_messages_email_problem after insert or update of email_status on public.candidate_job_messages
  for each row execute function public.chat_email_problem();

-- 2. Every other email, from Brevo's delivery reports.
create or replace function public.email_event_problem() returns trigger
language plpgsql security definer set search_path = public as $$
declare what text; c record; m record; key text := coalesce(nullif(btrim(new.message_id, '<> '), ''), new.dedupe);
begin
  what := case new.event when 'hard_bounce' then 'bounced' when 'blocked' then 'was blocked' when 'invalid' then 'went to an invalid address'
    when 'invalid_email' then 'went to an invalid address' when 'error' then 'couldn''t be sent' when 'spam' then 'was marked as spam' else null end;
  if what is null then return new; end if;
  -- A client contact (a pitch or another outreach email we sent through Brevo).
  select om.id, om.to_name, om.to_email, om.approved_by, om.kind, l.company into m
    from outreach_messages om left join leads l on l.id = om.lead_id
   where om.provider = 'brevo' and btrim(om.provider_ref, '<> ') = btrim(new.message_id, '<> ') limit 1;
  if found and m.kind = 'client' then
    perform notify_email_problem(array[m.approved_by],
      'Client email to ' || coalesce(nullif(m.to_name, ''), m.to_email) || coalesce(' at ' || m.company, '') || ' ' || what,
      coalesce(nullif(new.subject, ''), 'Client email') || '. ' || coalesce(nullif(new.reason, ''), 'Check the contact''s address on the lead card.'),
      jsonb_build_object('page', 'campaigns'), key);
    return new;
  end if;
  -- A candidate.
  select id, name, recruiter_id into c from candidates where lower(email) = lower(btrim(new.email)) limit 1;
  if found then
    perform notify_email_problem(array[c.recruiter_id],
      'An email to ' || coalesce(c.name, 'a candidate') || ' ' || what,
      coalesce(nullif(new.subject, ''), 'An email') || '. ' || coalesce(nullif(new.reason, ''), 'Check the email address on their profile.'),
      jsonb_build_object('page', 'candidates', 'candidateId', c.id), key);
  end if;
  return new;
end $$;
drop trigger if exists email_events_problem on public.email_events;
create trigger email_events_problem after insert on public.email_events
  for each row execute function public.email_event_problem();
