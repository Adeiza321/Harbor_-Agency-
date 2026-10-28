-- Client replies (28 Oct 2026). Client pitches and their follow-ups go out with a reply-to address
-- on our own reply subdomain (e.g. replies@reply.pronextglobal.com), whose mail Brevo receives and
-- posts to brevo-webhook. Each reply is kept here, matched to its lead, stops that lead's follow-ups
-- (unless it's an automatic reply such as out of office), and is forwarded to the team's mailbox
-- with the client as the reply-to, so answering it goes straight back to them.
create table if not exists public.client_replies (
  id uuid primary key default gen_random_uuid(),
  message_id text unique,
  lead_id uuid references public.leads(id) on delete set null,
  outreach_message_id uuid references public.outreach_messages(id) on delete set null,
  from_email text not null,
  from_name text,
  subject text,
  body text,
  auto boolean not null default false,       -- out of office / automatic reply: doesn't stop follow-ups
  spam boolean not null default false,
  attachments jsonb not null default '[]',
  matched_by text,                           -- thread | sender | contact | domain | null (no lead found)
  received_at timestamptz not null default now(),
  forwarded_at timestamptz,
  forward_error text
);
create index if not exists client_replies_lead on public.client_replies (lead_id, received_at desc);
create index if not exists client_replies_from on public.client_replies (lower(from_email));
alter table public.client_replies enable row level security;
drop policy if exists client_replies_staff_read on public.client_replies;
create policy client_replies_staff_read on public.client_replies for select to authenticated using (public.is_staff());

-- Where client replies go: { domain, status: dns | testing | on | off, testToken, testedAt, verifiedAt, webhookId }.
-- Kept apart from agency_settings.outreach, which the settings page saves as a whole.
alter table public.agency_settings add column if not exists replies jsonb not null default '{}'::jsonb;

-- The brevo-webhook token, for the sourcing function to register the inbound webhook with Brevo.
create or replace function public.brevo_webhook_secret() returns text
language sql security definer set search_path = public, extensions as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'brevo_webhook_token' limit 1
$$;
revoke all on function public.brevo_webhook_secret() from public, anon, authenticated;
grant execute on function public.brevo_webhook_secret() to service_role;
