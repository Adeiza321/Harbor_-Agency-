-- Security: longer candidate-page links, and flood limits on the public apply/refer form.

-- 1. Applications remember a hashed network address (never the address itself), so
--    submit-application can limit submissions per network.
alter table public.applications add column if not exists ip_hash text;
create index if not exists applications_ip_hash_idx on public.applications (ip_hash, created_at);

-- 2. Candidate-page links: new candidates already get 32-character links (column default).
--    Older 12-character links are replaced by 32-character ones; the old link keeps working
--    for 90 days by being swapped for the new one when it's opened (portal_upgrade_token).
alter table public.candidates add column if not exists legacy_portal_token text unique;
alter table public.candidates add column if not exists legacy_until timestamptz;

create or replace function public.portal_upgrade_token(p_token text)
returns text language sql stable security definer set search_path = public as $$
  select c.portal_token from candidates c
  where length(coalesce(p_token, '')) >= 12 and c.legacy_portal_token = p_token and c.legacy_until > now()
$$;
revoke all on function public.portal_upgrade_token(text) from public;
grant execute on function public.portal_upgrade_token(text) to anon, authenticated;

-- 3. Swap the old links (run once, after the site that understands old links is live):
-- update public.candidates
--    set legacy_portal_token = portal_token, legacy_until = now() + interval '90 days',
--        portal_token = replace(gen_random_uuid()::text, '-', '')
--  where length(portal_token) < 32 and legacy_portal_token is null;
