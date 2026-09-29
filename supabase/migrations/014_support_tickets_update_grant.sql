-- Migration 014: grant UPDATE on support_tickets to authenticated
--
-- Migration 013 added an "admins update tickets" RLS policy but never
-- granted UPDATE on the table to the authenticated role, so admins hit
-- "permission denied for table support_tickets" when trying to mark a
-- ticket closed / reopen. The RLS policy still enforces admin-only.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

grant update on support_tickets to authenticated;
