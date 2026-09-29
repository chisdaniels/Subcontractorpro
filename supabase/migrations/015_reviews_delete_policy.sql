-- Migration 015: let a customer delete their own review
--
-- Needed so that when a customer accidentally marks a job complete
-- and hits "Reopen", we can strip the review that got auto-posted
-- during the completion flow. The unique index on (job_id, contractor_id)
-- would otherwise permanently block a second Mark Complete on the same job.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

drop policy if exists "customers delete own reviews" on reviews;
create policy "customers delete own reviews" on reviews
  for delete using (auth.uid() = user_id);

grant delete on reviews to authenticated;
