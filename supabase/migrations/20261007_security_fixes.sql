-- =====================================================================
-- 7 Oct 2026 — review fixes
-- =====================================================================

-- 1. Candidate page links were rejected.
--    Every candidate's portal_token is 12 characters (the column default), but the
--    candidate-page functions refused anything under 16, so candidates could not
--    reply to messages, set pitch consent or email preferences, accept a role or
--    answer follow-up questions. Accept 12+ (links already emailed keep working)
--    and give new candidates a 32-character token, which is much harder to guess.
do $$
declare f record; def text;
begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('candidate_email_prefs', 'candidate_set_pitch_consent',
                               'candidate_send_message', 'candidate_mark_read')
  loop
    def := pg_get_functiondef(f.oid);
    if position('length(coalesce(p_token, '''')) < 16' in def) > 0 then
      execute replace(def, 'length(coalesce(p_token, '''')) < 16', 'length(coalesce(p_token, '''')) < 12');
    end if;
  end loop;
end $$;

alter table public.candidates
  alter column portal_token set default replace(gen_random_uuid()::text, '-', '');
-- Blind client links (candidate_jobs.client_token) were 14 characters; new ones get 32.
alter table public.candidate_jobs
  alter column client_token set default replace(gen_random_uuid()::text, '-', '');

-- 2. Internal SECURITY DEFINER / trigger functions were callable by anyone
--    (the anon role) through /rest/v1/rpc. Only signed-in users keep access.
--    The public candidate/client page functions stay open to anon on purpose:
--    candidate_portal, candidate_confirm_interview, candidate_email_prefs,
--    candidate_mark_read, candidate_send_message, candidate_set_pitch_consent,
--    client_view (each checks its own token).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'auto_screen_new_links', 'claim_invoice_number', 'derive_candidate_status',
             'guard_job_accepting', 'is_owner', 'protect_candidate_job_ai', 'protect_owner_row',
             'protect_profile_privileged_fields', 'sync_candidate_status', 'transfer_ownership',
             'align_candidate_status', 'queue_job_sourcing', 'stamp_outcome_at',
             'stamp_submitted_at', 'touch_updated_at')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;

-- 3. Password-reset rate limiting (forgot-password counts recent requests per IP).
create index if not exists password_resets_ip_idx on public.password_resets (requested_ip, created_at desc);
