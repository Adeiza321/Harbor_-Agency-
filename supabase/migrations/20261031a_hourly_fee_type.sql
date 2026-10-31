-- Contract roles paid by the hour (31 Oct 2026): the agency fee and the recruiter incentive can be
-- "hourly", an amount per hour worked, billed monthly at 40 hours a week x 4 weeks (160 hours).
alter table public.jobs drop constraint if exists jobs_billing_type_check;
alter table public.jobs add constraint jobs_billing_type_check check (billing_type = any (array['flat', 'percent', 'hourly']));
alter table public.jobs drop constraint if exists jobs_incentive_type_check;
alter table public.jobs add constraint jobs_incentive_type_check check (incentive_type = any (array['flat', 'percent', 'hourly']));

-- IT Analyst II (Williams): its $5 fee was saved as "$5 a month" before the per-hour option
-- existed; it's $5 per hour worked.
update public.jobs set billing_type = 'hourly'
 where id = 'fa95e3fb-ca50-4321-8a46-eb4cbd563fbf' and billing_type = 'flat' and billing_amount = 5 and billing_frequency = 'Monthly';
