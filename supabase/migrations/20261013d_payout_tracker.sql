-- Payout tracker (Billing): permanent placements pay once, after the guarantee period; contract
-- placements pay monthly (hourly rate x hours a week) for the length of the contract.
--   placements.pay_type        'one_off' (permanent) or 'monthly' (contract)
--   placements.hourly_rate     contract: what ProNext earns per hour worked
--   placements.hours_per_week  contract: usually 40
--   placements.contract_months contract: usually 6
--   placements.ended_on        contract: the last day, when it ended early (no more months after it)
--   agency_settings.revenue_goal  { amount, currency, by } shown as progress on Billing

alter table public.placements add column if not exists pay_type text not null default 'one_off';
alter table public.placements drop constraint if exists placements_pay_type_check;
alter table public.placements add constraint placements_pay_type_check check (pay_type in ('one_off', 'monthly'));
alter table public.placements add column if not exists hourly_rate numeric check (hourly_rate is null or hourly_rate >= 0);
alter table public.placements add column if not exists hours_per_week numeric default 40 check (hours_per_week is null or (hours_per_week > 0 and hours_per_week <= 80));
alter table public.placements add column if not exists contract_months integer check (contract_months is null or (contract_months > 0 and contract_months <= 60));
alter table public.placements add column if not exists ended_on date;

alter table public.agency_settings add column if not exists revenue_goal jsonb;
