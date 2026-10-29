-- A candidate's profile filled in from their CV as soon as it arrives, when nothing else reads it
-- (29 Oct 2026). Someone who joined the Active file through "Send us your CV" (no job, so no
-- screening) ended up with an empty profile: no title, experience, location or skills. Now the CV
-- is read straight away (ai-screen fill_profile), filling only what's blank. Candidates on a job
-- are read by their screening as before; reading twice only fills blanks.

create or replace function public.call_ai_screen_with(p_action text, p_body jsonb) returns bigint
language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://acjmsihvvupqiikxckho.supabase.co/functions/v1/ai-screen',
    body := coalesce(p_body, '{}'::jsonb) || jsonb_build_object('action', p_action),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjam1zaWh2dnVwcWlpa3hja2hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNzM2MzQsImV4cCI6MjEwNTg0OTYzNH0.SRrACW8uKRzYTmD2JdRQ7oLaF8_Xq7aCHHjWPIhru9w',
      'x-harbor-ops', (select decrypted_secret from vault.decrypted_secrets where name = 'harbor_ops_token' limit 1)),
    timeout_milliseconds := 150000);
$$;
revoke all on function public.call_ai_screen_with(text, jsonb) from public, anon, authenticated;

create or replace function public.candidates_cv_fill_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_draft or new.profile_read_at is not null or coalesce(new.resume_path, new.cv_path) is null then return new; end if;
  if tg_op = 'UPDATE' and old.resume_path is not distinct from new.resume_path and old.cv_path is not distinct from new.cv_path then return new; end if;
  perform call_ai_screen_with('fill_profile', jsonb_build_object('candidateId', new.id));
  return new;
end $$;
drop trigger if exists candidates_cv_fill_profile on public.candidates;
create trigger candidates_cv_fill_profile after insert or update of resume_path, cv_path on public.candidates
  for each row execute function public.candidates_cv_fill_profile();
