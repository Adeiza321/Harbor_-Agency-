-- Client side of client sourcing (23 Oct 2026).
--   * The pitch lists each candidate's must-haves met (lead_offers.client_musts) and links to their
--     blind resume. Opening it shows the terms in a pop-up (no fee to interview; a fee only on
--     hire): the client can close it and read the blind resume, or sign our agreement to unlock the
--     full resumes.
--   * client_agreements: one signature per client company (covers every candidate we send them),
--     with what they signed, who (name, title, company, company address, email), when, IP and
--     device, and the Agency's automatic countersignature (the point of contact).
--   * agency_settings.client_agreement: the terms (Admins edit them); agency_settings.client_poc:
--     the point of contact introduced to clients (default Ahmed) and their booking link.
--   * client_relations: per client company: feedback after a hire, whether they made the
--     arrangement permanent (we source every new role free, paid only on hire) and the monthly
--     check-ins.
--   * placements: the client's feedback request goes 7 days after the joining date.

alter table public.lead_offers add column if not exists client_musts jsonb not null default '[]';
alter table public.agency_settings
  add column if not exists client_agreement jsonb,
  add column if not exists client_poc jsonb;

create or replace function public.norm_company(p text) returns text language sql immutable as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g'),
    '\m(inc|llc|ltd|limited|corp|corporation|co|company|plc|group|holdings|the)\M', '', 'g'))
$$;

create table if not exists public.client_agreements (
  id uuid primary key default gen_random_uuid(),
  company_key text not null,
  company text not null,
  lead_id uuid references public.leads(id) on delete set null,
  version int not null default 1,
  title text not null,
  body text not null,
  fee_pct numeric not null,
  first_time boolean not null default false,
  signer_name text not null,
  signer_title text not null,
  signer_email text,
  company_address text not null,
  signed_at timestamptz not null default now(),
  ip text,
  user_agent text,
  agency_signer_name text,
  agency_signer_title text,
  agency_signed_at timestamptz
);
create index if not exists client_agreements_company_idx on public.client_agreements (company_key, signed_at desc);
alter table public.client_agreements enable row level security;
drop policy if exists client_agreements_read on public.client_agreements;
create policy client_agreements_read on public.client_agreements for select to authenticated using ((select public.is_staff()));
revoke insert, update, delete on public.client_agreements from anon, authenticated;

create table if not exists public.client_relations (
  id uuid primary key default gen_random_uuid(),
  company_key text not null unique,
  company text not null,
  contact_name text,
  contact_email text,
  token text not null unique default encode(gen_random_bytes(16), 'hex'),
  permanent boolean,
  permanent_at timestamptz,
  feedback jsonb not null default '[]',
  requests jsonb not null default '[]',
  last_checkin_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.client_relations enable row level security;
drop policy if exists client_relations_read on public.client_relations;
create policy client_relations_read on public.client_relations for select to authenticated using ((select public.is_staff()));
revoke insert, update, delete on public.client_relations from anon, authenticated;

alter table public.placements
  add column if not exists feedback_token text unique default encode(gen_random_bytes(16), 'hex'),
  add column if not exists feedback_sent_at timestamptz,
  add column if not exists feedback_note text;

-- Default point of contact: Ahmed (the Admin account), booking link to add in Agency settings.
update public.agency_settings set client_poc = jsonb_build_object('userId', (select id from profiles where email = 'a.sanni@pronextglobal.com' limit 1), 'bookingUrl', '')
 where client_poc is null;

-- The terms, a starting draft for an Admin to review in Agency settings > Client agreement.
-- Placeholders: {{client}} {{client_address}} {{agency_address}} {{date}} {{fee}} {{discount}}
update public.agency_settings set client_agreement = jsonb_build_object('title', 'Candidate Introduction Terms', 'version', 1, 'feePct', 10, 'firstTimeDiscountPct', 20, 'body', $terms$This Agreement is dated {{date}}.

## Parties
(1) PRONEXT OUTSOURCING AGENCY of {{agency_address}} (the "Agency"); and
(2) {{client}} of {{client_address}} (the "Client").

## 1. Introductions
1.1 The Agency introduces candidates to the Client for its vacancies. Introducing candidates and arranging interviews is free of charge.
1.2 A candidate is "introduced" when the Client receives their profile, anonymised or in full, from the Agency.

## 2. Fee
2.1 A fee is payable only if the Client, or any company in its group, employs or engages a candidate introduced by the Agency within 12 months of the introduction.
2.2 The fee is {{fee}} of the candidate's first-year annual gross salary.{{discount}}
2.3 There is no retainer and no other charge.

## 3. Payment
3.1 The Agency invoices the fee once the candidate has completed 60 days in the role. The invoice is payable within 14 days.
3.2 If the candidate leaves for any reason before completing 60 days, no fee is payable.

## 4. Guarantee
4.1 If the candidate leaves between day 61 and day 90 of their employment, the Agency will, at the Client's choice, find a replacement candidate free of charge or refund 50% of the fee.
4.2 The guarantee applies when the Client tells the Agency within 7 days of the candidate leaving and has paid the invoice on time.

## 5. The Client's obligations
5.1 The Client will tell the Agency promptly about any offer made to an introduced candidate, their start date and their salary.
5.2 The Client will not pass an introduced candidate's details to anyone else. If someone else employs or engages the candidate as a result, the fee in clause 2 is payable by the Client.
5.3 The Client will handle candidates' personal data only for its recruitment and in line with the data protection laws that apply to it.

## 6. Applicable law
6.1 Where the law of the place where the candidate is employed requires different terms (for example on fees, refunds or replacement periods), that law applies and these terms are read so that they comply with it.
6.2 Otherwise this Agreement is governed by the laws of England and Wales.

## 7. Signing
7.1 Signing this Agreement electronically, by typing a name, is as valid as a handwritten signature.
7.2 The person signing confirms that they are authorised to sign on behalf of the Client.
$terms$, 'updatedAt', now())
 where client_agreement is null;

-- The candidate's page names a client-lead employer once that company has signed our terms.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.candidate_portal(text)'::regprocedure);
  d := replace(d, 'case when j.lead_role then ''Confidential client'' else j.client end',
    'case when j.lead_role and not exists (select 1 from client_agreements ca where ca.company_key = public.norm_company(j.client)) then ''Confidential client'' else j.client end');
  execute d;
end $$;
