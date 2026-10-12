-- Several lessons per corrected screening (one row per lesson, numbered by idx).
-- Applied live on 9 Oct 2026 (migration 20261009145358); recovered into the repo from Supabase.
alter table public.screening_lessons add column if not exists idx int not null default 0;
alter table public.screening_lessons drop constraint if exists screening_lessons_source_link_id_key;
alter table public.screening_lessons add constraint screening_lessons_source_idx_key unique (source_link_id, idx);
