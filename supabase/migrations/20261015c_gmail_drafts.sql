-- Reserved for Gmail drafts (unused for now: the gmail function checks the granted permission
-- with Google each time instead of storing it).
alter table public.google_calendar_connections add column if not exists scopes text not null default '';
alter table public.google_oauth_states add column if not exists want text;
