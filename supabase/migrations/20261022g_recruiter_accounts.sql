-- Recruiter accounts (22 Oct 2026):
--   * country, specialties (the kinds of roles they can close) and regions they work best in
--     (broad regions and/or countries), asked when they set up their account. A new role in one of
--     their regions emails them specially (role-emails).
--   * last_seen_at: when they last used ProNext (the app records it, at most every 30 minutes).
--   * Suspended: Admins and Rec Ops can suspend a recruiter (set_user_suspended), and a recruiter
--     who hasn't used ProNext for 30 days is suspended automatically (suspend_inactive_recruiters,
--     run by the sourcing tick; never without a warning email at least 6 days earlier). A suspended account can't
--     open ProNext (app_role() only counts Active accounts) until an Admin or Rec Ops reactivates it.
--   * ai_usage_totals: the Team audit's AI spend, added up in the database (the app could only read
--     1,000 rows, so a busy month was undercounted).

alter table public.profiles
  add column if not exists country text,
  add column if not exists specialties text[] not null default '{}',
  add column if not exists regions text[] not null default '{}',
  add column if not exists last_seen_at timestamptz,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_by uuid,
  add column if not exists suspended_reason text,
  add column if not exists inactive_warned_at timestamptz;

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check check (status = any (array['Active', 'Invited', 'Disabled', 'Suspended']));

-- Starting point: their last sign-in.
update public.profiles p
   set last_seen_at = greatest(coalesce(u.last_sign_in_at, p.created_at), coalesce(s.last_login_at, p.created_at))
  from auth.users u left join public.profile_security s on s.user_id = u.id
 where u.id = p.id and p.last_seen_at is null;

-- Role, level, status and the suspension fields only change through an Admin, the service role
-- (edge functions), or the functions below (which mark themselves trusted for the update).
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
  end if;
  return new;
end $$;
revoke all on function public.protect_profile_privileged_fields() from public, anon, authenticated;

-- "I'm here": called by the app when someone opens it (any status, so it never fails).
create or replace function public.touch_last_seen() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_seen_at = now()
   where id = auth.uid() and (last_seen_at is null or last_seen_at < now() - interval '30 minutes');
$$;
revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

-- Suspend / reactivate a recruiter (Admins and Rec Ops).
create or replace function public.set_user_suspended(p_user uuid, p_suspend boolean, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t record; who text;
begin
  if not public.is_staff() then raise exception 'Only Admins and Rec Ops can do this'; end if;
  select id, role, status, full_name into t from profiles where id = p_user;
  if t.id is null then raise exception 'Account not found'; end if;
  if t.role <> 'recruiter' then raise exception 'Only recruiter accounts can be suspended'; end if;
  select coalesce(nullif(full_name, ''), email) into who from profiles where id = auth.uid();
  perform set_config('pronext.trusted', '1', true);
  if p_suspend then
    if t.status not in ('Active', 'Invited') then raise exception 'This account isn''t active'; end if;
    update profiles set status = 'Suspended', suspended_at = now(), suspended_by = auth.uid(),
        suspended_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Suspended by ' || coalesce(who, 'an Admin'))
     where id = p_user;
  else
    if t.status <> 'Suspended' then raise exception 'This account isn''t suspended'; end if;
    update profiles set status = 'Active', suspended_at = null, suspended_by = null, suspended_reason = null,
        inactive_warned_at = null, last_seen_at = now()
     where id = p_user;
  end if;
  perform set_config('pronext.trusted', '', true);
  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
    values (auth.uid(), case when p_suspend then 'suspended' else 'reactivated' end, 'user', p_user::text, t.full_name);
  return jsonb_build_object('ok', true, 'status', case when p_suspend then 'Suspended' else 'Active' end);
end $$;
revoke all on function public.set_user_suspended(uuid, boolean, text) from public, anon;
grant execute on function public.set_user_suspended(uuid, boolean, text) to authenticated;

-- A recruiter's country, specialties and regions, set by Admins or Rec Ops (recruiters set their own
-- on My profile through the usual self-update).
create or replace function public.staff_set_recruiter_info(p_user uuid, p_country text, p_specialties text[], p_regions text[])
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Only Admins and Rec Ops can do this'; end if;
  update profiles set country = nullif(trim(coalesce(p_country, '')), ''),
      specialties = coalesce(p_specialties, '{}'), regions = coalesce(p_regions, '{}')
   where id = p_user and role = 'recruiter';
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.staff_set_recruiter_info(uuid, text, text[], text[]) from public, anon;
grant execute on function public.staff_set_recruiter_info(uuid, text, text[], text[]) to authenticated;

-- 30 days without using ProNext: suspended, but only after a warning at least 6 days earlier (sent
-- at 23 days), so nobody is suspended unwarned. Returns who was suspended and who to warn. Run by
-- the sourcing tick (service role), which sends the emails.
create or replace function public.suspend_inactive_recruiters()
returns jsonb language plpgsql security definer set search_path = public as $$
declare susp jsonb; warn jsonb;
begin
  perform set_config('pronext.trusted', '1', true);
  -- Back in ProNext since the warning: the warning no longer counts.
  update profiles set inactive_warned_at = null where inactive_warned_at is not null and last_seen_at > inactive_warned_at;
  with s as (
    update profiles set status = 'Suspended', suspended_at = now(), suspended_by = null,
        suspended_reason = 'Suspended automatically after 30 days without signing in'
     where role = 'recruiter' and status = 'Active' and coalesce(last_seen_at, created_at) < now() - interval '30 days'
       and inactive_warned_at is not null and inactive_warned_at < now() - interval '6 days'
    returning id, email, full_name)
  select coalesce(jsonb_agg(to_jsonb(s)), '[]') into susp from s;
  with w as (
    update profiles set inactive_warned_at = now()
     where role = 'recruiter' and status = 'Active' and inactive_warned_at is null
       and coalesce(last_seen_at, created_at) < now() - interval '23 days'
    returning id, email, full_name, coalesce(last_seen_at, created_at) as seen)
  select coalesce(jsonb_agg(to_jsonb(w)), '[]') into warn from w;
  perform set_config('pronext.trusted', '', true);
  insert into audit_log (actor_id, action, entity_type, entity_id, detail)
    select null, 'suspended', 'user', x->>'id', (x->>'full_name') || ': 30 days without signing in' from jsonb_array_elements(susp) x;
  return jsonb_build_object('suspended', susp, 'warn', warn);
end $$;
revoke all on function public.suspend_inactive_recruiters() from public, anon, authenticated;
grant execute on function public.suspend_inactive_recruiters() to service_role;

-- Team audit: AI spend per person and feature in a period (Admins). user_id null = automatic runs.
create or replace function public.ai_usage_totals(p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, feature text, cost_usd numeric, calls bigint)
language sql stable security definer set search_path = public as $$
  select u.user_id, u.feature, sum(coalesce(u.cost_usd, 0)), count(*)
    from ai_usage u
   where public.is_admin() and u.created_at >= p_from and u.created_at < p_to
   group by u.user_id, u.feature
$$;
revoke all on function public.ai_usage_totals(timestamptz, timestamptz) from public, anon;
grant execute on function public.ai_usage_totals(timestamptz, timestamptz) to authenticated;
