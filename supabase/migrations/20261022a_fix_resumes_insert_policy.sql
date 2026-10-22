-- Recruiters couldn't upload resumes, so "Submit candidate" failed with
-- "new row violates row-level security policy". Inside the EXISTS on candidates, the bare
-- `name` bound to candidates.name (the person's name) instead of storage.objects.name (the
-- file path), so the check compared the candidate id with the folder of their name and always
-- failed for anyone who isn't Admin / Rec Ops. Qualify it as objects.name.
drop policy if exists resumes_insert on storage.objects;
create policy resumes_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'resumes' and (public.is_staff() or exists (
    select 1 from public.candidates c
     where c.id::text = (storage.foldername(objects.name))[1] and c.recruiter_id = auth.uid())));
