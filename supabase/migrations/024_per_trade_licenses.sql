-- Migration 024: per-trade license storage
--
-- A contractor who covers multiple licensed trades (e.g. Plumber AND
-- Electrician) needs a distinct license document for each — one file
-- can't cover both. Store the whole set as a JSONB map keyed by trade
-- name so the frontend can render one card per required trade.
--
-- Shape: { "Electrician": { "number": "TX-123", "url": "https://…", "type": "Electrical License" }, "Plumber": { … } }
--
-- The legacy single license_url / license_number / license_type columns
-- stay for backwards compat (existing verified contractors keep their
-- data) but new/updated profiles write into trade_licenses.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table contractors add column if not exists trade_licenses jsonb default '{}'::jsonb;
