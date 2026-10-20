-- How ProNext notices the AI is back: every 15 minutes, while it's marked down, a tiny test call
-- goes to Claude (a few tokens). The first call that works, this one or any other, clears the
-- flag, and the role cards that weren't screened while it was down are queued to be screened.
create or replace function public.note_ai_health(p_down boolean, p_reason text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare was_down boolean;
begin
  select down_since is not null into was_down from ai_health where id = 1;
  if p_down then
    update ai_health set down_since = coalesce(down_since, now()), reason = left(coalesce(p_reason, ''), 300), checked_at = now() where id = 1;
  elsif was_down then
    update ai_health set down_since = null, reason = null, checked_at = now() where id = 1;
    -- Cards skipped while it was down: screen them now (the 2-minute sweep picks them up).
    update candidate_jobs set ai = jsonb_set(coalesce(ai, '{}'::jsonb), '{auto}', '{"resume": true}'::jsonb)
     where ai->'auto'->>'paused' = 'true' and coalesce(ai->>'stage', '') = '';
  end if;
end $$;
revoke all on function public.note_ai_health(boolean, text) from public, anon, authenticated;

create or replace function public.ai_health_check()
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (select 1 from ai_health where id = 1 and down_since is not null) then
    perform public.call_ai_screen('ai_ping', null);
  end if;
end $$;
revoke all on function public.ai_health_check() from public, anon, authenticated;

select cron.schedule('harbor-ai-health', '*/15 * * * *', 'select public.ai_health_check()');

create or replace function public.screen_sweep()
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (
    select 1 from public.candidate_jobs cj join public.candidates c on c.id = cj.candidate_id
    where coalesce(cj.candidate_response, 'accepted') = 'accepted'
      and coalesce(cj.ai->>'stage', '') = ''
      and ((cj.created_at > now() - interval '3 days' and cj.created_at < now() - interval '90 seconds') or cj.ai->'auto'->>'resume' = 'true')
      and not coalesce(c.ai_locked, false) and not coalesce(c.is_draft, false)
      and coalesce((cj.ai->'auto'->>'tries')::int, 0) < 3
      and coalesce((cj.ai->'auto'->>'at')::timestamptz, 'epoch') < now() - interval '10 minutes')
  then perform public.call_ai_screen('screen_pending', null);
  end if;
end $$;
