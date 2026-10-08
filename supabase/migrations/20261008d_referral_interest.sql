-- Referrals wait for the person referred to say they're interested before anyone can be assigned.
--   applications.referral_token   secret in their email links
--   applications.interest_at      when they clicked "I'm interested" (or applied themselves)
--   applications.followups / last_followup_at   reminders sent from the Inbox (at most 2)
-- referral_interest(): the job page reads the referral (to greet them and prefill the form) and,
-- when they click "I'm interested", records it. Public, keyed by the secret token.
alter table public.applications add column if not exists referral_token text, add column if not exists interest_at timestamptz,
  add column if not exists followups int not null default 0, add column if not exists last_followup_at timestamptz;
create unique index if not exists applications_referral_token_key on public.applications (referral_token) where referral_token is not null;

create or replace function public.referral_interest(p_token text, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare a record;
begin
  if p_token is null or length(p_token) < 16 then return null; end if;
  select id, name, email, referrer, interest_at, status into a from applications where referral_token = p_token;
  if not found then return null; end if;
  if p_confirm and a.interest_at is null and a.status = 'new' then
    update applications set interest_at = now() where id = a.id;
    a.interest_at := now();
  end if;
  return jsonb_build_object('name', a.name, 'email', a.email, 'referrer', a.referrer->>'name', 'interested', a.interest_at is not null);
end $fn$;
grant execute on function public.referral_interest(text, boolean) to anon, authenticated;
