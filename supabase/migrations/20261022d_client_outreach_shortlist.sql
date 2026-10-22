-- Client outreach, reworked (Outreach > Client leads):
--   * only Active file candidates; roles are looked for in the countries those candidates live
--     in, on-site/hybrid roles in their own country only (no remote roles from elsewhere)
--   * no per-role "may we put you forward?" email to candidates (they agreed when they said Yes
--     to future roles / joined the Active file)
--   * the first email to the hiring contact carries up to 5 qualified candidates at once, as
--     blind resumes behind a "View the candidates" button (/?t=s-<client_token>)
--   * when the company says it's interested (button on that page, or in the email), the contract
--     goes out automatically (Outreach > Setup > Contract); until one is set up, Admins are told
--     so they can send it themselves
alter table public.leads
  add column if not exists client_token uuid default gen_random_uuid(),
  add column if not exists client_viewed_at timestamptz,
  add column if not exists interested_at timestamptz,
  add column if not exists contract_sent_at timestamptz,
  add column if not exists contract_flagged_at timestamptz;
update public.leads set client_token = gen_random_uuid() where client_token is null;
create unique index if not exists leads_client_token_key on public.leads (client_token);
