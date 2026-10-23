-- Recruiter agreement (23 Oct 2026): recruiters sign it as part of their account setup. Once an Admin
-- publishes it (Agency settings > Recruiter agreement), a recruiter who hasn't signed sees it first
-- after signing in and can't use ProNext until they sign. One signature is enough: editing the
-- agreement later doesn't ask anyone to sign again (each signature keeps the exact text and
-- version they signed).
--   agency_settings.recruiter_agreement  { title, body, version, published, updatedAt, updatedBy }
--                                        body placeholders: {{agency}} {{recruiter}} {{date}}
--   recruiter_agreements                 one row per signature: the text as signed (placeholders
--                                        filled in), the typed name, when, and from which IP
--   profiles.agreement_signed_at         set by sign_recruiter_agreement only
alter table public.agency_settings add column if not exists recruiter_agreement jsonb;
alter table public.profiles add column if not exists agreement_signed_at timestamptz;

create table if not exists public.recruiter_agreements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  version int not null,
  title text not null,
  body text not null,
  signed_name text not null,
  signed_at timestamptz not null default now(),
  ip text,
  user_agent text
);
create index if not exists recruiter_agreements_user_idx on public.recruiter_agreements (user_id, signed_at desc);
alter table public.recruiter_agreements enable row level security;
drop policy if exists recruiter_agreements_read on public.recruiter_agreements;
create policy recruiter_agreements_read on public.recruiter_agreements for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff()));
revoke insert, update, delete on public.recruiter_agreements from anon, authenticated;

-- agreement_signed_at joins the fields only Admins, the service role or trusted functions change.
create or replace function public.protect_profile_privileged_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and coalesce(auth.role(), '') <> 'service_role' and coalesce(current_setting('pronext.trusted', true), '') <> '1' then
    new.role := old.role;
    new.level := old.level;
    new.status := old.status;
    new.suspended_at := old.suspended_at;
    new.suspended_by := old.suspended_by;
    new.suspended_reason := old.suspended_reason;
    new.inactive_warned_at := old.inactive_warned_at;
    new.agreement_signed_at := old.agreement_signed_at;
  end if;
  return new;
end $$;
revoke all on function public.protect_profile_privileged_fields() from public, anon, authenticated;

-- A recruiter signs the published agreement (the version they read; refused if it changed meanwhile).
create or replace function public.sign_recruiter_agreement(p_name text, p_version int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me record; a jsonb; agency text; body text; ip text; ua text; hdr json;
begin
  select id, role, full_name, agreement_signed_at into me from profiles where id = auth.uid() and status = 'Active';
  if me.id is null then raise exception 'Sign in first'; end if;
  if me.role <> 'recruiter' then raise exception 'Only recruiters sign the recruiter agreement'; end if;
  select recruiter_agreement, coalesce(nullif(company->>'legalName', ''), nullif(agency_name, ''), 'ProNext') into a, agency from agency_settings limit 1;
  if a is null or coalesce((a->>'published')::boolean, false) = false then raise exception 'There is no agreement to sign yet'; end if;
  if coalesce((a->>'version')::int, 1) <> p_version then raise exception 'The agreement was just updated. Read the new version, then sign'; end if;
  if length(trim(coalesce(p_name, ''))) < 3 then raise exception 'Type your full name to sign'; end if;
  body := replace(replace(replace(coalesce(a->>'body', ''), '{{agency}}', agency), '{{recruiter}}', trim(p_name)), '{{date}}', to_char(now(), 'FMDD FMMonth YYYY'));
  begin hdr := current_setting('request.headers', true)::json; exception when others then hdr := null; end;
  ip := left(split_part(coalesce(hdr->>'x-forwarded-for', hdr->>'cf-connecting-ip', ''), ',', 1), 80);
  ua := left(coalesce(hdr->>'user-agent', ''), 300);
  insert into recruiter_agreements (user_id, version, title, body, signed_name, ip, user_agent)
    values (me.id, coalesce((a->>'version')::int, 1), coalesce(nullif(a->>'title', ''), 'Recruiter agreement'), body, left(trim(p_name), 120), nullif(ip, ''), nullif(ua, ''));
  perform set_config('pronext.trusted', '1', true);
  update profiles set agreement_signed_at = now() where id = me.id;
  perform set_config('pronext.trusted', '', true);
  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
    values (me.id, 'signed', 'recruiter_agreement', me.id::text, 'Version ' || coalesce(a->>'version', '1') || ' as ' || left(trim(p_name), 120));
  return jsonb_build_object('ok', true, 'signedAt', now());
end $$;
revoke all on function public.sign_recruiter_agreement(text, int) from public, anon;
grant execute on function public.sign_recruiter_agreement(text, int) to authenticated;

-- A starting draft, unpublished, for the Agency to edit before anyone is asked to sign.
update public.agency_settings
   set recruiter_agreement = jsonb_build_object('title', 'Independent Recruiter Agreement', 'version', 1, 'published', false,
         'body', $draft$This Independent Recruiter Agreement (the "Agreement") is made between {{agency}} ("the Agency") and {{recruiter}} ("the Recruiter"), and takes effect on {{date}}, the date the Recruiter signs it in ProNext.

## 1. Relationship
1.1 The Recruiter is an independent contractor, not an employee, partner or agent of the Agency. Nothing in this Agreement creates employment.
1.2 The Recruiter is responsible for their own taxes, insurance, equipment and working hours, and may work for others, provided they keep to sections 5 and 6.
1.3 The Recruiter may not sign anything, make promises or negotiate terms on the Agency's behalf, unless the Agency agrees to it in writing.

## 2. The work
2.1 The Recruiter finds, screens and puts forward candidates for roles the Agency shares in ProNext, using ProNext for all submissions, notes and communication about those roles.
2.2 The Recruiter only puts a candidate forward with that candidate's clear permission for that role, and describes every candidate honestly. No CV, qualification or detail may be invented, exaggerated or changed without the candidate's agreement.
2.3 The Recruiter follows the Agency's instructions for each role (including any requirements, process and client rules shown in ProNext) and keeps candidate records up to date.

## 3. Candidate ownership
3.1 A candidate belongs to the Recruiter for a role when the Recruiter is the first to submit them for that role in ProNext, with the candidate's permission. Where two submissions conflict, ProNext's records decide.
3.2 Candidates and clients introduced through ProNext remain the Agency's business relationships.

## 4. Incentives and payment
4.1 For each successful placement, the Recruiter earns the incentive shown on that role in ProNext at the time the candidate was submitted, unless the Agency and the Recruiter agree otherwise in writing.
4.2 An incentive becomes payable only after the client has paid the Agency for the placement and any guarantee period has passed without the candidate leaving. If a placement falls through within the guarantee period, no incentive is due, and any incentive already paid for it may be deducted from future payments.
4.3 The Recruiter never charges candidates any fee.

## 5. Non-circumvention
5.1 During this Agreement and for 12 months after it ends, the Recruiter will not, directly or through anyone else, place with or offer recruitment services to any client or role they learned about through the Agency, without the Agency's written agreement.
5.2 The Recruiter will not encourage any client or candidate to deal with them instead of the Agency for roles shared through ProNext.

## 6. Confidentiality and data protection
6.1 Client names, roles, fees, candidate details and anything else the Recruiter learns through the Agency or ProNext are confidential. The Recruiter uses them only for the Agency's roles and does not share them with anyone else, during or after this Agreement.
6.2 Candidate personal data is handled in line with applicable data protection laws. The Recruiter keeps it secure, collects only what is needed, does not copy it outside ProNext, and deletes any copies they hold when asked or when this Agreement ends.
6.3 The Recruiter tells the Agency straight away about any loss or misuse of confidential information or personal data.

## 7. Use of ProNext
7.1 The Recruiter's ProNext account is personal. They keep their login (and two-factor authentication) secure and do not share it.
7.2 The Agency may suspend an account that breaks this Agreement, or that is not used for 30 days, and may reactivate it at its discretion.

## 8. Conduct
8.1 The Recruiter acts professionally and lawfully, treats candidates and clients with respect, and does not discriminate against anyone on any unlawful ground.

## 9. Ending the Agreement
9.1 Either party may end this Agreement at any time by notice in writing (email is enough).
9.2 Incentives earned on placements made before the Agreement ends remain payable under section 4. Sections 3, 5 and 6 continue after it ends.

## 10. General
10.1 This Agreement, together with the role details shown in ProNext, is the whole agreement between the parties about this work. The Agency may update it; any update applies from when the Recruiter is told about it.
10.2 This Agreement is governed by the laws of [COUNTRY OR STATE: Agency to fill in before publishing].

By signing below, the Recruiter confirms they have read and agree to this Agreement.
$draft$, 'updatedAt', now())
 where recruiter_agreement is null;
