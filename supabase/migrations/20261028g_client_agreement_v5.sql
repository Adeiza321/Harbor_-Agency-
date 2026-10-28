-- Client agreement v5 (28 Oct 2026): more Closing Events and a 12-month limit on Active.
--   * 4.2(b): a Candidate stays Active for at most 12 months from when they became Active.
--   * 4.2(c): Closing Events also include the candidate withdrawing, and any other action showing
--     the client has stopped its process for the candidate (role cancelled, closed or filled).
--   * 4.1(c): the client reports those too.
-- Source text: supabase/terms/client-agreement-v5.md. Signed agreements keep the text they signed.
update public.agency_settings set client_agreement = coalesce(client_agreement, '{}'::jsonb) || jsonb_build_object(
  'version', 5, 'updatedAt', now(),
  'body', $terms$This Agreement is dated {{date}}.

## Parties
(1) PRONEXT OUTSOURCING AGENCY, of {{agency_address}} (the "Agency"); and
(2) {{client}}{{client_company_no}}, of {{client_address}} (the "Client").

## 1. Definitions
1.1 In these Terms:
"Candidate" means a person Introduced by the Agency to the Client for an Engagement, including any officer, employee or representative of a Candidate that is a company, and members of the Agency's own staff.
"Client" means the person, firm or company named above, together with any subsidiary or associated person, firm or company, to which the Candidate is Introduced.
"Engagement" means the engagement, employment or use of the Candidate by the Client, or by any third party to whom the Client has introduced the Candidate, in any role (including a role other than the one the Candidate was Introduced for), on a permanent or temporary basis, whether under a contract of service or for services; under an agency, licence, franchise or partnership agreement; or through a limited company of which the Candidate is an officer, employee or representative. "Engage", "Engages" and "Engaged" are read accordingly.
"Introduction" means (i) the Agency passing to the Client a resume or information that identifies the Candidate, or could reasonably allow the Candidate to be identified, including an anonymised resume; or (ii) the Client's interview of a Candidate in person, by telephone or by any other means. "Introduces" and "Introduced" are read accordingly.
"Introduction Fee" means the fee payable by the Client to the Agency for an Introduction that results in an Engagement.
"Fee Period" has the meaning given in clause 4.2.
"Remuneration" means the gross annual salary or fees payable to the Candidate for the first 12 months of the Engagement, including any guaranteed bonus, commission, allowances and sign-on or inducement payments.
"Start Date" means the first day the Candidate starts work under the Engagement.
1.2 The singular includes the plural, and any gender includes every gender.
1.3 Headings are for convenience only and do not affect how these Terms are read.
1.4 Days are calendar days unless business days are stated. Where these Terms refer to the Candidate completing a number of days of the Engagement (for example 30, 60 or 90 days), the days are counted from the Start Date, which is day 1.

## 2. The contract
2.1 These Terms are the contract between the Agency and the Client for the introduction of candidates to be engaged directly by the Client. They apply to every Candidate the Agency Introduces to the Client, now and in future. They are accepted by the Client signing them, by an Introduction leading to an Engagement, or by the Client passing information about a Candidate to a third party.
2.2 These Terms are the entire agreement between the parties and prevail over any other terms of business or purchase conditions put forward by the Client, unless a Director or Manager of the Agency agrees otherwise in writing.
2.3 No variation of these Terms is valid unless it is agreed in writing between a Director or Manager of the Agency and the Client, stating the date from which it applies.
2.4 The Agency acts as an independent recruitment agency, introducing Candidates for direct Engagement by the Client. The Agency is not the employer of any Candidate the Client Engages.

## 3. No charge unless the Client hires
3.1 Introducing Candidates and arranging interviews is free of charge. There is no retainer. The only charge is the Introduction Fee when the Client Engages a Candidate.

## 4. Notification and fees
4.1 The Client will:
(a) tell the Agency straight away the terms of any offer of an Engagement it makes to a Candidate;
(b) tell the Agency straight away when a Candidate accepts, with the Remuneration agreed and the Start Date, and give the Agency any supporting documents it reasonably asks for;
(c) tell the Agency in writing straight away if it rejects a Candidate, withdraws an offer to a Candidate, or stops its process for a Candidate in any other way (for example, by cancelling, closing or filling the role); and
(d) pay the Introduction Fee by the due date in clause 4.7.
4.2 When the Introduction Fee is payable:
(a) The Client pays the Introduction Fee for a Candidate if (i) the Client and the Candidate agree an Engagement (for example, the Candidate accepts an offer) during that Candidate's Fee Period, which is the time the Candidate is Active with the Client plus any Cooling Period; and (ii) the Candidate then starts work under that Engagement. No Introduction Fee is payable for a Candidate who never starts work.
(b) Active: a Candidate is Active with the Client from the date the Agency first Introduces them, for example by sending their anonymised resume, for the role they were Introduced for and for any other role with the Client. The Candidate stays Active until the earlier of (i) a Closing Event and (ii) 12 months after the date they became Active.
(c) Closing Event: each of the following is a Closing Event: (i) the Client rejects the Candidate; (ii) the Client withdraws an offer of an Engagement to the Candidate, for any reason; (iii) the Candidate turns down an offer of an Engagement from the Client; (iv) the Candidate withdraws from the Client's process; or (v) the Client takes any other action that shows it has stopped its process for the Candidate, for example cancelling or closing the role, or filling it with someone else, where the Candidate is not being considered for another role with the Client. The date of a Closing Event is the date it is first communicated in writing to the Agency or to the other party or, if it is not communicated, the date the Agency becomes aware of it.
(d) Cooling Period: after a Closing Event, the Candidate is no longer Active and a Cooling Period of 6 months runs from the date of the Closing Event. The Introduction Fee is payable for an Engagement agreed during the Cooling Period.
(e) If, during the Cooling Period, the Client considers the Candidate again (for example, by contacting, interviewing or making an offer to the Candidate, for any role), the Candidate becomes Active again from that date, under paragraphs (b) to (d).
(f) The Introduction Fee becomes due when the Candidate starts work, and is invoiced and paid as set out in clauses 4.7 and 4.8.
(g) Example: the Agency sends a Candidate's anonymised resume on 1 March and the Client interviews them in April. On 2 May the Client tells the Agency it is not going ahead with the Candidate, so the Cooling Period runs until 2 November. If the Client and the Candidate agree an Engagement on 15 September and the Candidate starts on 1 December, the Introduction Fee is payable. Had they agreed it on 5 November, after the Cooling Period, no Introduction Fee would be payable. Had nothing happened after the interview, the Candidate would have stayed Active until 1 March of the following year, and the Introduction Fee would be payable for an Engagement agreed by then.
4.3 The Introduction Fee is {{fee}} of the Candidate's Remuneration.{{discount}}
4.4 If the Agency finds that the actual Remuneration is different from what the Client told it, the Introduction Fee is recalculated on the actual Remuneration and the Client pays the difference.
4.5 Where the actual Remuneration is not known or cannot reasonably be worked out, the Introduction Fee is calculated on the typical market salary for a comparable role in the same location.
4.6 If, before the Engagement starts, the Agency and the Client agree that it is for a fixed term of less than 12 months, the Introduction Fee is reduced pro rata. If the Client extends the Engagement beyond that term, or Engages the Candidate again within 6 months of its end, a further fee is payable on the additional Remuneration, up to the fee that would have been payable for an Engagement of 12 months or more.
4.7 The Agency invoices the Introduction Fee once the Candidate has completed 30 days of the Engagement. The invoice is payable within 5 business days (in the Client's country) after the Candidate's 60th day of the Engagement (the "due date"). The Introduction Fee is invoiced in the currency of the Candidate's Remuneration, unless the parties agree otherwise in writing.
4.8 If the Engagement ends, for any reason, before the Candidate completes 60 days, no Introduction Fee is payable and the Agency will cancel its invoice (or refund anything already paid), provided the Client tells the Agency in writing within 7 days of the Engagement ending.
4.9 The Client pays without any set-off or deduction. If the law requires the Client to withhold tax from the payment, the Client will tell the Agency before paying and give the Agency the official receipt or certificate for the tax withheld.
4.10 Sales taxes (such as VAT, GST or sales tax) are added to the Introduction Fee where they apply. The Agency may charge interest on any amount not paid by its due date at 1% a month, or the highest rate the applicable law allows if that is lower, from the due date until payment.
4.11 If the Client does not pay by the due date, any discount (including the first-time client discount) no longer applies, and the Agency will invoice the difference.
4.12 If any member of the Agency's staff with whom the Client has dealt is Engaged by the Client while working for the Agency, or within 6 months of leaving it, the Client pays an Introduction Fee calculated on that person's Remuneration, with no refund or replacement.
4.13 If the Agency has to take action to recover a payment due under these Terms, the Client pays the Agency's reasonable costs of doing so, including collection and legal costs, where the applicable law allows.
4.14 Candidates the Client already knows: if, before the Agency's Introduction, the Client already knew a Candidate from another source (for example, the Candidate applied to the Client directly or was introduced by another agency), the Client must tell the Agency in writing within 3 business days of learning the Candidate's identity, with evidence dated before the Agency's Introduction showing when and how it came to know the Candidate. If it does, no Introduction Fee is payable for that Candidate under these Terms. If it does not, the Agency's Introduction is treated as the introduction that led to any Engagement of that Candidate, and the Introduction Fee is payable under clause 4.2.

## 5. Guarantee
5.1 If, after completing 60 days, the Engagement ends before the Candidate completes 90 days because (a) the Candidate leaves, or (b) the Client ends it because the Candidate is not technically competent or has committed misconduct (but not where the Candidate is made redundant), the Agency will, at the Client's choice, find a replacement Candidate free of charge or refund 50% of the Introduction Fee.
5.2 The guarantee applies only if the Client has complied with clause 4.1, tells the Agency in writing within 7 days of the Engagement ending, and has paid the Agency's invoice by its due date. The Client chooses between a replacement and a refund when it tells the Agency.
5.3 The Engagement ends on the date the Candidate stops working for the Client, or would have stopped but for any garden leave or payment in lieu of notice, whichever is later.
5.4 There is no refund or replacement where clause 4.5 applies.
5.5 A replacement is offered once for each position. If the Agency cannot introduce a suitable replacement who is Engaged within 60 days of the Client choosing a replacement, the Agency will refund 50% of the Introduction Fee instead. A replacement Candidate is not covered by a further guarantee.
5.6 If the Client Engages the Candidate again within 6 months after a refund, the refund is repaid to the Agency and there is no further guarantee for that Candidate.

## 6. Introductions to third parties
6.1 Introductions are confidential. If the Client passes a Candidate's details to a third party and that third party agrees an Engagement with the Candidate during the Candidate's Fee Period (clause 4.2) and the Candidate starts work, the Client pays the Introduction Fee under clause 4, with no refund or replacement under clause 5.

## 7. Suitability checks
7.1 The Agency takes reasonably practicable steps to make sure that: (a) the Engagement would not be against the interests of the Client or the Candidate; (b) both are aware of any requirements imposed by law or by any professional body; and (c) the Candidate is willing to work in the position.
7.2 The Client must still satisfy itself that the Candidate is suitable for the position. The Client is responsible for: (a) taking up references before Engaging the Candidate; (b) checking the Candidate's right to work and obtaining any permission to work required by the law of the country where the Candidate will work; (c) any medical checks; and (d) any qualifications, licences or permissions the position requires.
7.3 So that the Agency can meet clause 7.1, the Client will give the Agency details of the position, including: the type of work; the location and hours; the experience, training, qualifications and authorisations needed; any known health and safety risks and the steps taken to control them; the start date; the likely duration; the minimum Remuneration, expenses and benefits offered; how often pay is made; and the notice period on each side.

## 8. Equal opportunities
8.1 The Agency introduces Candidates without discrimination. The Client will not ask the Agency to act in a way that would breach equality or anti-discrimination law, and will comply with the employment laws that apply to it in its treatment of Candidates.

## 9. Confidentiality and data protection
9.1 All information about a Candidate is confidential and is given only so that the Agency can provide its recruitment services to the Client. The Client will not use it for any other purpose or disclose it to any third party, and will handle it in line with the data protection and privacy laws that apply to it (for example the GDPR or UK GDPR, US state privacy laws, the Philippines Data Privacy Act or Malaysia's Personal Data Protection Act).
9.2 Information about the Agency's business that is capable of being confidential must also be kept confidential, except information that is in the public domain.

## 10. Liability
10.1 The Agency is not liable for any loss, expense, damage, delay, costs or compensation (whether direct, indirect or consequential) suffered by the Client arising from or connected with the Agency looking for a Candidate for the Client, the Introduction or Engagement of any Candidate, or the Agency not Introducing a Candidate. This does not exclude or limit any liability that cannot be excluded or limited by law.
10.2 Subject to clause 10.1, the Agency's total liability to the Client in connection with any Candidate is limited to the Introduction Fee paid for that Candidate.

## 11. Notices
11.1 Notices under these Terms must be in writing and are sent by email to the address each party has given (for the Client, the email given when signing), or delivered to the other party's business address. An emailed notice is treated as received on the next business day after it is sent; a delivered notice, on delivery.

## 12. Term and severability
12.1 These Terms continue until either party ends them by written notice. Ending them does not affect any Introduction Fee for a Candidate Introduced before then, or clauses 4 to 10, which continue to apply.
12.2 If any part of these Terms is found unenforceable by a competent authority, that part is removed to that extent and the rest of these Terms stays in force to the fullest extent the law allows.

## 13. Applicable law and disputes
13.1 These Terms are governed by the laws of the country (and, where relevant, the state or province) where the Client is established.
13.2 Where the law of the place in which the Candidate is Engaged requires different terms (for example on fees, refunds, guarantee periods or recruitment agency rules), that law applies and these Terms are read so that they comply with it.
13.3 If a dispute arises, the parties will first try in good faith to settle it by discussion between senior people on each side within 30 days of either party raising it in writing. If it is not settled, either party may refer it to mediation or to the courts that have jurisdiction under clause 13.1. Nothing in this clause stops the Agency from recovering an unpaid invoice that is not disputed in good faith.
13.4 These Terms are written in English. If they are translated, the English version prevails.

## 14. Signing
14.1 Signing these Terms electronically, by typing a name, is as valid as a handwritten signature.
14.2 The person signing confirms that they are authorised to sign these Terms on behalf of the Client.
$terms$)
 where coalesce((client_agreement ->> 'version')::int, 1) < 5;
