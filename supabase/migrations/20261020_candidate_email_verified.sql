-- Verified tick on a candidate's profile: true when the latest delivery report for their email
-- (from Brevo, in email_events) says it arrived (delivered, opened or clicked), not bounced/blocked.
create or replace function public.candidate_email_verified(p_cand uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((
    select e.event in ('delivered', 'opened', 'unique_opened', 'click', 'proxy_open')
      from public.email_events e join public.candidates c on lower(e.email) = lower(c.email)
     where c.id = p_cand and coalesce(c.email, '') <> ''
       and e.event in ('delivered', 'opened', 'unique_opened', 'click', 'proxy_open', 'hard_bounce', 'blocked', 'invalid_email')
     order by e.at desc nulls last limit 1), false)
  and exists (select 1 from public.profiles where id = auth.uid() and status = 'Active')
$$;
revoke all on function public.candidate_email_verified(uuid) from public, anon;
grant execute on function public.candidate_email_verified(uuid) to authenticated;
