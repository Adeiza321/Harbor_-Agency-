-- Emails for people the X-ray search found on LinkedIn are looked up in Apollo (1 credit per email
-- found), so they go through the same Admin approval as other paid steps.
alter table public.spend_requests drop constraint if exists spend_requests_kind_check;
alter table public.spend_requests add constraint spend_requests_kind_check
  check (kind = any (array['apollo_search', 'leads_fetch', 'xray_emails']));
