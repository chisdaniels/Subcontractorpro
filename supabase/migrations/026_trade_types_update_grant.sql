-- Migration 026: grant UPDATE on trade_types + admin-only UPDATE RLS
--
-- Migration 010 created trade_types with SELECT/INSERT/DELETE grants but
-- no UPDATE. When admins hit Save inside the trade Edit form, Postgres
-- rejects the write with "permission denied for table trade_types"
-- before RLS even runs.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

grant update on trade_types to authenticated;

drop policy if exists "admins update trade types" on trade_types;
create policy "admins update trade types" on trade_types
  for update
  using (is_admin(auth.uid()))
  with check (is_admin(auth.uid()));
