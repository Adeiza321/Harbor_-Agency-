-- Candidate emails are reviewed before they go: a new pitch candidate starts as 'draft' (email
-- written, not sent) until Rec Ops / an Admin reviews it and presses Send.
alter table public.lead_offers drop constraint if exists lead_offers_status_check;
alter table public.lead_offers add constraint lead_offers_status_check check (status = any (array[
  'suggested', 'sent', 'interested', 'confirmed', 'processing', 'declined', 'skipped',
  'draft', 'notified', 'reminded', 'no_email', 'acknowledged', 'ready', 'pitched', 'withdrawn', 'removed']));
