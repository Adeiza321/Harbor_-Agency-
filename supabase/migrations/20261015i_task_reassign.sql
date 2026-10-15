-- Reassigning a to-do. The person it's for, whoever created it, or Admin / Rec Ops can hand it to
-- any active teammate (reassign_task). The new person gets an email (role-emails, kind "task").
create or replace function public.reassign_task(p_task uuid, p_to uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select id, assigned_to, created_by, status into t from public.tasks where id = p_task;
  if t.id is null then raise exception 'Task not found'; end if;
  if not (t.assigned_to = auth.uid() or t.created_by = auth.uid() or public.is_staff()) then
    raise exception 'You can only reassign your own tasks';
  end if;
  if not exists (select 1 from public.profiles where id = p_to and status = 'Active') then
    raise exception 'Pick an active teammate';
  end if;
  if t.assigned_to is distinct from p_to then
    update public.tasks set assigned_to = p_to where id = p_task;
  end if;
end $$;
revoke all on function public.reassign_task(uuid, uuid) from public, anon;
grant execute on function public.reassign_task(uuid, uuid) to authenticated;

-- Email the new person (not when you hand it to yourself).
create or replace function public.task_activity_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_to is not null and new.assigned_to is distinct from new.created_by then
      perform public.post_role_email(jsonb_build_object('kind', 'task', 'taskId', new.id));
    end if;
  elsif new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null and new.assigned_to is distinct from auth.uid() then
    perform public.post_role_email(jsonb_build_object('kind', 'task', 'taskId', new.id, 'actorId', auth.uid(), 'reassigned', true));
  end if;
  return new;
end $$;
revoke all on function public.task_activity_email() from public, anon, authenticated;
create or replace trigger tasks_activity_email after insert or update of assigned_to on public.tasks for each row execute function public.task_activity_email();
