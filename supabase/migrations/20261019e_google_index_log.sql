-- What the google-indexing function has told Google's Indexing API, per job page URL.
create table if not exists public.google_index_log (
  url text primary key,
  hash text,                 -- the job details last sent as URL_UPDATED (null after a failed send)
  notified_at timestamptz,
  deleted_at timestamptz,    -- set once Google was told the page is gone
  last_error text
);
alter table public.google_index_log enable row level security;
-- Staff can read it (no policies for writes: only the function, with the service role, writes).
create policy google_index_log_staff_read on public.google_index_log for select using (app_role() in ('admin', 'recops'));
