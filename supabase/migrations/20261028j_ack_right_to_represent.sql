-- A candidate's acknowledgement is their agreement for us to represent them (client terms 7.4).
-- The pitch email and the candidate page now say so next to "Acknowledge"; when a lead offer is
-- first acknowledged (the Acknowledge button, or answering the pitch questions), the wording they
-- agreed to, the time, their IP address and device are recorded on the offer, so a client can't
-- argue we had no right to represent them.
alter table public.lead_offers
  add column if not exists represent_consent text,
  add column if not exists represent_consent_at timestamptz,
  add column if not exists represent_ip text,
  add column if not exists represent_ua text;

create or replace function public.lead_offers_represent_consent() returns trigger
language plpgsql set search_path = public as $$
declare h json;
begin
  if new.acknowledged_at is null or (tg_op = 'UPDATE' and old.acknowledged_at is not null) or new.represent_consent_at is not null then
    return new;
  end if;
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  new.represent_consent := 'Agreed to be represented by the Agency to this employer, for this role and any other role with them, and for their profile to be shared with them (by acknowledging the role).';
  new.represent_consent_at := new.acknowledged_at;
  new.represent_ip := nullif(left(split_part(coalesce(h ->> 'x-forwarded-for', h ->> 'cf-connecting-ip', ''), ',', 1), 80), '');
  new.represent_ua := left(h ->> 'user-agent', 300);
  return new;
end $$;
drop trigger if exists lead_offers_represent_consent on public.lead_offers;
create trigger lead_offers_represent_consent before insert or update of acknowledged_at on public.lead_offers
  for each row execute function public.lead_offers_represent_consent();
