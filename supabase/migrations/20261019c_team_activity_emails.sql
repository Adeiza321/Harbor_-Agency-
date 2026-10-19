-- Team activity emails (role-emails function, kinds new_candidate and applied):
--   * a candidate added (or a draft submitted): Admins and Rec Ops hear when a recruiter added them;
--     a recruiter hears when someone else (or the Inbox) gave them the candidate.
--   * a direct application (apply page, outreach "I'm interested", job boards): Admins, Rec Ops and
--     the role's recruiters. A referral only once the person referred says they're interested.

create or replace function public.cand_added_email() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if (tg_op = 'INSERT' and not coalesce(new.is_draft, false))
     or (tg_op = 'UPDATE' and coalesce(old.is_draft, false) and not coalesce(new.is_draft, false)) then
    perform public.post_role_email(jsonb_build_object('kind', 'new_candidate', 'candidateId', new.id, 'actorId', auth.uid()));
  end if;
  return new;
end $$;

drop trigger if exists candidates_added_email on public.candidates;
create trigger candidates_added_email after insert or update of is_draft on public.candidates
  for each row execute function public.cand_added_email();

create or replace function public.application_email() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'INSERT' and coalesce(new.source, '') <> 'referral' then
    perform public.post_role_email(jsonb_build_object('kind', 'applied', 'applicationId', new.id));
  elsif tg_op = 'UPDATE' and new.source = 'referral' and old.interest_at is null and new.interest_at is not null then
    perform public.post_role_email(jsonb_build_object('kind', 'applied', 'applicationId', new.id));
  end if;
  return new;
end $$;

drop trigger if exists applications_activity_email on public.applications;
create trigger applications_activity_email after insert or update of interest_at on public.applications
  for each row execute function public.application_email();
