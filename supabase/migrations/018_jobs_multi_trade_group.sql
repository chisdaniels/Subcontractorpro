-- Migration 018: multi-trade job posts split into grouped sub-jobs
--
-- When a customer needs multiple trades on one project, we create one
-- job row per trade and stamp all of them with the same group_id. Each
-- sub-job can be accepted independently by a contractor whose profile
-- includes that trade. The customer sees them grouped by group_id.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table jobs add column if not exists group_id uuid;
create index if not exists jobs_group_idx on jobs (group_id);
