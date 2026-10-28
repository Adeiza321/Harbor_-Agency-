-- Delivery of outreach emails sent through Brevo (client pitches, for now): each email's latest
-- state from Brevo's events (brevo-webhook -> email_events), matched by Brevo's message id
-- (outreach_messages.provider_ref). Shown per contact on the Client leads card.
--   delivery: sent | deferred | delivered | opened | clicked | bounced | blocked | spam | invalid | failed
-- A later event only moves it forward (opened after delivered, clicked after opened); a bounce,
-- block, invalid address or spam complaint always shows, since it needs attention.

alter table public.outreach_messages add column if not exists delivery text;
alter table public.outreach_messages add column if not exists delivery_at timestamptz;
alter table public.outreach_messages add column if not exists delivery_reason text;

create or replace function public.delivery_rank(d text) returns int
language sql immutable as $$
  select case d when 'sent' then 1 when 'deferred' then 1 when 'delivered' then 2 when 'opened' then 3 when 'clicked' then 4
    when 'bounced' then 9 when 'blocked' then 9 when 'invalid' then 9 when 'spam' then 9 when 'failed' then 9 else 0 end
$$;
create or replace function public.delivery_of(ev text) returns text
language sql immutable as $$
  select case ev when 'request' then 'sent' when 'deferred' then 'deferred' when 'delivered' then 'delivered'
    when 'opened' then 'opened' when 'unique_opened' then 'opened' when 'proxy_open' then 'opened' when 'click' then 'clicked'
    when 'hard_bounce' then 'bounced' when 'soft_bounce' then 'deferred' when 'blocked' then 'blocked'
    when 'invalid' then 'invalid' when 'invalid_email' then 'invalid' when 'spam' then 'spam' when 'error' then 'failed' else null end
$$;

create or replace function public.outreach_delivery_from_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare d text := public.delivery_of(new.event);
begin
  if d is null or coalesce(new.message_id, '') = '' then return new; end if;
  update outreach_messages set delivery = d, delivery_at = new.at, delivery_reason = left(new.reason, 200)
   where provider = 'brevo' and btrim(provider_ref, '<> ') = btrim(new.message_id, '<> ')
     and public.delivery_rank(d) >= public.delivery_rank(delivery);
  return new;
end $$;
drop trigger if exists email_events_outreach_delivery on public.email_events;
create trigger email_events_outreach_delivery after insert on public.email_events
  for each row execute function public.outreach_delivery_from_event();

-- Brevo can report "sent" / "delivered" before the send has saved its message id: when the id is
-- saved, catch up from the events already received.
create or replace function public.outreach_delivery_catch_up() returns trigger
language plpgsql security definer set search_path = public as $$
declare best record;
begin
  if new.provider <> 'brevo' or coalesce(new.provider_ref, '') = '' then return new; end if;
  select public.delivery_of(e.event) d, e.at, e.reason into best
    from email_events e
   where btrim(e.message_id, '<> ') = btrim(new.provider_ref, '<> ') and public.delivery_of(e.event) is not null
   order by public.delivery_rank(public.delivery_of(e.event)) desc, e.at desc limit 1;
  if found and public.delivery_rank(best.d) >= public.delivery_rank(new.delivery) then
    new.delivery := best.d; new.delivery_at := best.at; new.delivery_reason := left(best.reason, 200);
  end if;
  return new;
end $$;
drop trigger if exists outreach_messages_delivery_catch_up on public.outreach_messages;
create trigger outreach_messages_delivery_catch_up before update of provider_ref on public.outreach_messages
  for each row execute function public.outreach_delivery_catch_up();
