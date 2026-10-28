-- The screening sweep (every 2 minutes) only called ai-screen when new, unscreened cards were
-- waiting, so the retry for answers that never reached a card (screen_pending's "rescreened") was
-- never reached on its own. It now also fires for a card whose follow-up answers came in after its
-- last screening (fewer than 3 tries, the last over 10 minutes ago).
create or replace function public.screen_sweep()
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  if exists (
    select 1 from public.candidate_jobs cj join public.candidates c on c.id = cj.candidate_id
    where coalesce(cj.candidate_response, 'accepted') = 'accepted'
      and coalesce(cj.ai->>'stage', '') = ''
      and ((cj.created_at > now() - interval '3 days' and cj.created_at < now() - interval '90 seconds') or cj.ai->'auto'->>'resume' = 'true')
      and not coalesce(c.ai_locked, false) and not coalesce(c.is_draft, false)
      and coalesce((cj.ai->'auto'->>'tries')::int, 0) < 3
      and coalesce((cj.ai->'auto'->>'at')::timestamptz, 'epoch') < now() - interval '10 minutes')
  or exists (
    select 1 from public.candidate_jobs cj join public.candidates c on c.id = cj.candidate_id
    where coalesce(cj.candidate_response, 'accepted') = 'accepted'
      and cj.ai->'followups'->>'state' = 'answered'
      and (cj.ai->'followups'->>'answeredAt') is not null
      and coalesce((cj.ai->>'updatedAt')::timestamptz, 'epoch') < (cj.ai->'followups'->>'answeredAt')::timestamptz
      and not coalesce(c.ai_locked, false) and not coalesce(c.is_draft, false)
      and coalesce((cj.ai->'rescreen'->>'tries')::int, 0) < 3
      and coalesce((cj.ai->'rescreen'->>'at')::timestamptz, 'epoch') < now() - interval '10 minutes')
  then perform public.call_ai_screen('screen_pending', null);
  end if;
end $function$;
