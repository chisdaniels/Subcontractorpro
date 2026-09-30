-- Migration 023: admin denial flow + business license + surety bond fields
--
-- Adds the columns needed for:
--   1. Every contractor to upload a business license (in addition to
--      general liability insurance).
--   2. Trades that require it (electrical/plumbing/etc.) to upload a
--      trade-specific license.
--   3. Trades that require it (electrical/plumbing/GC/etc.) to upload
--      a surety bond certificate.
--   4. Admin to deny an application with a reason the contractor sees,
--      then let the contractor correct and resubmit for another review.
--
-- Existing `license_url` / `license_number` / `license_type` fields
-- become the trade-specific license fields.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

-- Business license — required for every contractor
alter table contractors add column if not exists business_license_url    text;
alter table contractors add column if not exists business_license_number text;

-- Surety bond — required only for trades that need bonding
alter table contractors add column if not exists bond_url    text;
alter table contractors add column if not exists bond_amount int;

-- Admin denial workflow
alter table contractors add column if not exists denied_at     timestamptz;
alter table contractors add column if not exists denied_by     uuid references auth.users(id) on delete set null;
alter table contractors add column if not exists denial_reason text;

create index if not exists contractors_denied_idx on contractors (denied_at);
