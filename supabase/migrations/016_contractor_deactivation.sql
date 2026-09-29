-- Migration 016: contractors can be taken off the board without deletion
--
-- Adds two nullable columns: deactivated_at (when they went off the board)
-- and deactivated_by (which user_id did it — self or an admin).
-- The existing RLS policy "owner or admin updates contractor" already
-- allows both parties to set these fields.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table contractors add column if not exists deactivated_at timestamptz;
alter table contractors add column if not exists deactivated_by uuid references auth.users(id) on delete set null;

create index if not exists contractors_deactivated_idx on contractors (deactivated_at);
