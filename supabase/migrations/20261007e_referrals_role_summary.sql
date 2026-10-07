-- Referrals from the public apply page, and the PDF role summary sent with first outreach emails.
--   applications.referrer  {name, email, note} of whoever referred the applicant (source 'referral')
--   job-briefs bucket      one-page role summaries (must-haves only, client never named), built by
--                          the sourcing function; public so the link in an email opens for anyone.
-- Agency settings: company.legalName ("Pronext Outsourcing Agency") is the name used in email footers.

alter table public.applications add column if not exists referrer jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-briefs', 'job-briefs', true, 2097152, array['application/pdf'])
on conflict (id) do nothing;

update public.agency_settings set company = coalesce(company, '{}'::jsonb) || '{"legalName":"Pronext Outsourcing Agency"}'::jsonb
where id = 1 and coalesce(company->>'legalName', '') = '';
