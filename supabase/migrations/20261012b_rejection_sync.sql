-- Rejections show where people look:
--   * a client rejection marks the matching submission (candidate_endorsements) Rejected, with the
--     reason as its next step, so it no longer reads "With client · Awaiting feedback";
--   * updating a rejection without emailing the candidate again keeps what they were told before.

create or replace function public.keep_reject_message()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.stage = 'Rejected' and new.reject_message is null and old.reject_message is not null then
    new.reject_message := old.reject_message;
  end if;
  return new;
end $$;

drop trigger if exists candidate_jobs_keep_reject_message on public.candidate_jobs;
create trigger candidate_jobs_keep_reject_message
  before update of reject_message on public.candidate_jobs
  for each row execute function public.keep_reject_message();

create or replace function public.reject_label(p text)
returns text language sql immutable as $$
  select case p
    when 'experience' then 'Not enough experience' when 'skill' then 'Missing a must-have skill'
    when 'salary' then 'Salary expectation' when 'location' then 'Location / work authorisation'
    when 'notice' then 'Notice period' when 'other_candidate' then 'Client chose another candidate'
    when 'role_closed' then 'Role filled or paused' when 'interview' then 'Interview performance'
    else 'Other' end
$$;

create or replace function public.sync_submission_on_reject()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.stage = 'Rejected' and new.reject_kind = 'client' and new.reject_reason is not null then
    update public.candidate_endorsements e
    set status = 'Rejected', next_step = 'Client: ' || public.reject_label(new.reject_reason)
    from public.jobs j
    where j.id = new.job_id and e.candidate_id = new.candidate_id
      and e.company = j.client and e.role_title = j.role_title
      and (e.status is distinct from 'Rejected' or e.next_step is distinct from 'Client: ' || public.reject_label(new.reject_reason));
  end if;
  return null;
end $$;

drop trigger if exists candidate_jobs_sync_submission on public.candidate_jobs;
create trigger candidate_jobs_sync_submission
  after update of stage, reject_kind, reject_reason on public.candidate_jobs
  for each row execute function public.sync_submission_on_reject();

-- Submissions already rejected by the client before this change.
update public.candidate_endorsements e
set status = 'Rejected', next_step = 'Client: ' || public.reject_label(cj.reject_reason)
from public.candidate_jobs cj join public.jobs j on j.id = cj.job_id
where cj.stage = 'Rejected' and cj.reject_kind = 'client' and cj.reject_reason is not null
  and e.candidate_id = cj.candidate_id and e.company = j.client and e.role_title = j.role_title
  and e.status is distinct from 'Rejected';
