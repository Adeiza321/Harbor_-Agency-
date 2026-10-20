-- Two-factor that actually protects the data: someone who has turned two-factor on gets no access
-- to ProNext's data with a password-only session. Their session must have passed the code step
-- (aal2). People without two-factor are unaffected. Every table's security rules go through
-- app_role(), so this one change covers them all.
create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select p.role from public.profiles p
   where p.id = auth.uid() and p.status = 'Active'
     and (coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
          or not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'))
$$;
