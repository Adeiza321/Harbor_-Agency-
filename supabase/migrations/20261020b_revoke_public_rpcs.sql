-- Security scan, 20 Oct: two internal functions were callable by anyone through the public API.
--   sync_current_role(uuid): only for the reroute trigger / status sync.
--   lesson_sweep(): the cron's 10-minute learning sweep (starts AI calls, so it costs money).
revoke execute on function public.sync_current_role(uuid) from public, anon, authenticated;
revoke execute on function public.lesson_sweep() from public, anon, authenticated;
