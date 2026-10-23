-- Client sourcing (23 Oct 2026): screening strictly by the job description; the pitch goes to the
-- contacts found (job description, job poster, Talent Acquisition, hiring manager, CEO), each
-- their own email (contacts live on leads.data.contacts, each with their own link token).
--   * lead_offers.jd_check: each requirement / qualification from the job description and where
--     the candidate stands on it from their CV: met (with evidence), not_met, not_shown (asked to
--     confirm) or confirmed (they said yes). Required items decide; nice-to-haves met are a bonus.
--   * A question with "confirm" is a yes/no question about a required item their CV doesn't show.
--     Answering yes to all of them counts them as met (on the client's list and in the fit score)
--     and makes the candidate ready for the pitch; any "no" keeps them waiting for their recruiter.

alter table public.lead_offers add column if not exists jd_check jsonb not null default '[]';

create or replace function public.candidate_pitch_answer(p_token text, p_offer text, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := portal_candidate_id(p_token); o record; l record; qs jsonb; q jsonb; a text; txt text := ''; i int;
  said_no text[] := '{}'; confirmed jsonb := '[]'; checks jsonb; musts jsonb; nreq int; nok int;
begin
  select * into o from lead_offers where token = p_offer and candidate_id = cid;
  if not found then raise exception 'This role is no longer available'; end if;
  if o.status in ('withdrawn', 'removed') then raise exception 'You''re no longer being put forward for this role'; end if;
  if jsonb_typeof(coalesce(p_answers, 'null'::jsonb)) <> 'array' then raise exception 'Please answer the questions'; end if;
  qs := coalesce(o.questions, '[]'::jsonb);
  for i in 0 .. jsonb_array_length(qs) - 1 loop
    a := trim(coalesce(p_answers ->> i, ''));
    if length(a) = 0 then raise exception 'Please answer every question'; end if;
    q := qs -> i;
    txt := txt || E'\n\n' || coalesce(q ->> 'q', qs ->> i) || E'\n' || left(a, 1500);
    if jsonb_typeof(q) = 'object' and coalesce(q ->> 'confirm', '') <> '' then
      if a ~* '^\s*yes' then
        -- Their own words stay with their recruiter (they might name an employer); the client sees this.
        confirmed := confirmed || jsonb_build_array(jsonb_build_object('item', q ->> 'confirm', 'evidence', 'Confirmed by the candidate'));
      else
        said_no := said_no || (q ->> 'confirm');
      end if;
    end if;
  end loop;
  -- What they confirmed counts as met: on the list the client sees and in the fit score.
  checks := coalesce(o.jd_check, '[]'::jsonb);
  musts := coalesce(o.client_musts, '[]'::jsonb);
  if jsonb_array_length(confirmed) > 0 or cardinality(said_no) > 0 then
    select coalesce(jsonb_agg(case
        when c ->> 'status' = 'not_shown' and exists (select 1 from jsonb_array_elements(confirmed) x where x ->> 'item' = c ->> 'item')
          then c || jsonb_build_object('status', 'confirmed', 'evidence', 'Confirmed by the candidate')
        when c ->> 'status' = 'not_shown' and (c ->> 'item') = any(said_no)
          then c || jsonb_build_object('status', 'not_met', 'evidence', 'They said no')
        else c end order by ord), '[]'::jsonb)
      into checks from jsonb_array_elements(checks) with ordinality t(c, ord);
    -- Required items first, nice-to-haves after.
    select coalesce(jsonb_agg(m order by coalesce((m ->> 'bonus')::boolean, false), ord), '[]'::jsonb) into musts
      from jsonb_array_elements(musts || confirmed) with ordinality t(m, ord);
  end if;
  select count(*) filter (where coalesce((c ->> 'required')::boolean, true)),
         count(*) filter (where coalesce((c ->> 'required')::boolean, true) and c ->> 'status' in ('met', 'confirmed'))
    into nreq, nok from jsonb_array_elements(checks) c;
  update lead_offers set answers = p_answers, acknowledged_at = coalesce(acknowledged_at, now()), responded_at = coalesce(responded_at, now()),
      jd_check = checks, client_musts = musts,
      fit = case when nreq > 0 then round(100.0 * nok / nreq) else fit end,
      verdict = case when nreq > 0 and nok = nreq then 'Perfect fit' else verdict end,
      status = case when status = 'pitched' then status when cardinality(said_no) > 0 then 'acknowledged' else 'ready' end,
      ready_at = case when cardinality(said_no) > 0 then ready_at else coalesce(ready_at, now()) end,
      note = case when cardinality(said_no) > 0 then 'Said no to: ' || array_to_string(said_no, '; ') else note end
    where id = o.id;
  select job_title into l from leads where id = o.lead_id;
  insert into candidate_timeline (candidate_id, title, done) values (cid, 'Answered our questions about ' || coalesce(l.job_title, 'a role'), true);
  perform pitch_chat(o.id, 'My answers about ' || coalesce(l.job_title, 'the role') || ':' || txt);
  return jsonb_build_object('ok', true, 'saidNo', cardinality(said_no) > 0);
end $$;
revoke all on function public.candidate_pitch_answer(text, text, jsonb) from public;
grant execute on function public.candidate_pitch_answer(text, text, jsonb) to anon, authenticated;
