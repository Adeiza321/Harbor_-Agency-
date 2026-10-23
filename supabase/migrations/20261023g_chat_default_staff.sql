-- A candidate with no recruiter, on a role nobody is engaged on (e.g. a client-lead pitch), had no
-- one to chat with: "Message ... about this role" opened an empty window. The chat now falls back to
-- the client point of contact (Agency settings), then the agency owner / first active Admin. System
-- messages (no author) get the same person, so they show in the chat.
create or replace function public.chat_default_staff(p_link_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(c.recruiter_id,
    (select jr.recruiter_id from job_recruiters jr where jr.job_id = l.job_id limit 1),
    (select nullif(s.client_poc->>'userId', '')::uuid from agency_settings s limit 1),
    (select p.id from profiles p where p.role = 'admin' and p.status = 'Active' order by p.is_owner desc nulls last, p.created_at limit 1))
  from candidate_jobs l join candidates c on c.id = l.candidate_id
  where l.id = p_link_id
$$;
create or replace function public.set_message_staff() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.staff_id is null then
    if new.sender = 'recruiter' then
      new.staff_id := coalesce(new.author_id, public.chat_default_staff(new.link_id));
    else
      new.staff_id := coalesce(
        (select p.staff_id from candidate_job_messages p where p.link_id = new.link_id and p.sender = 'recruiter' and p.staff_id is not null order by p.created_at desc limit 1),
        public.chat_default_staff(new.link_id));
    end if;
  end if;
  return new;
end $$;
update candidate_job_messages m set staff_id = public.chat_default_staff(m.link_id)
 where m.staff_id is null and m.deleted_at is null and public.chat_default_staff(m.link_id) is not null;
