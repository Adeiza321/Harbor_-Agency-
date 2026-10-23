-- Recruiter agreement, standard form (23 Oct 2026):
--   * parties named with their addresses: the Agency's from Agency settings (company address, else
--     the outreach business address), the Recruiter's typed when they sign; defined terms
--     (the "Agency", the "Recruiter"); body placeholders {{agency_address}} and {{recruiter_address}}
--   * countersigned for Pronext Outsourcing Agency by an Admin (name, title, uploaded signature,
--     stamped with the date and time), one agreement or all waiting at once
--   * an Admin can ask a recruiter to sign again (their old signed copy is kept)
--   * the agreement text replaced with the standard form (version 2, stays published)
alter table public.recruiter_agreements
  add column if not exists recruiter_address text,
  add column if not exists agency_signed_by uuid references public.profiles(id) on delete set null,
  add column if not exists agency_signer_name text,
  add column if not exists agency_signer_title text,
  add column if not exists agency_signature text check (agency_signature is null or (agency_signature ~ '^data:image/(png|jpeg);base64,' and length(agency_signature) < 600000)),
  add column if not exists agency_signed_at timestamptz;

create or replace function public.sign_recruiter_agreement(p_name text, p_version int, p_signature text, p_address text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me record; a jsonb; agency text; agency_addr text; body text; ip text; ua text; hdr json;
begin
  select id, role, full_name into me from profiles where id = auth.uid() and status = 'Active';
  if me.id is null then raise exception 'Sign in first'; end if;
  if me.role <> 'recruiter' then raise exception 'Only recruiters sign the recruiter agreement'; end if;
  select recruiter_agreement, coalesce(nullif(company->>'legalName', ''), nullif(agency_name, ''), 'ProNext'),
         coalesce(nullif(company->>'address', ''), nullif(outreach->>'businessAddress', ''), '')
    into a, agency, agency_addr from agency_settings limit 1;
  if a is null or coalesce((a->>'published')::boolean, false) = false then raise exception 'There is no agreement to sign yet'; end if;
  if coalesce((a->>'version')::int, 1) <> p_version then raise exception 'The agreement was just updated. Read the new version, then sign'; end if;
  if length(trim(coalesce(p_name, ''))) < 3 then raise exception 'Type your full name to sign'; end if;
  if length(trim(coalesce(p_address, ''))) < 8 then raise exception 'Type your full address'; end if;
  if coalesce(p_signature, '') !~ '^data:image/(png|jpeg);base64,' or length(p_signature) >= 600000 then raise exception 'Upload a picture of your signature (PNG or JPG) to sign'; end if;
  body := replace(replace(replace(replace(replace(coalesce(a->>'body', ''),
            '{{agency}}', agency), '{{agency_address}}', agency_addr), '{{recruiter}}', trim(p_name)),
            '{{recruiter_address}}', left(trim(p_address), 300)), '{{date}}', to_char(now() at time zone 'Africa/Lagos', 'FMDD FMMonth YYYY'));
  begin hdr := current_setting('request.headers', true)::json; exception when others then hdr := null; end;
  ip := left(split_part(coalesce(hdr->>'x-forwarded-for', hdr->>'cf-connecting-ip', ''), ',', 1), 80);
  ua := left(coalesce(hdr->>'user-agent', ''), 300);
  insert into recruiter_agreements (user_id, version, title, body, signed_name, signature, recruiter_address, ip, user_agent)
    values (me.id, coalesce((a->>'version')::int, 1), coalesce(nullif(a->>'title', ''), 'Recruiter agreement'), body, left(trim(p_name), 120), p_signature,
            left(trim(p_address), 300), nullif(ip, ''), nullif(ua, ''));
  perform set_config('pronext.trusted', '1', true);
  update profiles set agreement_signed_at = now() where id = me.id;
  perform set_config('pronext.trusted', '', true);
  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
    values (me.id, 'signed', 'recruiter_agreement', me.id::text, 'Version ' || coalesce(a->>'version', '1') || ' as ' || left(trim(p_name), 120));
  return jsonb_build_object('ok', true, 'signedAt', now());
end $$;
revoke all on function public.sign_recruiter_agreement(text, int, text, text) from public, anon;
grant execute on function public.sign_recruiter_agreement(text, int, text, text) to authenticated;

-- Countersigned for the Agency by an Admin: one or more signed agreements not yet countersigned.
create or replace function public.countersign_recruiter_agreements(p_ids uuid[], p_name text, p_title text, p_signature text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'Only an Admin can sign for Pronext Outsourcing Agency'; end if;
  if length(trim(coalesce(p_name, ''))) < 3 then raise exception 'Type the name of the person signing'; end if;
  if length(trim(coalesce(p_title, ''))) < 2 then raise exception 'Type their job title'; end if;
  if coalesce(p_signature, '') !~ '^data:image/(png|jpeg);base64,' or length(p_signature) >= 600000 then raise exception 'Upload a picture of the signature (PNG or JPG)'; end if;
  update recruiter_agreements set agency_signed_by = auth.uid(), agency_signer_name = left(trim(p_name), 120), agency_signer_title = left(trim(p_title), 120),
      agency_signature = p_signature, agency_signed_at = now()
   where id = any(p_ids) and agency_signed_at is null;
  get diagnostics n = row_count;
  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
    values (auth.uid(), 'countersigned', 'recruiter_agreement', array_to_string(p_ids, ','), n || ' agreement(s) as ' || left(trim(p_name), 120));
  return jsonb_build_object('ok', true, 'signed', n);
end $$;
revoke all on function public.countersign_recruiter_agreements(uuid[], text, text, text) from public, anon;
grant execute on function public.countersign_recruiter_agreements(uuid[], text, text, text) to authenticated;

-- Ask a recruiter to sign the current agreement again (Admins). Their earlier signed copy is kept.
create or replace function public.reset_recruiter_agreement(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an Admin can do this'; end if;
  perform set_config('pronext.trusted', '1', true);
  update profiles set agreement_signed_at = null where id = p_user and role = 'recruiter';
  perform set_config('pronext.trusted', '', true);
  insert into audit_log (actor_id, action, entity_type, entity_id, detail) values (auth.uid(), 'asked to sign again', 'recruiter_agreement', p_user::text, null);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.reset_recruiter_agreement(uuid) from public, anon;
grant execute on function public.reset_recruiter_agreement(uuid) to authenticated;

-- The standard-form text, as version 2 (published stays as it was).
update public.agency_settings
   set recruiter_agreement = coalesce(recruiter_agreement, '{}'::jsonb) || jsonb_build_object('title', 'Independent Recruiter Agreement',
         'version', coalesce((recruiter_agreement->>'version')::int, 1) + 1, 'updatedAt', now(),
         'body', $draft$This Agreement is dated {{date}}.

## Parties
(1) PRONEXT OUTSOURCING AGENCY of 94 Ayanguren Road, Ikorodu, Lagos State, Nigeria (the "Agency"); and
(2) {{recruiter}} of {{recruiter_address}} (the "Recruiter"),
each a "Party" and together the "Parties".

## Background
(A) The Agency provides recruitment services to its clients and shares their vacancies with recruiters through its online platform, ProNext ("ProNext").
(B) The Recruiter is an independent recruiter who wishes to find and introduce candidates for those vacancies.
(C) The Parties have agreed that the Recruiter will do so on the terms of this Agreement (the "Agreement").

## 1. Definitions
1.1 In this Agreement:
"Candidate" means a person the Recruiter introduces for a Role;
"Client" means a business that engages the Agency to fill a Role;
"Confidential Information" has the meaning given in clause 7.1;
"Incentive" means the payment described in clause 5;
"Placement" means a Candidate accepting employment or an engagement with a Client, for the Role or any other position, within 12 months of the Recruiter introducing them to that Client; and
"Role" means a vacancy the Agency shares with the Recruiter in ProNext.
1.2 Headings do not affect the meaning of this Agreement. Words in the singular include the plural and the other way round.

## 2. Appointment and relationship
2.1 The Agency appoints the Recruiter, on a non-exclusive basis, to find, screen and introduce Candidates for Roles.
2.2 The Recruiter is an independent contractor, not an employee, worker, partner or agent of the Agency. Nothing in this Agreement creates an employment relationship.
2.3 The Recruiter is responsible for their own taxes, insurance, equipment, expenses and working hours, and may work for others, provided they comply with clauses 6, 7 and 8.
2.4 The Recruiter has no authority to bind the Agency, make promises or negotiate terms on its behalf, unless the Agency agrees in writing.

## 3. The Recruiter's obligations
3.1 The Recruiter shall use ProNext for all submissions, notes and communications about Roles, and keep Candidate records accurate and up to date.
3.2 The Recruiter shall introduce a Candidate for a Role only with that Candidate's clear permission for that Role.
3.3 The Recruiter shall describe every Candidate honestly and shall not invent, exaggerate or alter any CV, qualification or other detail without the Candidate's agreement.
3.4 The Recruiter shall follow the Agency's reasonable instructions for each Role, including the requirements, process and Client rules shown in ProNext.

## 4. Candidate ownership
4.1 A Candidate is credited to the Recruiter for a Role when the Recruiter is the first to submit them for that Role in ProNext, with the Candidate's permission. Where submissions conflict, ProNext's records are conclusive.
4.2 All Clients, and all relationships with Clients and Candidates arising through ProNext, belong to the Agency.

## 5. Incentives and payment
5.1 For each Placement of a Candidate credited to the Recruiter, the Agency shall pay the Recruiter the Incentive shown for that Role in ProNext at the time the Candidate was submitted, unless the Parties agree otherwise in writing.
5.2 An Incentive becomes payable only after the Client has paid the Agency for the Placement in full and any guarantee period has passed without the Candidate leaving.
5.3 If a Placement ends within its guarantee period, no Incentive is due for it, and the Agency may deduct any Incentive already paid for it from future payments to the Recruiter.
5.4 The Recruiter shall never charge a Candidate any fee.
5.5 The Recruiter is responsible for all taxes on the Incentives. The Agency may deduct any tax it is required by law to withhold.

## 6. Non-circumvention and non-solicitation
6.1 During this Agreement and for 12 months after it ends, the Recruiter shall not, directly or indirectly, place a Candidate with, or offer recruitment services to, any Client or for any Role they learned about through the Agency, without the Agency's prior written consent.
6.2 The Recruiter shall not encourage any Client or Candidate to deal with the Recruiter, or anyone else, instead of the Agency in connection with any Role.

## 7. Confidentiality
7.1 "Confidential Information" means all information the Recruiter receives through the Agency or ProNext, including Client names, Roles, fees, Candidate details and the Agency's business and methods.
7.2 The Recruiter shall keep Confidential Information secret, use it only to perform this Agreement, and not disclose it to anyone, during this Agreement or after it ends.
7.3 Clause 7.2 does not apply to information that is already public through no fault of the Recruiter, or that the law requires the Recruiter to disclose.

## 8. Data protection
8.1 The Recruiter shall handle all Candidate personal data in line with the Nigeria Data Protection Act 2023 and any other data protection law that applies.
8.2 The Recruiter shall keep personal data secure, collect only what is needed, not copy it outside ProNext, and delete any copies they hold when the Agency asks or when this Agreement ends.
8.3 The Recruiter shall tell the Agency without delay about any loss or misuse of Confidential Information or personal data.

## 9. Use of ProNext
9.1 The Recruiter's ProNext account is personal to them. The Recruiter shall keep their login and two-factor authentication secure and shall not share them.
9.2 The Agency may suspend the Recruiter's account if the Recruiter breaches this Agreement or does not use ProNext for 30 days, and may reactivate it at its discretion.

## 10. Conduct
10.1 The Recruiter shall act professionally and lawfully, treat Candidates and Clients with respect, and not discriminate against anyone on any unlawful ground.

## 11. Term and termination
11.1 This Agreement starts on the date it is signed by the Recruiter and continues until ended under this clause.
11.2 Either Party may end this Agreement at any time by written notice to the other, including by email.
11.3 Incentives for Placements made before this Agreement ends remain payable under clause 5. Clauses 4, 6, 7, 8 and 12 continue to apply after it ends.

## 12. Liability
12.1 The Recruiter shall indemnify the Agency against any loss, claim or cost the Agency suffers as a result of the Recruiter breaching clause 3, 7 or 8.
12.2 Neither Party is liable to the other for any indirect or consequential loss.

## 13. Notices
13.1 Notices under this Agreement must be in writing and may be sent by email to the address each Party uses in ProNext.

## 14. General
14.1 This Agreement, together with the Role details shown in ProNext, is the entire agreement between the Parties about its subject matter.
14.2 The Agency may update this Agreement. An update applies from the date the Agency notifies the Recruiter of it.
14.3 The Recruiter may not assign or transfer any rights or obligations under this Agreement without the Agency's written consent.
14.4 If any provision of this Agreement is found invalid, the rest of it remains in force.
14.5 The Parties agree that signing this Agreement electronically in ProNext, including with an uploaded image of a signature, is as valid and binding as a handwritten signature.

## 15. Governing law and jurisdiction
15.1 This Agreement is governed by the laws of Lagos State, Nigeria.
15.2 The courts of Lagos State, Nigeria have exclusive jurisdiction over any dispute arising out of or in connection with this Agreement.

This Agreement has been entered into on the date stated at the beginning of it.
$draft$)
 where coalesce(recruiter_agreement->>'body', '') not like '%{{recruiter_address}}%';
