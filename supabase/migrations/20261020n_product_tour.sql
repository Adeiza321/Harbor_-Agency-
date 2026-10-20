-- In-app tour: shown once to everyone (new and existing team members) until they finish or skip it.
alter table public.profiles add column if not exists tour_done_at timestamptz;
