-- Email addresses are saved without surrounding spaces. A pasted " name@example.com" (as on John
-- Falbo's profile, 28 Oct) looks right on screen but makes Brevo reject the email, so messages and
-- reminders to them silently don't arrive. Trimmed on every save, on candidates and applications.
create or replace function public.trim_email() returns trigger language plpgsql as $$
begin
  if new.email is not null then new.email := nullif(btrim(new.email, E' \t\r\n '), ''); end if;
  return new;
end $$;
drop trigger if exists candidates_trim_email on public.candidates;
create trigger candidates_trim_email before insert or update of email on public.candidates
  for each row execute function public.trim_email();
drop trigger if exists applications_trim_email on public.applications;
create trigger applications_trim_email before insert or update of email on public.applications
  for each row execute function public.trim_email();
update public.candidates set email = btrim(email) where email <> btrim(email);
update public.applications set email = btrim(email) where email <> btrim(email);
