-- Full-profile checks (People Data Labs) for Apollo people whose core must-haves aren't shown
-- anywhere free: a new kind of spending request an Admin approves (sourcing/profilecheck.ts).
alter table public.spend_requests drop constraint if exists spend_requests_kind_check;
alter table public.spend_requests add constraint spend_requests_kind_check
  check (kind = any (array['apollo_search', 'leads_fetch', 'xray_emails', 'pdl_search', 'pdl_profiles']));
