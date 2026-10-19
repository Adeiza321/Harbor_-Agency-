-- X-ray searches run at most two at a time; the rest wait as "queued" (sourcing xray_queue, commit 1ae7a3b).
-- Every 2 minutes: start queued searches and mark ones the server cut off as stopped.
select cron.schedule('harbor-xray-queue', '*/2 * * * *', 'select public.call_sourcing(''xray_queue'')');
