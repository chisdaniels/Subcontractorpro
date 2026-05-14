-- Migration 001: contractor profiles linked to auth + job acceptance
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

-- ============================================================
-- SCHEMA CHANGES
-- ============================================================

alter table contractors add column if not exists user_id uuid references auth.users(id) on delete set null unique;

alter table jobs add column if not exists accepted_by uuid references auth.users(id) on delete set null;
alter table jobs add column if not exists accepted_at timestamptz;

-- ============================================================
-- GRANTS for new operations
-- ============================================================

grant insert, update on contractors to anon, authenticated;
grant update on jobs                 to anon, authenticated;

-- ============================================================
-- RLS POLICIES
-- Still permissive for MVP — tighten when you scope down auth.
-- ============================================================

create policy "contractors insert any" on contractors for insert with check (true);
create policy "contractors update any" on contractors for update using (true) with check (true);
create policy "jobs update any"        on jobs        for update using (true) with check (true);
