-- People Data Labs searches go through the same spend approvals as Apollo (kind 'pdl_search').
alter table public.spend_requests drop constraint if exists spend_requests_kind_check;
alter table public.spend_requests add constraint spend_requests_kind_check
  check (kind = any (array['apollo_search', 'leads_fetch', 'xray_emails', 'pdl_search']));
