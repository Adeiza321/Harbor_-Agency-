-- A candidate who unsubscribes from ProNext emails becomes Not active for good: "Open to new roles"
-- off with no end date, so the year-on "are you looking again?" email never goes (we don't email
-- people who unsubscribed). Any pitch still waiting for them is withdrawn ("Unsubscribed"), and it's
-- on their timeline. Only they can change it: turning emails back on, or "Open to new roles" on
-- their candidate page. (The unsubscribe link now asks them to confirm with a click, so a mail
-- scanner opening the link can't unsubscribe anyone.)
create or replace function public.candidates_unsub_inactive() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_opt_out and not coalesce(old.email_opt_out, false) then
    new.open_to_roles := false; new.open_paused_until := null; new.open_changed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists candidates_unsub_inactive on public.candidates;
create trigger candidates_unsub_inactive before update of email_opt_out on public.candidates
  for each row execute function public.candidates_unsub_inactive();

create or replace function public.candidates_unsub_followthrough() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_opt_out and not coalesce(old.email_opt_out, false) then
    update candidate_jobs set stage = 'Withdrawn'
     where id in (select candidate_job_id from lead_offers where candidate_id = new.id and candidate_job_id is not null
                    and status in ('draft', 'notified', 'reminded', 'no_email', 'acknowledged', 'ready'))
       and stage not in ('Withdrawn', 'Rejected', 'Placed');
    update lead_offers set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'unsubscribed', note = 'Unsubscribed from emails'
     where candidate_id = new.id and status in ('draft', 'notified', 'reminded', 'no_email', 'acknowledged', 'ready');
    insert into candidate_timeline (candidate_id, title, done) values (new.id, 'Unsubscribed: moved to Not active for good (no more pitches or check-ins)', true);
  end if;
  return new;
end $$;
drop trigger if exists candidates_unsub_followthrough on public.candidates;
create trigger candidates_unsub_followthrough after update of email_opt_out on public.candidates
  for each row execute function public.candidates_unsub_followthrough();

-- Anyone who already unsubscribed.
update public.candidates set open_to_roles = false, open_paused_until = null, open_changed_at = coalesce(open_changed_at, now())
 where email_opt_out and (open_to_roles or open_paused_until is not null);
