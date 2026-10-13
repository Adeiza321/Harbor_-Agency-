-- Private chats: a conversation is between one staff member and one candidate, about one role.
-- Before this, every message on a candidate/role link was one shared thread, so when an Admin
-- messaged a recruiter's candidate, the recruiter saw it too (and the other way round).
--
--   candidate_job_messages.staff_id   whose conversation the message belongs to. A staff message
--                                     belongs to its author; a candidate reply to the person
--                                     they're replying to.
--   Staff only see, read and delete messages in their own conversations (RLS and the chat
--   functions). The candidate sees one chat per person per role (candidate_portal 'chats').
--   Typing, "clear chat" and read receipts are per conversation as well.

alter table public.candidate_job_messages add column if not exists staff_id uuid references public.profiles(id) on delete set null;
create index if not exists candidate_job_messages_thread_idx on public.candidate_job_messages (link_id, staff_id, created_at);

-- Who a candidate talks to on a role when they start the chat: their own recruiter, else the
-- recruiter engaged on the job.
create or replace function public.chat_default_staff(p_link_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(c.recruiter_id,
    (select jr.recruiter_id from job_recruiters jr where jr.job_id = l.job_id limit 1))
  from candidate_jobs l join candidates c on c.id = l.candidate_id
  where l.id = p_link_id
$$;
revoke all on function public.chat_default_staff(uuid) from public, anon, authenticated;

-- Existing messages: staff messages belong to their author; candidate messages to whoever last
-- messaged them on that role before the reply (else their recruiter).
update public.candidate_job_messages set staff_id = author_id where sender = 'recruiter' and staff_id is null;
update public.candidate_job_messages m set staff_id = coalesce(
    (select p.staff_id from candidate_job_messages p where p.link_id = m.link_id and p.sender = 'recruiter' and p.created_at <= m.created_at order by p.created_at desc limit 1),
    (select p.staff_id from candidate_job_messages p where p.link_id = m.link_id and p.sender = 'recruiter' order by p.created_at limit 1),
    public.chat_default_staff(m.link_id))
  where m.sender = 'candidate' and m.staff_id is null;

-- New messages get their conversation automatically when the inserter doesn't say
-- (send-message, interviews and chat-file insert with author_id only).
create or replace function public.set_message_staff()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.staff_id is null then
    if new.sender = 'recruiter' then
      new.staff_id := new.author_id;
    else
      new.staff_id := coalesce(
        (select p.staff_id from candidate_job_messages p where p.link_id = new.link_id and p.sender = 'recruiter' and p.staff_id is not null order by p.created_at desc limit 1),
        public.chat_default_staff(new.link_id));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists candidate_job_messages_staff on public.candidate_job_messages;
create trigger candidate_job_messages_staff before insert on public.candidate_job_messages
  for each row execute function public.set_message_staff();

-- Row level security: your own conversations only (Admins and Rec Ops included).
alter policy cjmsg_read on public.candidate_job_messages
  using (staff_id = (select auth.uid()) and public.can_chat(link_id));
alter policy cjmsg_insert on public.candidate_job_messages
  with check (sender = 'recruiter' and author_id = (select auth.uid()) and staff_id = (select auth.uid()) and public.can_chat(link_id));
alter policy cjmsg_update on public.candidate_job_messages
  using (staff_id = (select auth.uid()) and public.can_chat(link_id))
  with check (staff_id = (select auth.uid()) and public.can_chat(link_id));

-- Typing is per conversation: who = 'recruiter:<staff id>' or 'candidate:<staff id>'.
alter table public.chat_typing drop constraint if exists chat_typing_who_check;
delete from public.chat_typing;

-- A candidate is allowed to talk to someone on a role if that person has messaged them there,
-- or is the person they'd start a chat with.
create or replace function public.portal_thread_ok(p_link_id uuid, p_staff uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_staff is not null and (p_staff = public.chat_default_staff(p_link_id)
    or exists (select 1 from candidate_job_messages m where m.link_id = p_link_id and m.staff_id = p_staff))
$$;
revoke all on function public.portal_thread_ok(uuid, uuid) from public, anon, authenticated;

-- The conversation a candidate means when they don't name one: the latest person to message
-- them on that role, else the person they'd start with.
create or replace function public.portal_thread_staff(p_link_id uuid, p_staff uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare s uuid := p_staff;
begin
  if s is null then
    select m.staff_id into s from candidate_job_messages m where m.link_id = p_link_id and m.staff_id is not null order by m.created_at desc limit 1;
    s := coalesce(s, public.chat_default_staff(p_link_id));
  end if;
  if not public.portal_thread_ok(p_link_id, s) then raise exception 'This conversation is no longer available'; end if;
  return s;
end $$;
revoke all on function public.portal_thread_staff(uuid, uuid) from public, anon, authenticated;

-- One conversation's messages, for either side.
create or replace function public.chat_payload(p_link_id uuid, p_side text, p_viewer text, p_staff uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with cl as (select cleared_at from chat_clears where link_id = p_link_id and viewer = p_viewer)
  select jsonb_build_object(
    'linkId', l.id, 'staffId', p_staff, 'role', j.role_title, 'company', j.client,
    'clearedAt', (select cleared_at from cl),
    'candidate', jsonb_build_object('id', c.id, 'name', c.name, 'photo', c.photo_url),
    'recruiter', jsonb_build_object('name', split_part(coalesce(p.full_name, ''), ' ', 1), 'photo', p.avatar_url, 'title', staff_title(p.role)),
    'peerTypingAt', (select t.at from chat_typing t where t.link_id = l.id
                       and t.who = (case when p_side = 'candidate' then 'recruiter:' else 'candidate:' end) || p_staff::text),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender', m.sender, 'createdAt', m.created_at,
        'deleted', m.deleted_at is not null,
        'body', case when m.deleted_at is null then m.body else '' end,
        'deliveredAt', m.delivered_at,
        'readAt', case when m.sender = 'candidate' then m.recruiter_read_at else m.candidate_read_at end,
        'emailStatus', m.email_status,
        'emailError', case when p_side = 'recruiter' then m.email_error end,
        'file', case when m.attachment_path is not null and m.deleted_at is null then jsonb_build_object('name', m.attachment_name, 'type', m.attachment_type, 'size', m.attachment_size) end)
        order by m.created_at)
      from candidate_job_messages m
      where m.link_id = l.id and m.staff_id = p_staff
        and m.created_at > coalesce((select cleared_at from cl), '-infinity'::timestamptz)), '[]'::jsonb))
  from candidate_jobs l
  join jobs j on j.id = l.job_id
  join candidates c on c.id = l.candidate_id
  left join profiles p on p.id = p_staff
  where l.id = p_link_id
$$;
-- Only ever called from inside the chat functions below.
revoke all on function public.chat_payload(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.chat_payload(uuid, text, text) from public, anon, authenticated;
revoke all on function public.chat_payload(uuid, text) from public, anon, authenticated;

-- ---- Staff side: always the signed-in person's own conversation ----
create or replace function public.staff_chat(p_link_id uuid, p_read boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not can_chat(p_link_id) then raise exception 'You don''t have access to this conversation'; end if;
  update candidate_job_messages set delivered_at = now()
    where link_id = p_link_id and staff_id = auth.uid() and sender = 'candidate' and delivered_at is null;
  if p_read then
    update candidate_job_messages set recruiter_read_at = now()
      where link_id = p_link_id and staff_id = auth.uid() and sender = 'candidate' and recruiter_read_at is null;
  end if;
  return chat_payload(p_link_id, 'recruiter', auth.uid()::text, auth.uid());
end $$;

create or replace function public.staff_clear_chat(p_link_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not can_chat(p_link_id) then raise exception 'You don''t have access to this conversation'; end if;
  update candidate_job_messages set recruiter_read_at = now()
    where link_id = p_link_id and staff_id = auth.uid() and sender = 'candidate' and recruiter_read_at is null;
  insert into chat_clears (link_id, viewer, cleared_at) values (p_link_id, auth.uid()::text, now())
    on conflict (link_id, viewer) do update set cleared_at = now();
end $$;

create or replace function public.staff_typing(p_link_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if can_chat(p_link_id) then
    insert into chat_typing (link_id, who, at) values (p_link_id, 'recruiter:' || auth.uid()::text, now())
      on conflict (link_id, who) do update set at = now();
  end if;
end $$;

create or replace function public.staff_mark_delivered()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update candidate_job_messages m set delivered_at = now()
    where m.sender = 'candidate' and m.delivered_at is null and m.staff_id = auth.uid() and can_chat(m.link_id);
end $$;

create or replace function public.staff_delete_message(p_message_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update candidate_job_messages m set deleted_at = now()
    where m.id = p_message_id and m.sender = 'recruiter' and m.deleted_at is null
      and m.staff_id = auth.uid() and m.author_id = auth.uid() and can_chat(m.link_id);
  if not found then raise exception 'You can only delete messages you sent'; end if;
end $$;

-- ---- Candidate side: one conversation per person, picked with p_staff ----
drop function if exists public.candidate_chat(text, uuid, boolean);
create or replace function public.candidate_chat(p_token text, p_link_id uuid, p_read boolean default false, p_staff uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token); s uuid;
begin
  if not exists (select 1 from candidate_jobs where id = p_link_id and candidate_id = cand_id) then
    raise exception 'This conversation is no longer available';
  end if;
  s := portal_thread_staff(p_link_id, p_staff);
  update candidate_job_messages set delivered_at = now()
    where link_id = p_link_id and staff_id = s and sender = 'recruiter' and delivered_at is null;
  if p_read then
    update candidate_job_messages set candidate_read_at = now()
      where link_id = p_link_id and staff_id = s and sender = 'recruiter' and candidate_read_at is null;
  end if;
  return chat_payload(p_link_id, 'candidate', 'candidate:' || s::text, s);
end $$;
grant execute on function public.candidate_chat(text, uuid, boolean, uuid) to anon, authenticated;

drop function if exists public.candidate_send_message(text, uuid, text);
create or replace function public.candidate_send_message(p_token text, p_link_id uuid, p_body text, p_staff uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cand_id uuid := portal_candidate_id(p_token);
  body_clean text := left(trim(coalesce(p_body, '')), 4000);
  s uuid;
begin
  if body_clean = '' then raise exception 'Write a message first'; end if;
  if not exists (select 1 from candidate_jobs where id = p_link_id and candidate_id = cand_id) then
    raise exception 'This conversation is no longer available';
  end if;
  s := portal_thread_staff(p_link_id, p_staff);
  insert into candidate_job_messages (link_id, sender, staff_id, body, candidate_read_at, recruiter_read_at)
    values (p_link_id, 'candidate', s, body_clean, now(), null);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.candidate_send_message(text, uuid, text, uuid) to anon, authenticated;

drop function if exists public.candidate_typing(text, uuid);
create or replace function public.candidate_typing(p_token text, p_link_id uuid, p_staff uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token); s uuid;
begin
  if exists (select 1 from candidate_jobs where id = p_link_id and candidate_id = cand_id) then
    s := portal_thread_staff(p_link_id, p_staff);
    insert into chat_typing (link_id, who, at) values (p_link_id, 'candidate:' || s::text, now())
      on conflict (link_id, who) do update set at = now();
  end if;
end $$;
grant execute on function public.candidate_typing(text, uuid, uuid) to anon, authenticated;

drop function if exists public.candidate_clear_chat(text, uuid);
create or replace function public.candidate_clear_chat(p_token text, p_link_id uuid, p_staff uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token); s uuid;
begin
  if not exists (select 1 from candidate_jobs where id = p_link_id and candidate_id = cand_id) then
    raise exception 'This conversation is no longer available';
  end if;
  s := portal_thread_staff(p_link_id, p_staff);
  update candidate_job_messages set candidate_read_at = now()
    where link_id = p_link_id and staff_id = s and sender = 'recruiter' and candidate_read_at is null;
  insert into chat_clears (link_id, viewer, cleared_at) values (p_link_id, 'candidate:' || s::text, now())
    on conflict (link_id, viewer) do update set cleared_at = now();
end $$;
grant execute on function public.candidate_clear_chat(text, uuid, uuid) to anon, authenticated;

drop function if exists public.candidate_mark_read(text, uuid);
create or replace function public.candidate_mark_read(p_token text, p_link_id uuid, p_staff uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token);
begin
  update candidate_job_messages set candidate_read_at = now()
    where link_id = p_link_id and sender = 'recruiter' and candidate_read_at is null
      and (p_staff is null or staff_id = p_staff)
      and exists (select 1 from candidate_jobs l where l.id = p_link_id and l.candidate_id = cand_id);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.candidate_mark_read(text, uuid, uuid) to anon, authenticated;

-- Earlier "clear chat" by a candidate covered the whole role: carry it over to each conversation.
insert into public.chat_clears (link_id, viewer, cleared_at)
  select x.link_id, 'candidate:' || t.staff_id::text, x.cleared_at
  from public.chat_clears x
  join (select distinct link_id, staff_id from public.candidate_job_messages where staff_id is not null) t on t.link_id = x.link_id
  where x.viewer = 'candidate'
on conflict (link_id, viewer) do nothing;

-- The candidate page: add 'chats', one per person they talk to on each role (people who've
-- messaged them, plus the person they'd start a chat with), newest first.
do $$
declare def text;
begin
  def := pg_get_functiondef('public.candidate_portal(text)'::regprocedure);
  if position('''chats''' in def) = 0 then
    def := replace(def, $r$'interviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,$r$, $r$'chats', coalesce((
      select jsonb_agg(x.chat order by x.last_at desc nulls last, x.link_created desc)
      from (
        select t.link_id, t.staff_id, l.created_at link_created,
          (select max(m.created_at) from candidate_job_messages m where m.link_id = t.link_id and m.staff_id = t.staff_id) last_at,
          jsonb_build_object(
            'linkId', t.link_id, 'staffId', t.staff_id, 'role', j.role_title, 'company', j.client,
            'name', split_part(coalesce(p.full_name, ''), ' ', 1), 'photo', p.avatar_url, 'title', staff_title(p.role),
            'unread', (select count(*) from candidate_job_messages m where m.link_id = t.link_id and m.staff_id = t.staff_id
                         and m.sender = 'recruiter' and m.candidate_read_at is null and m.deleted_at is null),
            'lastMessage', (select jsonb_build_object('sender', m.sender, 'body', case when m.deleted_at is null then m.body else '' end,
                                                      'deleted', m.deleted_at is not null, 'file', m.attachment_name, 'createdAt', m.created_at)
                            from candidate_job_messages m where m.link_id = t.link_id and m.staff_id = t.staff_id
                              and m.created_at > coalesce((select y.cleared_at from chat_clears y where y.link_id = t.link_id and y.viewer = 'candidate:' || t.staff_id::text), '-infinity'::timestamptz)
                            order by m.created_at desc limit 1)) chat
        from (
          select m.link_id, m.staff_id from candidate_job_messages m join candidate_jobs l2 on l2.id = m.link_id
            where l2.candidate_id = c.id and m.staff_id is not null
          union
          select l2.id, public.chat_default_staff(l2.id) from candidate_jobs l2
            where l2.candidate_id = c.id and public.chat_default_staff(l2.id) is not null
        ) t
        join candidate_jobs l on l.id = t.link_id and coalesce(l.candidate_response, 'accepted') <> 'declined'
        join jobs j on j.id = l.job_id
        left join profiles p on p.id = t.staff_id
      ) x), '[]'::jsonb),
    'interviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,$r$);
    if position('''chats''' in def) = 0 then raise exception 'candidate_portal: could not find where to add chats'; end if;
    execute def;
  end if;
end $$;
