-- Blind resumes: the candidate's own CV with names, contact details, photos and employers blacked
-- out (made in the recruiter's browser, src/redact.js), stored as page images per client link.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('blind-resumes', 'blind-resumes', false, 6291456, array['image/webp','image/png','image/jpeg'])
on conflict (id) do nothing;
alter table public.candidate_jobs add column if not exists blind_pages int, add column if not exists blind_at timestamptz, add column if not exists blind_by uuid;
create or replace function public.can_manage_link(p_link text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.candidate_jobs cj join public.candidates c on c.id = cj.candidate_id
                  where cj.id::text = p_link and (public.is_staff() or (c.recruiter_id = auth.uid() and public.app_role() is not null)))
$$;
revoke all on function public.can_manage_link(text) from public, anon;
grant execute on function public.can_manage_link(text) to authenticated;
create policy blind_resumes_read on storage.objects for select to authenticated using (bucket_id = 'blind-resumes' and public.can_manage_link((storage.foldername(name))[1]));
create policy blind_resumes_insert on storage.objects for insert to authenticated with check (bucket_id = 'blind-resumes' and public.can_manage_link((storage.foldername(name))[1]));
create policy blind_resumes_update on storage.objects for update to authenticated using (bucket_id = 'blind-resumes' and public.can_manage_link((storage.foldername(name))[1]));
create policy blind_resumes_delete on storage.objects for delete to authenticated using (bucket_id = 'blind-resumes' and public.can_manage_link((storage.foldername(name))[1]));
