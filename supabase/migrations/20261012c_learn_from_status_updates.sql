-- The AI learns from status updates, not only client rejections. Each kind teaches something different:
--   client_reject   - the client rejected the candidate, with a reason  -> "Client feedback:" must-have line
--   internal_reject - our team rejected them before submission, with a reason -> "Watch-out:" line,
--                     never a reason to reject on its own
--   progress        - the client moved them to Interview, Offer or Placed -> "Client liked:" bonus line,
--                     raises the score when met, never costs points
-- Every lesson applies ONLY to the role (job) it came from. Withdrawn/declined candidates and
-- rejections with no reason teach nothing. Past updates are picked up by the 10-minute sweep.
-- Written without drops or data updates so it can go through apply_migration.

alter table public.screening_lessons add column if not exists kind text not null default 'client_reject';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'screening_lessons_kind_check') then
    alter table public.screening_lessons add constraint screening_lessons_kind_check
      check (kind in ('client_reject', 'internal_reject', 'progress'));
  end if;
end $$;

-- What a status update can teach (null = nothing). ai-screen's lessonKind() mirrors this.
create or replace function public.lesson_kind(p_stage text, p_reject_kind text, p_reject_reason text)
returns text language sql immutable set search_path = public as $$
  select case
    when p_stage = 'Rejected' and p_reject_kind in ('client', 'internal') and p_reject_reason is not null then p_reject_kind || '_reject'
    when p_stage in ('Interview', 'Offer', 'Placed') then 'progress'
  end
$$;

-- Status updates to learn from: every learnable one, or (p_pending) only those not learned yet,
-- with fewer than 3 failed tries, that have settled for 90 seconds. Used by ai-screen.
create or replace function public.lesson_links(p_pending boolean, p_limit int)
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from public.candidate_jobs
  where public.lesson_kind(stage, reject_kind, reject_reason) is not null
    and (not p_pending or (lessons_learned_at is null and lesson_tries < 3
         and coalesce(rejected_at, updated_at) < now() - interval '90 seconds'))
  order by coalesce(rejected_at, updated_at) desc
  limit greatest(1, least(p_limit, 50));
$$;
revoke all on function public.lesson_links(boolean, int) from public, anon, authenticated;
grant execute on function public.lesson_links(boolean, int) to service_role;

-- Any change to the stage or the rejection must be learned again.
create or replace function public.reset_lesson_on_reject_change()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.stage, new.reject_kind, new.reject_reason, new.reject_feedback) is distinct from (old.stage, old.reject_kind, old.reject_reason, old.reject_feedback) then
    new.lessons_learned_at := null;
    new.lesson_tries := 0;
  end if;
  return new;
end $$;

create or replace trigger candidate_jobs_reset_lesson
  before update of stage, reject_kind, reject_reason, reject_feedback on public.candidate_jobs
  for each row execute function public.reset_lesson_on_reject_change();

-- Learn straight away from a learnable update; switch the card's lessons off when it no longer teaches anything.
create or replace function public.learn_from_status_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.lesson_kind(new.stage, new.reject_kind, new.reject_reason) is not null then
    perform public.call_ai_screen('learn_link', new.id);
  elsif public.lesson_kind(old.stage, old.reject_kind, old.reject_reason) is not null then
    update public.screening_lessons set active = false, updated_at = now()
    where source_link_id = new.id and active;
  end if;
  return null;
end $$;

create or replace trigger candidate_jobs_learn_rejection
  after update of stage, reject_kind, reject_reason, reject_feedback on public.candidate_jobs
  for each row
  when ((new.stage, new.reject_kind, new.reject_reason, new.reject_feedback) is distinct from (old.stage, old.reject_kind, old.reject_reason, old.reject_feedback))
  execute function public.learn_from_status_update();

-- Sweep (harbor-lesson-sweep, every 10 minutes): only calls ai-screen when something is waiting.
create or replace function public.lesson_sweep()
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.lesson_links(true, 1)) then
    perform public.call_ai_screen('learn_pending', null);
  end if;
end $$;
