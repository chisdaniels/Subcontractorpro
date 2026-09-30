-- Migration 021: hide accepted/deleted jobs from everyone except participants
--
-- Replace the "public read jobs" policy with a scoped one so that a
-- contractor who did NOT accept a job cannot see it once it's been
-- picked up — even if they hit the DB directly. This enforces the
-- rule at the data layer, not just in the UI filter.
--
-- Rule:
--   Anyone can read a job that is currently OPEN and not deleted.
--   The poster (posted_by) always sees their own jobs.
--   The accepter (accepted_by) always sees their accepted job.
--   Admins see everything.
--
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

drop policy if exists "public read jobs" on jobs;
drop policy if exists "scoped read jobs" on jobs;

create policy "scoped read jobs" on jobs
  for select using (
    (accepted_by is null and deleted_at is null)
    or auth.uid() = posted_by
    or auth.uid() = accepted_by
    or is_admin(auth.uid())
  );
