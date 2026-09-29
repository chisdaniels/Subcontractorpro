-- Migration 011: contractor can list a business website on their profile
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table contractors add column if not exists website text;
