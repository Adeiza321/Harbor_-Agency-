-- =====================================================================
-- 7 Oct 2026 — chat: email delivery ticks and file / picture attachments
--   * Recruiter messages are also emailed to the candidate (send-message). Brevo's message id
--     is stored and the email-status function (every minute) checks Brevo's events:
--       email_status 'sent'      accepted by Brevo, no result yet   -> clock
--                    'delivered' reached the candidate's inbox       -> two ticks
--                    'bounced'   bounced / blocked / rejected        -> one tick (red)
--                    'not_sent'  not emailed (no address, unsubscribed, send failed) -> one tick
--   * Attachments live in the private chat-files bucket at <link id>/<file>; the chat-file
--     function uploads them and hands out short-lived links.
-- =====================================================================

alter table public.candidate_job_messages
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text,
  add column if not exists attachment_size integer,
  add column if not exists email_status text check (email_status in ('sent', 'delivered', 'bounced', 'not_sent')),
  add column if not exists email_message_id text,
  add column if not exists email_status_at timestamptz,
  add column if not exists email_error text;

-- A message can be just a file.
alter table public.candidate_job_messages drop constraint if exists candidate_job_messages_body_check;
alter table public.candidate_job_messages add constraint candidate_job_messages_body_check
  check ((length(trim(body)) > 0 or attachment_path is not null) and length(body) <= 4000);
create index if not exists candidate_job_messages_email_pending_idx on public.candidate_job_messages (created_at) where email_status = 'sent';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-files', 'chat-files', false, 8388608, array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do nothing;
-- No storage policies: only the chat-file function (service role) reads or writes this bucket.

create or replace function public.chat_payload(p_link_id uuid, p_side text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'linkId', l.id, 'role', j.role_title, 'company', j.client,
    'candidate', jsonb_build_object('id', c.id, 'name', c.name, 'photo', c.photo_url),
    'recruiter', jsonb_build_object('name', split_part(coalesce(p.full_name, ''), ' ', 1), 'photo', p.avatar_url),
    'peerTypingAt', (select t.at from chat_typing t where t.link_id = l.id and t.who <> p_side),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender', m.sender, 'body', m.body, 'createdAt', m.created_at,
        'deliveredAt', m.delivered_at,
        'readAt', case when m.sender = 'candidate' then m.recruiter_read_at else m.candidate_read_at end,
        'emailStatus', m.email_status,
        'emailError', case when p_side = 'recruiter' then m.email_error end,
        'file', case when m.attachment_path is not null then jsonb_build_object('name', m.attachment_name, 'type', m.attachment_type, 'size', m.attachment_size) end)
        order by m.created_at)
      from candidate_job_messages m where m.link_id = l.id), '[]'::jsonb))
  from candidate_jobs l
  join jobs j on j.id = l.job_id
  join candidates c on c.id = l.candidate_id
  left join profiles p on p.id = c.recruiter_id
  where l.id = p_link_id
$$;
revoke all on function public.chat_payload(uuid, text) from public, anon, authenticated;

-- Every minute: ask Brevo what happened to recruiter emails still waiting for a result.
create or replace function public.call_email_status() returns bigint
language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/email-status',
    body := jsonb_build_object('action', 'poll'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select substring(pg_get_functiondef('public.call_interviews(text)'::regprocedure) from '''apikey'', ''([^'']+)''')),
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 60000)
  where exists (select 1 from candidate_job_messages where email_status = 'sent' and created_at > now() - interval '3 days');
$$;
revoke all on function public.call_email_status() from public, anon, authenticated;
select cron.unschedule('harbor-email-status') where exists (select 1 from cron.job where jobname = 'harbor-email-status');
select cron.schedule('harbor-email-status', '* * * * *', $$select public.call_email_status()$$);
