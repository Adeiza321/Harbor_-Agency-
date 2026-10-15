-- Chat: reactions on messages and voice messages.
-- Reactions: one per side per message, stored as {"recruiter": "👍", "candidate": "❤️"}; reacting
-- again with the same emoji (or with '') takes it off. Only a short list of emoji is allowed.
-- Voice messages are ordinary chat files with an audio type, so the chat-files bucket now takes audio.

alter table public.candidate_job_messages add column if not exists reactions jsonb not null default '{}'::jsonb;

create or replace function public.chat_reaction_ok(p_emoji text)
returns boolean language sql immutable as $$
  select coalesce(p_emoji, '') = '' or p_emoji = any (array['👍', '❤️', '😂', '😮', '😢', '🙏', '👏', '🎉'])
$$;

-- Candidate (portal token): react to a message in one of their own conversations.
create or replace function public.candidate_react(p_token text, p_message_id uuid, p_emoji text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cand_id uuid := portal_candidate_id(p_token); m record;
begin
  if not chat_reaction_ok(p_emoji) then raise exception 'That reaction isn''t available'; end if;
  select x.id, x.link_id, x.staff_id into m from candidate_job_messages x join candidate_jobs l on l.id = x.link_id
    where x.id = p_message_id and l.candidate_id = cand_id and x.deleted_at is null;
  if not found or not portal_thread_ok(m.link_id, m.staff_id) then raise exception 'This message is no longer available'; end if;
  update candidate_job_messages set reactions = case when coalesce(p_emoji, '') = '' then reactions - 'candidate'
      else reactions || jsonb_build_object('candidate', p_emoji) end
    where id = p_message_id;
  return (select reactions from candidate_job_messages where id = p_message_id);
end $$;
grant execute on function public.candidate_react(text, uuid, text) to anon, authenticated;

-- Staff (signed in): react to a message in their own conversation.
create or replace function public.staff_react(p_message_id uuid, p_emoji text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not chat_reaction_ok(p_emoji) then raise exception 'That reaction isn''t available'; end if;
  update candidate_job_messages m set reactions = case when coalesce(p_emoji, '') = '' then m.reactions - 'recruiter'
      else m.reactions || jsonb_build_object('recruiter', p_emoji) end
    where m.id = p_message_id and m.deleted_at is null and m.staff_id = auth.uid() and can_chat(m.link_id);
  if not found then raise exception 'This message is no longer available'; end if;
  return (select reactions from candidate_job_messages where id = p_message_id);
end $$;
revoke all on function public.staff_react(uuid, text) from public, anon;
grant execute on function public.staff_react(uuid, text) to authenticated;

-- Conversation payload: now with each message's reactions.
create or replace function public.chat_payload(p_link_id uuid, p_side text, p_viewer text, p_staff uuid)
returns jsonb language sql stable security definer set search_path = public as $function$
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
        'reactions', case when m.deleted_at is null then m.reactions else '{}'::jsonb end,
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
$function$;

-- Voice messages: audio in the private chat-files bucket.
update storage.buckets set allowed_mime_types = (
  select array(select distinct unnest(coalesce(allowed_mime_types, '{}') || array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'audio/wav']))
) where id = 'chat-files';
