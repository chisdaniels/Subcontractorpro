-- Migration 008: contractors can register for multiple trades
-- A subcontractor rarely does just one thing (a GC may also do carpentry,
-- a plumber may do dirt work, etc.). Store all their trades as an array,
-- keep the singular `trade` column as the primary/display trade for
-- backwards compatibility.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table contractors add column if not exists trades text[] default '{}';

-- Backfill from the existing singular trade
update contractors
   set trades = array[trade]
 where (trades is null or array_length(trades, 1) is null)
   and trade is not null;

-- GIN index so `trades && array[$1]` queries stay fast
create index if not exists contractors_trades_gin_idx on contractors using gin(trades);
