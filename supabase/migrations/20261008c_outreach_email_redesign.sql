-- First outreach emails are now built in the branded design (sourcing/outreach.ts): a short note,
-- a role overview, the must-have requirements and "I'm interested" / "Refer someone" buttons.
--   outreach_messages.html  the finished HTML version (body keeps the plain-text version)
--   jobs.outreach_brief     {key, summary, items}: the must-haves Claude picked for the job,
--                           reused until the description changes
-- The PDF role summary was dropped; the job-briefs bucket is no longer used.
alter table public.outreach_messages add column if not exists html text;
alter table public.jobs add column if not exists outreach_brief jsonb;
