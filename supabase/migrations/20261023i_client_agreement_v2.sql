-- Client agreement v2 (23 Oct 2026): rewritten from the terms of business shared on 23 Oct (permanent
-- staff, direct hire), with Pronext's commercial terms: fee 10% of the first-year salary with the
-- first-time discount, invoiced after 60 days, 50% refund or a free replacement between day 61 and
-- day 90, local law first. The source text is supabase/terms/client-agreement-v2.md.
-- Placeholders: {{client}} {{client_company_no}} {{client_address}} {{agency_address}}
-- {{agency_company_no}} {{date}} {{fee}} {{discount}}
-- Signing also asks for the client's company number and website (both optional).

alter table public.client_agreements
  add column if not exists company_number text,
  add column if not exists website text;

update public.agency_settings set client_agreement = coalesce(client_agreement, '{}'::jsonb) || jsonb_build_object(
  'title', 'Terms of Business for the Introduction of Permanent Staff', 'version', 2, 'updatedAt', now(),
  'feePct', coalesce((client_agreement ->> 'feePct')::numeric, 10),
  'firstTimeDiscountPct', coalesce((client_agreement ->> 'firstTimeDiscountPct')::numeric, 20),
  'body', $terms$This Agreement is dated {{date}}.

## Parties
(1) PRONEXT OUTSOURCING AGENCY{{agency_company_no}}, of {{agency_address}} (the "Agency"); and
(2) {{client}}{{client_company_no}}, of {{client_address}} (the "Client").

## 1. Definitions
1.1 In these Terms:
"Candidate" means a person Introduced by the Agency to the Client for an Engagement, including any officer, employee or representative of a Candidate that is a company, and members of the Agency's own staff.
"Client" means the person, firm or company named above, together with any subsidiary or associated person, firm or company, to which the Candidate is Introduced.
"Engagement" means the engagement, employment or use of the Candidate by the Client, or by any third party to whom the Client has introduced the Candidate, on a permanent or temporary basis, whether under a contract of service or for services; under an agency, licence, franchise or partnership agreement; or through a limited company of which the Candidate is an officer, employee or representative. "Engage", "Engages" and "Engaged" are read accordingly.
"Introduction" means (i) the Agency passing to the Client a resume or information that identifies the Candidate, or could reasonably allow the Candidate to be identified, including an anonymised resume; or (ii) the Client's interview of a Candidate in person, by telephone or by any other means. "Introduces" and "Introduced" are read accordingly.
"Introduction Fee" means the fee payable by the Client to the Agency for an Introduction that results in an Engagement.
"Remuneration" means the gross annual salary or fees payable to the Candidate for the first 12 months of the Engagement, including any guaranteed bonus, commission, allowances and sign-on or inducement payments.
1.2 The singular includes the plural, and any gender includes every gender.
1.3 Headings are for convenience only and do not affect how these Terms are read.

## 2. The contract
2.1 These Terms are the contract between the Agency and the Client for the introduction of candidates to be engaged directly by the Client. They apply to every Candidate the Agency Introduces to the Client, now and in future. They are accepted by the Client signing them, by an Introduction leading to an Engagement, or by the Client passing information about a Candidate to a third party.
2.2 These Terms are the entire agreement between the parties and prevail over any other terms of business or purchase conditions put forward by the Client, unless a Director or Manager of the Agency agrees otherwise in writing.
2.3 No variation of these Terms is valid unless it is agreed in writing between a Director or Manager of the Agency and the Client, stating the date from which it applies.
2.4 The Agency acts as an employment agency (as defined in Section 13(2) of the Employment Agencies Act 1973) when Introducing Candidates to the Client for direct Engagement.

## 3. No charge unless the Client hires
3.1 Introducing Candidates and arranging interviews is free of charge. There is no retainer. The only charge is the Introduction Fee when the Client Engages a Candidate.

## 4. Notification and fees
4.1 The Client will:
(a) tell the Agency straight away the terms of any offer of an Engagement it makes to a Candidate;
(b) tell the Agency straight away when a Candidate accepts, with the Remuneration agreed and the start date, and give the Agency any supporting documents it reasonably asks for; and
(c) pay the Introduction Fee by the due date in clause 4.7.
4.2 The Introduction Fee is payable if the Client Engages a Candidate within 6 months of the latest of: (a) the Introduction; (b) the Client withdrawing an offer of an Engagement to the Candidate; or (c) the Candidate rejecting an offer of an Engagement.
4.3 The Introduction Fee is {{fee}} of the Candidate's Remuneration.{{discount}}
4.4 If the Agency finds that the actual Remuneration is different from what the Client told it, the Introduction Fee is recalculated on the actual Remuneration and the Client pays the difference.
4.5 Where the actual Remuneration is not known or cannot reasonably be worked out, the Introduction Fee is calculated on the typical market salary for a comparable role in the same location.
4.6 If, before the Engagement starts, the Agency and the Client agree that it is for a fixed term of less than 12 months, the Introduction Fee is reduced pro rata. If the Client extends the Engagement beyond that term, or Engages the Candidate again within 6 months of its end, a further fee is payable on the additional Remuneration, up to the fee that would have been payable for an Engagement of 12 months or more.
4.7 The Agency invoices the Introduction Fee once the Candidate has completed 60 days of the Engagement. The invoice is payable within 14 days of its date. No Introduction Fee is payable if the Engagement ends, for any reason, before the Candidate completes 60 days.
4.8 The Client pays without any set-off, deduction or withholding.
4.9 VAT or any similar tax is added to the Introduction Fee where it applies. The Agency may charge interest on any amount not paid by its due date under the Late Payment of Commercial Debts (Interest) Act 1998, at 8% a year above the Bank of England base rate, from the due date until payment.
4.10 If the Client does not pay by the due date, any discount (including the first-time client discount) no longer applies, and the Agency will invoice the difference.
4.11 If any member of the Agency's staff with whom the Client has dealt is Engaged by the Client while working for the Agency, or within 6 months of leaving it, the Client pays an Introduction Fee calculated on that person's Remuneration, with no refund or replacement.
4.12 If the Agency has to take legal action to enforce these Terms, including to recover payment, and the Client admits liability or is found liable, the Client pays the Agency's reasonable costs and expenses, including legal costs.

## 5. Guarantee
5.1 If, after completing 60 days, the Engagement ends before the Candidate completes 90 days because (a) the Candidate leaves, or (b) the Client ends it because the Candidate is not technically competent or has committed misconduct (but not where the Candidate is made redundant), the Agency will, at the Client's choice, find a replacement Candidate free of charge or refund 50% of the Introduction Fee.
5.2 The guarantee applies only if the Client has complied with clause 4.1, tells the Agency in writing within 7 days of the Engagement ending, and has paid the Agency's invoice by its due date.
5.3 The Engagement ends on the date the Candidate stops working for the Client, or would have stopped but for any garden leave or payment in lieu of notice, whichever is later.
5.4 There is no refund or replacement where clause 4.5 applies.
5.5 If the Client Engages the Candidate again within 6 months after a refund, the refund is repaid to the Agency and there is no further guarantee for that Candidate.

## 6. Introductions to third parties
6.1 Introductions are confidential. If the Client passes a Candidate's details to a third party and that third party Engages the Candidate within 6 months of the Agency's Introduction, the Client pays the Introduction Fee under clause 4, with no refund or replacement under clause 5.

## 7. Suitability checks
7.1 The Agency takes reasonably practicable steps to make sure that: (a) the Engagement would not be against the interests of the Client or the Candidate; (b) both are aware of any requirements imposed by law or by any professional body; and (c) the Candidate is willing to work in the position.
7.2 The Client must still satisfy itself that the Candidate is suitable for the position. The Client is responsible for: (a) taking up references before Engaging the Candidate; (b) checking the Candidate's right to work and obtaining any permission to work required by the law of the country where the Candidate will work; (c) any medical checks; and (d) any qualifications, licences or permissions the position requires.
7.3 So that the Agency can meet clause 7.1, the Client will give the Agency details of the position, including: the type of work; the location and hours; the experience, training, qualifications and authorisations needed; any known health and safety risks and the steps taken to control them; the start date; the likely duration; the minimum Remuneration, expenses and benefits offered; how often pay is made; and the notice period on each side.

## 8. Confidentiality and data protection
8.1 All information about a Candidate is confidential and is given only so that the Agency can provide its recruitment services to the Client. The Client will not use it for any other purpose or disclose it to any third party, and will handle it in line with the data protection laws that apply to it (including the UK GDPR and the Data Protection Act 2018 where they apply).
8.2 Information about the Agency's business that is capable of being confidential must also be kept confidential, except information that is in the public domain.

## 9. Liability
9.1 The Agency is not liable for any loss, expense, damage, delay, costs or compensation (whether direct, indirect or consequential) suffered by the Client arising from or connected with the Agency looking for a Candidate for the Client, the Introduction or Engagement of any Candidate, or the Agency not Introducing a Candidate. This does not exclude the Agency's liability for death or personal injury caused by its negligence, or any other liability that cannot be excluded by law.

## 10. Notices
10.1 Notices under these Terms must be in writing and may be delivered by hand, by first-class post to the other party's registered office or any other address it has given in writing, or by email. A notice is treated as served: if delivered by hand, on delivery; if posted, 48 hours after posting; if emailed, when sent.

## 11. Severability
11.1 If any part of these Terms is found unenforceable by a competent authority, that part is removed to that extent and the rest of these Terms stays in force to the fullest extent the law allows.

## 12. Applicable law
12.1 Where the law of the country in which the Candidate is Engaged requires different terms (for example on fees, refunds or guarantee periods), that law applies and these Terms are read so that they comply with it.
12.2 Otherwise these Terms are governed by the law of England and Wales, and the courts of England and Wales have exclusive jurisdiction.

## 13. Signing
13.1 Signing these Terms electronically, by typing a name, is as valid as a handwritten signature.
13.2 The person signing confirms that they are authorised to sign these Terms on behalf of the Client.
$terms$)
 where coalesce((client_agreement ->> 'version')::int, 1) < 2;
