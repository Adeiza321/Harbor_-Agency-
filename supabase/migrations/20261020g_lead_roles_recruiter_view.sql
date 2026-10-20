-- Lead roles for recruiters: view only. A recruiter sees a lead role while one of their own
-- candidates is live on it (not rejected or withdrawn), so they can follow that candidate there.
-- They can't engage on it or put candidates on it; only Rec Ops and Admins can.
create or replace function public.sees_lead_role(p_job uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from candidate_jobs l join candidates c on c.id = l.candidate_id
                  where l.job_id = p_job and c.recruiter_id = auth.uid()
                    and l.stage not in ('Rejected', 'Withdrawn') and coalesce(l.candidate_response, 'accepted') <> 'declined')
$$;
revoke all on function public.sees_lead_role(uuid) from public, anon;
grant execute on function public.sees_lead_role(uuid) to authenticated;

alter policy jobs_read on public.jobs
  using ((select public.app_role()) is not null and (not lead_role or (select public.is_staff()) or public.sees_lead_role(id)));

-- No engaging on a lead role, no new candidates on it and no moving candidates along on it,
-- unless Rec Ops or an Admin (system updates, with no signed-in user, aren't affected).
create or replace function public.guard_lead_role_engage()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  -- Ending it (moved to another role, rejected, withdrawn) is fine: that can follow from their recruiter's other actions.
  if tg_table_name = 'candidate_jobs' and tg_op = 'UPDATE' then
    if new.job_id = old.job_id and new.stage in ('Rejected', 'Withdrawn') then return new; end if;
  end if;
  if auth.uid() is not null and not public.is_staff() and exists (select 1 from jobs where id = new.job_id and lead_role) then
    raise exception 'This role came from a client lead. Only Rec Ops or an Admin can work on it.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create or replace trigger job_recruiters_lead_role before insert or update on public.job_recruiters for each row execute function public.guard_lead_role_engage();
create or replace trigger candidate_jobs_lead_role before insert or update of job_id, stage on public.candidate_jobs for each row execute function public.guard_lead_role_engage();
