-- When the AI is unavailable (the Claude account is out of credit, or the key stops working)
-- ProNext keeps working without it: submissions, routing, stages, emails and the Inbox don't
-- depend on the AI. This one-row table records that the AI is down, so the dashboard can say so
-- (screening, fit checks and AI drafts are skipped meanwhile). The edge functions set it when a
-- call fails that way and clear it on the next call that works.
create table if not exists public.ai_health (
  id int primary key default 1 check (id = 1),
  down_since timestamptz,
  reason text,
  checked_at timestamptz
);
insert into public.ai_health (id) values (1) on conflict do nothing;
alter table public.ai_health enable row level security;
drop policy if exists ai_health_read on public.ai_health;
create policy ai_health_read on public.ai_health for select to authenticated using ((select public.app_role()) is not null);
grant select on public.ai_health to authenticated;

create or replace function public.note_ai_health(p_down boolean, p_reason text default null)
returns void language sql security definer set search_path to 'public' as $$
  update ai_health
     set down_since = case when p_down then coalesce(down_since, now()) else null end,
         reason = case when p_down then left(coalesce(p_reason, ''), 300) else null end,
         checked_at = now()
   where id = 1 and (p_down or down_since is not null);
$$;
revoke all on function public.note_ai_health(boolean, text) from public, anon, authenticated;
