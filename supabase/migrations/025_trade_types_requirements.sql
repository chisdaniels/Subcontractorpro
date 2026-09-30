-- Migration 025: license & bond requirements move from a hardcoded
-- frontend const into the trade_types table so admins can manage them
-- from the Admin dashboard without a code deploy.
--
--   trade_license_label   text (nullable) — if set, contractors who
--                                          register for this trade must
--                                          upload a license document with
--                                          this label (e.g. "State Plumbing
--                                          License"). Leave null for
--                                          trades that don't need one.
--   requires_bond         boolean         — if true, contractors must
--                                          upload a surety bond.
--
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table trade_types add column if not exists trade_license_label text;
alter table trade_types add column if not exists requires_bond boolean not null default false;

-- Backfill with current defaults so nothing changes on first load.
update trade_types set trade_license_label = 'State Plumbing License',                requires_bond = true where name = 'Plumber';
update trade_types set trade_license_label = 'State Electrical License',              requires_bond = true where name = 'Electrician';
update trade_types set trade_license_label = 'State Contractor''s License',           requires_bond = true where name = 'General Contractor';
update trade_types set trade_license_label = 'State Contractor / Roofing License',    requires_bond = true where name = 'Roofer';
update trade_types set trade_license_label = 'Excavation / Utility Contractor License', requires_bond = true where name = 'Dirt Work';

-- Admin can rename a trade and have every contractor + job reference
-- migrate atomically. Enforced admin-only inside the function so RLS
-- can't be bypassed. Also handles the trade_licenses JSONB key rename.
create or replace function rename_trade(old_name text, new_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if not is_admin(auth.uid()) then
    raise exception 'Only admins can rename trades';
  end if;
  if old_name is null or new_name is null or old_name = new_name then
    return;
  end if;

  -- Rename trade_types row (or fold into an existing row with new_name).
  if exists (select 1 from trade_types where name = new_name) then
    delete from trade_types where name = old_name;
  else
    update trade_types set name = new_name where name = old_name;
  end if;

  update contractors set trade = new_name where trade = old_name;
  update contractors set trades = array_replace(trades, old_name, new_name) where old_name = any(trades);
  update jobs set trade = new_name where trade = old_name;

  update contractors
     set trade_licenses = (trade_licenses - old_name)
                          || jsonb_build_object(new_name, trade_licenses -> old_name)
   where trade_licenses ? old_name;
end;
$$;

grant execute on function rename_trade(text, text) to authenticated;
