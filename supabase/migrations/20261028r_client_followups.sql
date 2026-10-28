-- Follow-ups to a client pitch (28 Oct 2026), reviewed and sent by hand from the lead card:
-- which follow-up (1, 2 or 3) an email was. Null for the pitch itself and everything else.
alter table public.outreach_messages add column if not exists followup smallint;
create index if not exists outreach_messages_lead_followup on public.outreach_messages (lead_id, followup) where followup is not null;
