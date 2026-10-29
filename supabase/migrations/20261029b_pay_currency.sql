-- Salary expectations always show a currency (29 Oct 2026). A figure with no currency
-- ("25,000–30,000/mo", "35,000") gets the currency of the country the candidate lives in
-- ("SAR 25,000–30,000/mo"); US figures get "$". Whichever way the salary was saved (read from
-- the resume, answered in a pitch email, the candidate page, or typed by the team).

create or replace function public.currency_for_place(p_place text) returns text
language sql immutable as $$
  select case
    when c ~* '^(saudi arabia|ksa|kingdom of saudi arabia)$' then 'SAR'
    when c ~* '^(united arab emirates|uae|dubai|abu dhabi)$' then 'AED'
    when c ~* '^qatar$' then 'QAR' when c ~* '^kuwait$' then 'KWD' when c ~* '^bahrain$' then 'BHD' when c ~* '^oman$' then 'OMR'
    when c ~* '^(south africa|rsa)$' then 'ZAR' when c ~* '^nigeria$' then 'NGN' when c ~* '^ghana$' then 'GHS' when c ~* '^kenya$' then 'KES' when c ~* '^egypt$' then 'EGP'
    when c ~* '^pakistan$' then 'PKR' when c ~* '^india$' then 'INR' when c ~* '^malaysia$' then 'MYR' when c ~* '^philippines$' then 'PHP'
    when c ~* '^(united kingdom|uk|england|scotland|wales|northern ireland)$' then 'GBP'
    when c ~* '^canada$' then 'CAD' when c ~* '^australia$' then 'AUD'
    when c ~* '^(ireland|germany|france|spain|italy|netherlands|belgium|portugal|austria|finland|greece|luxembourg|slovakia|slovenia|estonia|latvia|lithuania|malta|cyprus|croatia)$' then 'EUR'
    when c ~* '^(usa|us|united states|united states of america)$'
      or c ~ '^(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)( \d{5})?$'
      or c ~* '^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$' then 'USD'
  end
  from (select btrim(regexp_replace(split_part(coalesce(p_place, ''), ',', array_length(string_to_array(coalesce(p_place, ''), ','), 1)), '\(.*\)', '')) c) x
$$;

create or replace function public.pay_with_currency(p_pay text, p_place text) returns text
language plpgsql immutable as $$
declare cur text;
begin
  if p_pay is null or p_pay !~ '\d' then return p_pay; end if;
  -- Already has one: a symbol, a 3-letter code or a currency word.
  if p_pay ~ '[$£€₦₹¥]' or p_pay ~ '\m[A-Z]{3}\M' or p_pay ~* '\m(riyals?|dirhams?|rand|naira|rupees?|dollars?|pounds?|euros?|cedis?|shillings?)\M' then return p_pay; end if;
  cur := currency_for_place(p_place);
  if cur is null then return p_pay; end if;
  if cur = 'USD' then return regexp_replace(regexp_replace(p_pay, '^(\s*)(\d)', '\1$\2'), '([–-]\s*)(\d)', '\1$\2', 'g'); end if;
  return cur || ' ' || btrim(p_pay);
end $$;

create or replace function public.candidates_pay_currency() returns trigger
language plpgsql as $$
begin
  new.pay := pay_with_currency(new.pay, coalesce(nullif(new.preferences ->> 'currentCountry', ''), new.location));
  return new;
end $$;
drop trigger if exists candidates_pay_currency on public.candidates;
create trigger candidates_pay_currency before insert or update of pay, location on public.candidates
  for each row execute function public.candidates_pay_currency();

-- The ones already saved without a currency.
update public.candidates set pay = pay where pay ~ '\d' and pay is distinct from pay_with_currency(pay, coalesce(nullif(preferences ->> 'currentCountry', ''), location));
