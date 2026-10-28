-- The last reminder to a candidate about a pitched role (only one is sent). When it was sent: if
-- they haven't acknowledged NO_REPLY_DAYS (3) later, the sourcing tick takes them off the role
-- (withdrawn_by 'no_response') and turns "Open to new roles" off for a year, as that email says.
-- Reminders sent before this (without that warning) have no final_reminder_at and are left alone.
alter table public.lead_offers add column if not exists final_reminder_at timestamptz;
