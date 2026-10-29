-- Email problem alerts wait 30 minutes (29 Oct 2026). A chat message is saved as "not sent" for the
-- moment before its email goes out, and the alert fired on that, so every chat message raised a
-- false "didn't reach them". Now a possible problem is only noted; 30 minutes later it's checked
-- again and the alert goes out only if it's still a problem:
--   * a chat message still not sent, or bounced;
--   * any other email that bounced, was blocked, invalid or marked as spam, unless the same email
--     was delivered or opened afterwards.
-- Checked every 5 minutes (cron harbor-email-problems). Same people as before (the writer or the
-- approver, the candidate's recruiter and the Admins), once per email.

create table if not exists public.email_problem_checks (
  key text primary key,
  kind text not null check (kind in ('chat', 'event')),
  ref text not null,
  due_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.email_problem_checks enable row level security;

create or replace function public.chat_email_problem() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.sender <> 'recruiter' or new.email_status not in ('not_sent', 'bounced') then return new; end if;
  if tg_op = 'UPDATE' and old.email_status is not distinct from new.email_status then return new; end if;
  insert into email_problem_checks (key, kind, ref, due_at) values ('chat:' || new.id, 'chat', new.id::text, now() + interval '30 minutes')
    on conflict (key) do nothing;
  return new;
end $$;

create or replace function public.email_event_problem() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.event not in ('hard_bounce', 'blocked', 'invalid', 'invalid_email', 'error', 'spam') then return new; end if;
  insert into email_problem_checks (key, kind, ref, due_at)
    values ('event:' || coalesce(nullif(btrim(new.message_id, '<> '), ''), new.dedupe), 'event', new.id::text, now() + interval '30 minutes')
    on conflict (key) do nothing;
  return new;
end $$;

create or replace function public.process_email_problem_checks() returns int
language plpgsql security definer set search_path = public as $$
declare r record; m record; c record; e record; cm record; what text; n int := 0; k text;
begin
  for r in select * from email_problem_checks where due_at <= now() order by due_at limit 200 loop
    if r.kind = 'chat' then
      select * into m from candidate_job_messages where id = r.ref::uuid;
      if found and m.email_status in ('not_sent', 'bounced') and coalesce(m.email_error, '') not ilike '%unsubscribed%' then
        select ca.id, ca.name, ca.email, ca.recruiter_id into c from candidate_jobs cj join candidates ca on ca.id = cj.candidate_id where cj.id = m.link_id;
        if found then
          perform notify_email_problem(array[m.author_id, c.recruiter_id],
            'A chat message to ' || coalesce(c.name, 'a candidate') || ' didn''t reach them',
            coalesce(nullif(m.email_error, ''), 'The email didn''t arrive') || '. Check the email address on their profile' ||
              case when coalesce(c.email, '') = '' then ' (there isn''t one)' else ' (' || c.email || ')' end || ', or contact them another way.',
            jsonb_build_object('page', 'candidates', 'candidateId', c.id),
            coalesce(nullif(btrim(m.email_message_id, '<> '), ''), 'chat:' || m.id::text));
          n := n + 1;
        end if;
      end if;
    else
      select * into e from email_events where id = r.ref::bigint;
      -- Not if the same email reached them after all.
      if found and not exists (select 1 from email_events x where btrim(x.message_id, '<> ') = btrim(e.message_id, '<> ')
                                 and x.event in ('delivered', 'opened', 'unique_opened', 'click') and x.at >= e.at) then
        what := case e.event when 'hard_bounce' then 'bounced' when 'blocked' then 'was blocked' when 'invalid' then 'went to an invalid address'
          when 'invalid_email' then 'went to an invalid address' when 'error' then 'couldn''t be sent' when 'spam' then 'was marked as spam' end;
        k := coalesce(nullif(btrim(e.message_id, '<> '), ''), e.dedupe);
        select om.id, om.to_name, om.to_email, om.approved_by, om.kind, l.company into cm
          from outreach_messages om left join leads l on l.id = om.lead_id
         where om.provider = 'brevo' and btrim(om.provider_ref, '<> ') = btrim(e.message_id, '<> ') limit 1;
        if found and cm.kind = 'client' then
          perform notify_email_problem(array[cm.approved_by],
            'Client email to ' || coalesce(nullif(cm.to_name, ''), cm.to_email) || coalesce(' at ' || cm.company, '') || ' ' || what,
            coalesce(nullif(e.subject, ''), 'Client email') || '. ' || coalesce(nullif(e.reason, ''), 'Check the contact''s address on the lead card.'),
            jsonb_build_object('page', 'campaigns'), k);
          n := n + 1;
        else
          select id, name, recruiter_id into c from candidates where lower(email) = lower(btrim(e.email)) limit 1;
          if found then
            perform notify_email_problem(array[c.recruiter_id],
              'An email to ' || coalesce(c.name, 'a candidate') || ' ' || what,
              coalesce(nullif(e.subject, ''), 'An email') || '. ' || coalesce(nullif(e.reason, ''), 'Check the email address on their profile.'),
              jsonb_build_object('page', 'candidates', 'candidateId', c.id), k);
            n := n + 1;
          end if;
        end if;
      end if;
    end if;
    delete from email_problem_checks x where x.key = r.key;
  end loop;
  return n;
end $$;
revoke all on function public.process_email_problem_checks() from public, anon, authenticated;

select cron.unschedule('harbor-email-problems') where exists (select 1 from cron.job where jobname = 'harbor-email-problems');
select cron.schedule('harbor-email-problems', '*/5 * * * *', 'select public.process_email_problem_checks()');

-- The false "didn't reach them" alerts already sent for chat messages that did go out.
delete from public.assistant_updates u
 where u.dedupe like 'email-problem:chat:%'
   and exists (select 1 from candidate_job_messages m where 'email-problem:chat:' || m.id::text = u.dedupe and m.email_status in ('sent', 'delivered', 'opened', 'read'));
