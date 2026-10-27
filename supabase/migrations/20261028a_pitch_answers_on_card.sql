-- Pitch answers on the candidate's role card, and one round of questions only.
--   * The candidate's answers to the pitch email's questions are saved on the role card on their
--     profile (candidate_jobs.screening_answers as {q, a} pairs), so they show under "Application
--     questions" like any application, not only in the chat. They also count as earlier answers,
--     so later forms pre-fill them instead of asking again.
--   * A pitched role's card is the pitch screening (the sourcing function writes it when the pitch
--     is set up: ai.source = 'pitch'), so the automatic AI screening doesn't run again and no second
--     round of follow-up questions is drafted. Their answers update the card's fit, verdict and
--     checklist here.
--   * One-off: answers already given are copied onto their cards, and follow-up questions the AI
--     drafted for pitched roles but nobody had sent yet are removed (they'd be a second round).

create or replace function public.candidate_pitch_answer(p_token text, p_offer text, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := portal_candidate_id(p_token); o record; l record; qs jsonb; q jsonb; a text; txt text := ''; i int;
  said_no text[] := '{}'; confirmed jsonb := '[]'; checks jsonb; musts jsonb; nreq int; nok int;
  pairs jsonb := '[]'; card_reqs jsonb;
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
    pairs := pairs || jsonb_build_array(jsonb_build_object('q', coalesce(q ->> 'q', qs ->> i), 'a', left(a, 1500)));
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
  -- The role card on their profile: their answers under "Application questions", and the card's
  -- fit, verdict and checklist brought up to date with what they confirmed (or said no to). No
  -- separate AI screening or follow-up questions: the pitch email asked everything once.
  if o.candidate_job_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'requirement', left(c ->> 'item', 160),
        'type', case when coalesce((c ->> 'required')::boolean, true) and not coalesce((c ->> 'info')::boolean, false) then 'must' else 'preferred' end,
        'status', case when c ->> 'status' in ('met', 'confirmed') then 'met' when c ->> 'status' = 'not_met' then 'not met' else 'partial' end,
        'evidence', left(coalesce(c ->> 'evidence', ''), 240)) order by ord), '[]'::jsonb)
      into card_reqs from jsonb_array_elements(checks) with ordinality t(c, ord);
    update candidate_jobs set screening_answers = pairs,
        fit = case when nreq > 0 then round(100.0 * nok / nreq) else fit end,
        ai = case when coalesce(ai ->> 'source', '') = 'pitch' then coalesce(ai, '{}'::jsonb) || jsonb_build_object(
            'requirements', card_reqs,
            'score', case when nreq > 0 then round(100.0 * nok / nreq) else (ai ->> 'score')::numeric end,
            'verdict', case when cardinality(said_no) > 0 then 'Possible reject' when nreq > 0 and nok = nreq then 'Perfect fit' else coalesce(ai ->> 'verdict', 'Possible fit') end,
            'gaps', to_jsonb(said_no),
            'answersUsed', jsonb_array_length(pairs), 'updatedAt', now(), 'followups', null)
          else ai end
      where id = o.candidate_job_id;
  end if;
  select job_title into l from leads where id = o.lead_id;
  insert into candidate_timeline (candidate_id, title, done) values (cid, 'Answered our questions about ' || coalesce(l.job_title, 'a role'), true);
  perform pitch_chat(o.id, 'My answers about ' || coalesce(l.job_title, 'the role') || ':' || txt);
  return jsonb_build_object('ok', true, 'saidNo', cardinality(said_no) > 0);
end $$;
revoke all on function public.candidate_pitch_answer(text, text, jsonb) from public;
grant execute on function public.candidate_pitch_answer(text, text, jsonb) to anon, authenticated;

-- Answers already given: onto their role cards.
update public.candidate_jobs l set screening_answers = x.pairs
  from (
    select o.candidate_job_id id, jsonb_agg(jsonb_build_object('q', coalesce(q ->> 'q', q #>> '{}'), 'a', coalesce(o.answers ->> (i - 1)::int, '')) order by i) pairs
      from public.lead_offers o, jsonb_array_elements(coalesce(o.questions, '[]'::jsonb)) with ordinality t(q, i)
     where o.candidate_job_id is not null and o.answers is not null
     group by o.candidate_job_id
  ) x
 where l.id = x.id and coalesce(jsonb_array_length(l.screening_answers), 0) = 0;

-- Follow-up questions drafted for pitched roles that nobody has sent: removed (a second round).
update public.candidate_jobs l set ai = l.ai || jsonb_build_object('followups', null)
  from public.lead_offers o
 where o.candidate_job_id = l.id and l.ai -> 'followups' ->> 'state' = 'draft';
