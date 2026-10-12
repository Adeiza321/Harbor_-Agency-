-- Learning from client rejections runs on the backend, with no app involvement:
--   * the moment a client rejection is recorded (or its reason / feedback edited), the database
--     asks ai-screen to learn from it ("learn_link");
--   * a sweep every 10 minutes catches anything that slipped through ("learn_pending");
--   * if a client rejection is undone, the lessons it taught are switched off.
-- Screening already applies active lessons on every run (lessons.ts).

alter table public.candidate_jobs
  add column if not exists lessons_learned_at timestamptz,
  add column if not exists lesson_tries int not null default 0;

-- Rejections learned from before this change (the 4 existing lessons) count as done.
update public.candidate_jobs cj set lessons_learned_at = now()
where lessons_learned_at is null
  and exists (select 1 from public.screening_lessons sl where sl.source_link_id = cj.id);

create index if not exists candidate_jobs_lessons_pending_idx on public.candidate_jobs (rejected_at)
  where reject_kind = 'client' and lessons_learned_at is null;

-- Called by ai-screen when learning fails, so a broken rejection is retried at most 3 times.
create or replace function public.note_lesson_attempt(p_link uuid)
returns void language sql security definer set search_path = public as $$
  update public.candidate_jobs set lesson_tries = lesson_tries + 1 where id = p_link;
$$;
revoke all on function public.note_lesson_attempt(uuid) from public, anon, authenticated;

-- A changed rejection must be learned again.
create or replace function public.reset_lesson_on_reject_change()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.reject_kind, new.reject_reason, new.reject_feedback) is distinct from (old.reject_kind, old.reject_reason, old.reject_feedback) then
    new.lessons_learned_at := null;
    new.lesson_tries := 0;
  end if;
  return new;
end $$;

drop trigger if exists candidate_jobs_reset_lesson on public.candidate_jobs;
create trigger candidate_jobs_reset_lesson
  before update of reject_kind, reject_reason, reject_feedback on public.candidate_jobs
  for each row execute function public.reset_lesson_on_reject_change();

-- Learn straight away from a new or edited client rejection; switch lessons off if it's undone.
create or replace function public.learn_from_client_rejection()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.reject_kind = 'client' and new.reject_reason is not null then
    perform public.call_ai_screen('learn_link', new.id);
  elsif old.reject_kind = 'client' then
    update public.screening_lessons set active = false, updated_at = now()
    where source_link_id = new.id and active;
  end if;
  return null;
end $$;

drop trigger if exists candidate_jobs_learn_rejection on public.candidate_jobs;
create trigger candidate_jobs_learn_rejection
  after update of reject_kind, reject_reason, reject_feedback on public.candidate_jobs
  for each row
  when ((new.reject_kind, new.reject_reason, new.reject_feedback) is distinct from (old.reject_kind, old.reject_reason, old.reject_feedback))
  execute function public.learn_from_client_rejection();

-- Sweep: only calls the function when there is something to learn.
create or replace function public.lesson_sweep()
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.candidate_jobs
    where reject_kind = 'client' and reject_reason is not null and lessons_learned_at is null
      and lesson_tries < 3 and rejected_at < now() - interval '90 seconds')
  then perform public.call_ai_screen('learn_pending', null);
  end if;
end $$;

select cron.unschedule('harbor-lesson-sweep') where exists (select 1 from cron.job where jobname = 'harbor-lesson-sweep');
select cron.schedule('harbor-lesson-sweep', '*/10 * * * *', 'select public.lesson_sweep()');
