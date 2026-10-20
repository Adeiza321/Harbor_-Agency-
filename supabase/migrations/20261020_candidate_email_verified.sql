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

-- Keep candidates.email_verified (the Verified / Unverified label everywhere) in step with the
-- delivery reports. Background updates don't count as activity on the candidate.
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if coalesce(current_setting('harbor.quiet', true), '') = 'on' then return new; end if;
  new.updated_at = now(); return new;
end $$;
create or replace function public.email_delivery_ok(p_email text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((
    select e.event in ('delivered', 'opened', 'unique_opened', 'click', 'proxy_open')
      from public.email_events e
     where coalesce(p_email, '') <> '' and lower(e.email) = lower(p_email)
       and e.event in ('delivered', 'opened', 'unique_opened', 'click', 'proxy_open', 'hard_bounce', 'blocked', 'invalid_email')
     order by e.at desc nulls last limit 1), false)
$$;
create or replace function public.refresh_email_verified(p_email text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare ok boolean := public.email_delivery_ok(p_email);
begin
  perform set_config('harbor.quiet', 'on', true);
  update public.candidates set email_verified = ok where lower(email) = lower(p_email) and email_verified is distinct from ok;
  perform set_config('harbor.quiet', 'off', true);
end $$;
revoke all on function public.email_delivery_ok(text) from public, anon, authenticated;
revoke all on function public.refresh_email_verified(text) from public, anon, authenticated;
create or replace function public.email_events_verify()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.event in ('delivered', 'opened', 'unique_opened', 'click', 'proxy_open', 'hard_bounce', 'blocked', 'invalid_email') then
    perform public.refresh_email_verified(new.email);
  end if;
  return null;
end $$;
create or replace trigger email_events_verify after insert on public.email_events for each row execute function public.email_events_verify();
create or replace function public.candidate_email_recheck()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'INSERT' or new.email is distinct from old.email then new.email_verified := public.email_delivery_ok(new.email); end if;
  return new;
end $$;
create or replace trigger candidates_email_recheck before insert or update of email on public.candidates for each row execute function public.candidate_email_recheck();
select public.refresh_email_verified(e) from (select distinct lower(email) e from public.candidates where coalesce(email, '') <> '') x;
