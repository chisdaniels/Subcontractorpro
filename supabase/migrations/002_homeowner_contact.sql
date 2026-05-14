-- Migration 002: homeowner contact info on jobs
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table jobs add column if not exists homeowner_name  text;
alter table jobs add column if not exists homeowner_email text;
alter table jobs add column if not exists homeowner_phone text;
