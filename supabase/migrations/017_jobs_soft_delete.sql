-- Migration 017: job posters can delete their own open jobs
-- Soft delete via deleted_at so the data stays available for admin audit;
-- every user-facing query filters `deleted_at is null`.
-- Existing "jobs update scoped" RLS already lets the poster update their
-- own rows, so no policy change is needed.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table jobs add column if not exists deleted_at timestamptz;
create index if not exists jobs_deleted_idx on jobs (deleted_at);
