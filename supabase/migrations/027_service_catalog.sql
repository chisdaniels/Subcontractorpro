-- Migration 027: service catalog expansion
--
--   * 8 top-level service groups (navigation containers, not selectable).
--   * trade_types gains group, description, sort order, active flag.
--     Services are still keyed by name — every existing reference
--     (contractors.trade, contractors.trades, jobs.trade, trade_licenses
--     keys) keeps working, and renames cascade through _apply_trade_rename.
--   * trade_aliases: old names + familiar synonyms resolve to one service.
--   * requirement_rules: jurisdiction-specific LEGAL requirements with a
--     source and review date. Seeded empty on purpose — unknown rules show
--     "License requirements vary by location and scope of work."
--     trade_types.trade_license_label / requires_bond remain the PLATFORM
--     document policy (what SubcontractorPros asks for), not legal rules.
--   * contractors.credential_reviews: per-credential admin review status.
--     Starts empty for everyone, so no credential shows "verified" until an
--     admin reviews it. Profile-level `verified` is unchanged.
--   * Closes the hole where a non-admin could INSERT a contractor row with
--     verified = true (the old trigger only ran on UPDATE).
--   * admin_audit_log records catalog, rule, and verification changes.
--   * Renames the 17 existing trades in place and seeds the catalog
--     (33 launch services active, the rest inactive for later activation).
--
-- Safe to re-run: every step is idempotent.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

-- =============================================================
-- 1. SERVICE GROUPS
-- =============================================================

create table if not exists service_groups (
  slug       text primary key,
  name       text not null,
  sort_order int  not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz default now()
);
create unique index if not exists service_groups_name_uniq on service_groups (lower(name));

alter table service_groups enable row level security;
drop policy if exists "everyone reads service groups" on service_groups;
drop policy if exists "admins insert service groups" on service_groups;
drop policy if exists "admins update service groups" on service_groups;
drop policy if exists "admins delete service groups" on service_groups;
create policy "everyone reads service groups" on service_groups for select using (true);
create policy "admins insert service groups" on service_groups for insert with check (is_admin(auth.uid()));
create policy "admins update service groups" on service_groups for update using (is_admin(auth.uid())) with check (is_admin(auth.uid()));
create policy "admins delete service groups" on service_groups for delete using (is_admin(auth.uid()));
grant select on service_groups to anon, authenticated;
grant insert, update, delete on service_groups to authenticated;
grant all on service_groups to service_role;

insert into service_groups (slug, name, sort_order) values
  ('construction', 'Construction & Remodeling',            10),
  ('mechanical',   'Mechanical, Electrical & Utilities',   20),
  ('interior',     'Interior & Finish Services',           30),
  ('exterior',     'Exterior & Property Services',         40),
  ('sitework',     'Sitework & Heavy Construction',        50),
  ('cleaning',     'Cleaning, Maintenance & Restoration',  60),
  ('specialty',    'Specialty Trades & Installation',      70),
  ('professional', 'Professional & Project Services',      80)
on conflict (slug) do nothing;

-- =============================================================
-- 2. SERVICES (trade_types) — new columns
-- =============================================================

alter table trade_types add column if not exists group_slug  text references service_groups(slug) on update cascade;
alter table trade_types add column if not exists description text;
alter table trade_types add column if not exists sort_order  int not null default 0;
alter table trade_types add column if not exists is_active   boolean not null default true;
create unique index if not exists trade_types_name_normalized_uniq on trade_types (lower(name));

-- =============================================================
-- 3. ALIASES
-- =============================================================

create table if not exists trade_aliases (
  alias      text primary key,
  trade_name text not null references trade_types(name) on update cascade on delete cascade,
  created_at timestamptz default now()
);
create unique index if not exists trade_aliases_normalized_uniq on trade_aliases (lower(alias));
create index if not exists trade_aliases_trade_idx on trade_aliases (trade_name);

alter table trade_aliases enable row level security;
drop policy if exists "everyone reads trade aliases" on trade_aliases;
drop policy if exists "admins insert trade aliases" on trade_aliases;
drop policy if exists "admins update trade aliases" on trade_aliases;
drop policy if exists "admins delete trade aliases" on trade_aliases;
create policy "everyone reads trade aliases" on trade_aliases for select using (true);
create policy "admins insert trade aliases" on trade_aliases for insert with check (is_admin(auth.uid()));
create policy "admins update trade aliases" on trade_aliases for update using (is_admin(auth.uid())) with check (is_admin(auth.uid()));
create policy "admins delete trade aliases" on trade_aliases for delete using (is_admin(auth.uid()));
grant select on trade_aliases to anon, authenticated;
grant insert, update, delete on trade_aliases to authenticated;
grant all on trade_aliases to service_role;

-- =============================================================
-- 4. JURISDICTION REQUIREMENT RULES (legal requirements only)
-- =============================================================

create table if not exists requirement_rules (
  id                 bigint generated always as identity primary key,
  trade_name         text not null references trade_types(name) on update cascade on delete cascade,
  jurisdiction_level text not null check (jurisdiction_level in ('federal','state','county','city')),
  state_code         text check (state_code ~ '^[A-Z]{2}$'),
  county             text,
  city               text,
  credential_type    text not null check (credential_type in ('license','insurance','bond','registration','certification')),
  applicability      text not null check (applicability in ('required','not_required','conditional','unknown')),
  credential_label   text,
  conditions         text,
  source_url         text,
  effective_date     date,
  reviewed_at        date,
  reviewed_by        uuid references auth.users(id) on delete set null,
  notes              text,
  created_at         timestamptz default now(),
  constraint requirement_rules_state_needed  check (jurisdiction_level = 'federal' or state_code is not null),
  constraint requirement_rules_county_needed check (jurisdiction_level <> 'county' or county is not null),
  constraint requirement_rules_city_needed   check (jurisdiction_level <> 'city' or city is not null),
  -- Any determination other than "unknown" must cite a source and a review date.
  constraint requirement_rules_sourced       check (applicability = 'unknown' or (source_url is not null and reviewed_at is not null))
);
create unique index if not exists requirement_rules_scope_uniq on requirement_rules (
  trade_name, jurisdiction_level, coalesce(state_code, ''), coalesce(lower(county), ''), coalesce(lower(city), ''), credential_type
);

alter table requirement_rules enable row level security;
drop policy if exists "everyone reads requirement rules" on requirement_rules;
drop policy if exists "admins insert requirement rules" on requirement_rules;
drop policy if exists "admins update requirement rules" on requirement_rules;
drop policy if exists "admins delete requirement rules" on requirement_rules;
create policy "everyone reads requirement rules" on requirement_rules for select using (true);
create policy "admins insert requirement rules" on requirement_rules for insert with check (is_admin(auth.uid()));
create policy "admins update requirement rules" on requirement_rules for update using (is_admin(auth.uid())) with check (is_admin(auth.uid()));
create policy "admins delete requirement rules" on requirement_rules for delete using (is_admin(auth.uid()));
grant select on requirement_rules to anon, authenticated;
grant insert, update, delete on requirement_rules to authenticated;
grant usage on sequence requirement_rules_id_seq to authenticated;
grant all on requirement_rules to service_role;

-- =============================================================
-- 5. PER-CREDENTIAL REVIEWS + ADMIN-ONLY FIELD PROTECTION
-- =============================================================
-- Shape: { "business_license" | "insurance" | "bond" | "license" | "trade_license:<Service>":
--          { status: "verified"|"rejected"|"pending", jurisdiction, scope, expires_on,
--            note, doc_url, reviewed_at, reviewed_by } }
-- doc_url pins the review to the exact file reviewed; replacing the file
-- puts that credential back into "pending review" automatically.

alter table contractors add column if not exists credential_reviews jsonb not null default '{}'::jsonb;

create or replace function enforce_contractor_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Only end-user requests are restricted. SQL editor / service_role pass.
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or is_admin(auth.uid()) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.verified           := false;
    new.verified_at        := null;
    new.verified_by        := null;
    new.verification_notes := null;
    new.credential_reviews := '{}'::jsonb;
  elsif new.credential_reviews is distinct from old.credential_reviews then
    raise exception 'Only admins can modify credential reviews';
  end if;
  return new;
end;
$$;

drop trigger if exists contractors_admin_fields on contractors;
create trigger contractors_admin_fields
  before insert or update on contractors
  for each row execute function enforce_contractor_admin_fields();

-- =============================================================
-- 6. RENAME / MERGE (keeps every relationship)
-- =============================================================
-- Internal worker: no admin check, not callable by clients.
create or replace function _apply_trade_rename(old_name text, new_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  old_key text := 'trade_license:' || old_name;
  new_key text := 'trade_license:' || new_name;
begin
  if old_name is null or new_name is null or old_name = new_name then return; end if;
  if not exists (select 1 from trade_types where name = old_name) then return; end if;

  -- An alias that equals the target name would shadow it.
  delete from trade_aliases where lower(alias) = lower(new_name);

  if exists (select 1 from trade_types where name = new_name) then
    -- Merge: move aliases + rules onto the survivor, then drop the old row.
    update trade_aliases set trade_name = new_name where trade_name = old_name;
    update requirement_rules r set trade_name = new_name
     where r.trade_name = old_name
       and not exists (
         select 1 from requirement_rules k
          where k.trade_name = new_name
            and k.jurisdiction_level = r.jurisdiction_level
            and coalesce(k.state_code, '') = coalesce(r.state_code, '')
            and coalesce(lower(k.county), '') = coalesce(lower(r.county), '')
            and coalesce(lower(k.city), '') = coalesce(lower(r.city), '')
            and k.credential_type = r.credential_type);
    delete from trade_types where name = old_name;
  else
    -- ON UPDATE CASCADE carries aliases + rules along.
    update trade_types set name = new_name where name = old_name;
  end if;

  insert into trade_aliases (alias, trade_name) values (old_name, new_name) on conflict do nothing;

  update jobs set trade = new_name where trade = old_name;
  update contractors set trade = new_name where trade = old_name;
  update contractors c
     set trades = (
       select array_agg(t order by ord)
         from (select distinct on (t) t, ord
                 from unnest(array_replace(c.trades, old_name, new_name)) with ordinality as u(t, ord)
                order by t, ord) d)
   where old_name = any(c.trades);
  update contractors
     set trade_licenses = case when trade_licenses ? new_name then trade_licenses - old_name
                               else (trade_licenses - old_name) || jsonb_build_object(new_name, trade_licenses -> old_name) end
   where trade_licenses ? old_name;
  update contractors
     set credential_reviews = case when credential_reviews ? new_key then credential_reviews - old_key
                                   else (credential_reviews - old_key) || jsonb_build_object(new_key, credential_reviews -> old_key) end
   where credential_reviews ? old_key;
end;
$$;
revoke all on function _apply_trade_rename(text, text) from public, anon, authenticated;

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
  perform _apply_trade_rename(old_name, new_name);
end;
$$;
grant execute on function rename_trade(text, text) to authenticated;

-- =============================================================
-- 7. NORMALIZE THE 17 EXISTING TRADES (renamed in place)
-- =============================================================

select _apply_trade_rename(o, n) from (values
  ('Carpenter',          'Carpentry & Framing'),
  ('Dirt Work',          'Excavation & Dirt Work'),
  ('Electrician',        'Electrical'),
  ('Flooring Installer', 'Flooring Installation'),
  ('General Contractor', 'General Contracting'),
  ('Mason',              'Masonry / Brick / Block'),
  ('Painting',           'Painting & Coatings'),
  ('Plumber',            'Plumbing'),
  ('Roofer',             'Roofing'),
  ('Sheetrock',          'Drywall / Sheetrock'),
  ('Welder',             'Welding & Fabrication')
) as m(o, n);

-- =============================================================
-- 8. CATALOG SEED — group, order, launch status, helper text
-- =============================================================
-- Existing rows only receive group/order/description the first time
-- (while group_slug is null); admin edits are never overwritten.

insert into trade_types (name, group_slug, sort_order, is_active, description)
select name, grp, ord, active, nullif(descr, '') from (values
  -- Construction & Remodeling
  ('General Contracting',              'construction',  10, true,  ''),
  ('Carpentry & Framing',              'construction',  20, true,  ''),
  ('Drywall / Sheetrock',              'construction',  30, true,  ''),
  ('Roofing',                          'construction',  40, true,  ''),
  ('Siding',                           'construction',  50, true,  ''),
  ('Concrete',                         'construction',  60, true,  ''),
  ('Masonry / Brick / Block',          'construction',  70, true,  ''),
  ('Foundation & Structural Repair',   'construction',  80, false, ''),
  ('Structural Steel / Ironwork',      'construction',  90, false, ''),
  ('Insulation',                       'construction', 100, true,  ''),
  ('Waterproofing',                    'construction', 110, false, ''),
  -- Mechanical, Electrical & Utilities
  ('Electrical',                       'mechanical',    10, true,  ''),
  ('Plumbing',                         'mechanical',    20, true,  ''),
  ('HVAC',                             'mechanical',    30, true,  ''),
  ('Refrigeration',                    'mechanical',    40, false, ''),
  ('Fire Protection / Sprinklers',     'mechanical',    50, false, 'Fire sprinkler and suppression systems.'),
  ('Septic Services',                  'mechanical',    60, true,  ''),
  ('Sewer & Drain Cleaning',           'mechanical',    70, true,  ''),
  ('Solar Installation & Service',     'mechanical',    80, false, ''),
  ('Generator Installation & Service', 'mechanical',    90, false, ''),
  ('Appliance Installation & Repair',  'mechanical',   100, false, ''),
  ('Commercial Kitchen Equipment',     'mechanical',   110, false, 'Installing commercial kitchen equipment.'),
  ('Restaurant Equipment Repair',      'mechanical',   120, false, 'Servicing and repairing restaurant equipment.'),
  ('Building Automation & Controls',   'mechanical',   130, false, ''),
  ('Elevator & Lift Services',         'mechanical',   140, false, ''),
  -- Interior & Finish Services
  ('Finish Carpentry & Millwork',      'interior',      10, false, 'Trim, molding, built-ins, and custom millwork.'),
  ('Cabinets',                         'interior',      20, true,  'Building or supplying cabinetry. Use Cabinet & Millwork Installation for install-only work.'),
  ('Cabinet & Millwork Installation',  'interior',      30, false, 'Installing cabinets and millwork supplied by others.'),
  ('Countertops',                      'interior',      40, true,  ''),
  ('Flooring Installation',            'interior',      50, true,  ''),
  ('Tile & Stone Installation',        'interior',      60, true,  ''),
  ('Painting & Coatings',              'interior',      70, true,  ''),
  -- Exterior & Property Services
  ('Doors & Windows',                  'exterior',      10, true,  ''),
  ('Glass / Glazing',                  'exterior',      20, false, ''),
  ('Gutters',                          'exterior',      30, true,  ''),
  ('Fencing & Gates',                  'exterior',      40, true,  ''),
  ('Decks, Patios & Pergolas',         'exterior',      50, false, ''),
  ('Pools & Spas',                     'exterior',      60, false, ''),
  ('Landscaping',                      'exterior',      70, true,  'Design, planting, and installed landscape features.'),
  ('Lawn Care',                        'exterior',      80, true,  'Recurring mowing, edging, and yard upkeep.'),
  ('Tree Service',                     'exterior',      90, true,  ''),
  ('Irrigation',                       'exterior',     100, false, 'Lawn and landscape sprinkler systems.'),
  ('Pressure Washing / Soft Washing',  'exterior',     110, true,  ''),
  ('Exterior Cleaning',                'exterior',     120, false, 'Building exterior cleaning beyond pressure washing.'),
  ('Pest Control',                     'exterior',     130, true,  ''),
  ('Garage Door Installation & Service','exterior',    140, true,  ''),
  -- Sitework & Heavy Construction
  ('Excavation & Dirt Work',           'sitework',      10, true,  'Digging, trenching, backfill, and moving dirt.'),
  ('Grading & Site Preparation',       'sitework',      20, false, 'Final grading and pad prep for construction.'),
  ('Land Clearing',                    'sitework',      30, true,  'Removing trees, brush, and debris from a lot.'),
  ('Demolition',                       'sitework',      40, true,  ''),
  ('Drainage',                         'sitework',      50, false, ''),
  ('Asphalt & Paving',                 'sitework',      60, false, ''),
  ('Hauling / Dump Truck Services',    'sitework',      70, true,  ''),
  ('Heavy Equipment Operators',        'sitework',      80, true,  ''),
  ('Crane & Rigging',                  'sitework',      90, false, ''),
  ('Equipment Rental',                 'sitework',     100, false, 'Supporting service — no construction trade required.'),
  ('Dumpster / Roll-Off Services',     'sitework',     110, false, 'Supporting service — no construction trade required.'),
  ('Portable Toilets',                 'sitework',     120, false, 'Supporting service — no construction trade required.'),
  -- Cleaning, Maintenance & Restoration
  ('Janitorial Services',              'cleaning',      10, true,  'Recurring custodial service for businesses and facilities.'),
  ('Residential Cleaning',             'cleaning',      20, true,  'Home cleaning, including move-in/move-out cleans.'),
  ('Commercial Cleaning',              'cleaning',      30, true,  'One-time or specialty cleaning for commercial spaces, including floor care.'),
  ('Construction Cleanup / Post-Construction Cleaning', 'cleaning', 40, true, 'Rough and final cleans after construction or remodeling.'),
  ('Carpet & Upholstery Cleaning',     'cleaning',      50, false, ''),
  ('Window Cleaning',                  'cleaning',      60, false, ''),
  ('Hood / Kitchen Exhaust Cleaning',  'cleaning',      70, false, ''),
  ('Junk Removal',                     'cleaning',      80, true,  ''),
  ('Moving & Labor Services',          'cleaning',      90, false, ''),
  ('Handyman Services',                'cleaning',     100, true,  'Small repairs and odd jobs.'),
  ('Property Maintenance',             'cleaning',     110, true,  'Upkeep and make-ready work for rental and managed properties.'),
  ('Facilities Maintenance',           'cleaning',     120, false, 'Ongoing maintenance for commercial buildings and facilities.'),
  ('Parking Lot Maintenance & Striping','cleaning',    130, true,  ''),
  ('Mold Remediation',                 'cleaning',     140, true,  ''),
  ('Water Damage Restoration',         'cleaning',     150, true,  ''),
  ('Fire & Smoke Restoration',         'cleaning',     160, true,  ''),
  ('Biohazard Cleanup',                'cleaning',     170, false, ''),
  ('Environmental Services',           'cleaning',     180, false, ''),
  -- Specialty Trades & Installation
  ('Welding & Fabrication',            'specialty',     10, true,  ''),
  ('Sign Installation',                'specialty',     20, true,  ''),
  ('Locksmith Services',               'specialty',     30, false, ''),
  ('Low Voltage / Data Cabling',       'specialty',     40, true,  ''),
  ('Security Systems',                 'specialty',     50, true,  'Alarm and integrated security systems. See also CCTV and Access Control.'),
  ('CCTV / Camera Installation',       'specialty',     60, true,  ''),
  ('Access Control',                   'specialty',     70, false, ''),
  ('Audio / Video Installation',       'specialty',     80, false, ''),
  ('Marine Construction',              'specialty',     90, true,  'Seawalls, bulkheads, and general marine construction. See also Dock / Pier Construction.'),
  ('Dock / Pier Construction',         'specialty',    100, true,  ''),
  ('Marine Electrical & Mechanical',   'specialty',    110, false, ''),
  -- Professional & Project Services
  ('Surveying',                        'professional',  10, false, ''),
  ('Engineering',                      'professional',  20, false, ''),
  ('Architecture & Drafting',          'professional',  30, false, ''),
  ('Interior Design',                  'professional',  40, false, ''),
  ('Inspections',                      'professional',  50, false, ''),
  ('Permit & Code Services',           'professional',  60, false, '')
) as c(name, grp, ord, active, descr)
on conflict (name) do update
  set group_slug  = excluded.group_slug,
      sort_order  = excluded.sort_order,
      description = coalesce(trade_types.description, excluded.description)
  where trade_types.group_slug is null;

-- =============================================================
-- 9. ALIASES — old names and familiar trade terms
-- =============================================================

insert into trade_aliases (alias, trade_name)
select a, t from (values
  ('General Contractor', 'General Contracting'), ('GC', 'General Contracting'), ('Home Builder', 'General Contracting'),
  ('Carpenter', 'Carpentry & Framing'), ('Framing', 'Carpentry & Framing'), ('Framer', 'Carpentry & Framing'), ('Rough Carpentry', 'Carpentry & Framing'),
  ('Sheetrock', 'Drywall / Sheetrock'), ('Drywall Hanger', 'Drywall / Sheetrock'), ('Drywall Finisher', 'Drywall / Sheetrock'), ('Tape and Float', 'Drywall / Sheetrock'),
  ('Roofer', 'Roofing'),
  ('Vinyl Siding', 'Siding'),
  ('Concrete Contractor', 'Concrete'), ('Flatwork', 'Concrete'), ('Concrete Finisher', 'Concrete'), ('Driveways', 'Concrete'),
  ('Mason', 'Masonry / Brick / Block'), ('Bricklayer', 'Masonry / Brick / Block'), ('Stonework', 'Masonry / Brick / Block'),
  ('Foundation Repair', 'Foundation & Structural Repair'), ('Structural Repair', 'Foundation & Structural Repair'),
  ('Ironworker', 'Structural Steel / Ironwork'), ('Steel Erection', 'Structural Steel / Ironwork'),
  ('Spray Foam', 'Insulation'), ('Blown-In Insulation', 'Insulation'),
  ('Basement Waterproofing', 'Waterproofing'),
  ('Electrician', 'Electrical'),
  ('Plumber', 'Plumbing'),
  ('Heating', 'HVAC'), ('Air Conditioning', 'HVAC'), ('AC Repair', 'HVAC'), ('Heating & Cooling', 'HVAC'),
  ('Commercial Refrigeration', 'Refrigeration'), ('Walk-In Cooler', 'Refrigeration'),
  ('Fire Sprinklers', 'Fire Protection / Sprinklers'), ('Fire Suppression', 'Fire Protection / Sprinklers'),
  ('Septic Pumping', 'Septic Services'), ('Septic Tank', 'Septic Services'), ('Septic Installation', 'Septic Services'),
  ('Drain Cleaning', 'Sewer & Drain Cleaning'), ('Hydro Jetting', 'Sewer & Drain Cleaning'), ('Rooter', 'Sewer & Drain Cleaning'),
  ('Solar', 'Solar Installation & Service'), ('Solar Panels', 'Solar Installation & Service'),
  ('Generator', 'Generator Installation & Service'), ('Standby Generator', 'Generator Installation & Service'),
  ('Appliance Repair', 'Appliance Installation & Repair'),
  ('Restaurant Equipment Service', 'Restaurant Equipment Repair'),
  ('Building Controls', 'Building Automation & Controls'),
  ('Elevator', 'Elevator & Lift Services'), ('Wheelchair Lift', 'Elevator & Lift Services'),
  ('Trim Carpentry', 'Finish Carpentry & Millwork'), ('Trim Carpenter', 'Finish Carpentry & Millwork'), ('Crown Molding', 'Finish Carpentry & Millwork'),
  ('Cabinet Maker', 'Cabinets'), ('Custom Cabinets', 'Cabinets'), ('Cabinetry', 'Cabinets'),
  ('Cabinet Installation', 'Cabinet & Millwork Installation'), ('Cabinet Installer', 'Cabinet & Millwork Installation'),
  ('Granite', 'Countertops'), ('Quartz', 'Countertops'),
  ('Flooring Installer', 'Flooring Installation'), ('Flooring', 'Flooring Installation'), ('Hardwood Floors', 'Flooring Installation'), ('Carpet Installation', 'Flooring Installation'),
  ('Tile', 'Tile & Stone Installation'), ('Tile Setter', 'Tile & Stone Installation'), ('Backsplash', 'Tile & Stone Installation'),
  ('Painting', 'Painting & Coatings'), ('Painter', 'Painting & Coatings'),
  ('Window Installation', 'Doors & Windows'), ('Door Installation', 'Doors & Windows'),
  ('Glazier', 'Glass / Glazing'), ('Shower Glass', 'Glass / Glazing'),
  ('Gutter Installation', 'Gutters'),
  ('Fence', 'Fencing & Gates'), ('Fence Installer', 'Fencing & Gates'),
  ('Deck Builder', 'Decks, Patios & Pergolas'), ('Pergola', 'Decks, Patios & Pergolas'),
  ('Pool Builder', 'Pools & Spas'), ('Pool Service', 'Pools & Spas'), ('Hot Tub', 'Pools & Spas'),
  ('Landscaper', 'Landscaping'), ('Hardscaping', 'Landscaping'),
  ('Mowing', 'Lawn Care'), ('Lawn Mowing', 'Lawn Care'), ('Yard Maintenance', 'Lawn Care'),
  ('Tree Removal', 'Tree Service'), ('Tree Trimming', 'Tree Service'), ('Arborist', 'Tree Service'), ('Stump Grinding', 'Tree Service'),
  ('Sprinkler System', 'Irrigation'),
  ('Power Washing', 'Pressure Washing / Soft Washing'), ('Soft Wash', 'Pressure Washing / Soft Washing'), ('House Washing', 'Pressure Washing / Soft Washing'),
  ('Exterminator', 'Pest Control'), ('Termite Control', 'Pest Control'),
  ('Garage Door Repair', 'Garage Door Installation & Service'),
  ('Dirt Work', 'Excavation & Dirt Work'), ('Excavation', 'Excavation & Dirt Work'), ('Excavator', 'Excavation & Dirt Work'), ('Earthwork', 'Excavation & Dirt Work'), ('Backhoe', 'Excavation & Dirt Work'),
  ('Grading', 'Grading & Site Preparation'), ('Site Prep', 'Grading & Site Preparation'),
  ('Lot Clearing', 'Land Clearing'), ('Brush Clearing', 'Land Clearing'), ('Forestry Mulching', 'Land Clearing'),
  ('Demo', 'Demolition'), ('Tear Out', 'Demolition'),
  ('French Drain', 'Drainage'), ('Yard Drainage', 'Drainage'),
  ('Asphalt', 'Asphalt & Paving'), ('Paving', 'Asphalt & Paving'), ('Blacktop', 'Asphalt & Paving'),
  ('Dump Truck', 'Hauling / Dump Truck Services'), ('Hauling', 'Hauling / Dump Truck Services'), ('Material Delivery', 'Hauling / Dump Truck Services'),
  ('Equipment Operator', 'Heavy Equipment Operators'), ('Dozer Operator', 'Heavy Equipment Operators'), ('Skid Steer', 'Heavy Equipment Operators'),
  ('Crane Service', 'Crane & Rigging'),
  ('Tool Rental', 'Equipment Rental'),
  ('Dumpster Rental', 'Dumpster / Roll-Off Services'), ('Roll-Off', 'Dumpster / Roll-Off Services'),
  ('Porta Potty', 'Portable Toilets'), ('Portable Restrooms', 'Portable Toilets'),
  ('Janitorial', 'Janitorial Services'), ('Janitor', 'Janitorial Services'), ('Custodial', 'Janitorial Services'), ('Office Cleaning', 'Janitorial Services'), ('Nightly Cleaning', 'Janitorial Services'),
  ('House Cleaning', 'Residential Cleaning'), ('Maid Service', 'Residential Cleaning'), ('Move-Out Cleaning', 'Residential Cleaning'), ('Move-In Cleaning', 'Residential Cleaning'), ('Deep Cleaning', 'Residential Cleaning'),
  ('Warehouse Floor Cleaning', 'Commercial Cleaning'), ('Floor Stripping & Waxing', 'Commercial Cleaning'), ('Commercial Floor Cleaning', 'Commercial Cleaning'),
  ('Construction Cleanup', 'Construction Cleanup / Post-Construction Cleaning'), ('Post-Construction Cleaning', 'Construction Cleanup / Post-Construction Cleaning'), ('Final Clean', 'Construction Cleanup / Post-Construction Cleaning'), ('Builders Clean', 'Construction Cleanup / Post-Construction Cleaning'),
  ('Carpet Cleaning', 'Carpet & Upholstery Cleaning'), ('Upholstery Cleaning', 'Carpet & Upholstery Cleaning'),
  ('Window Washing', 'Window Cleaning'),
  ('Hood Cleaning', 'Hood / Kitchen Exhaust Cleaning'), ('Kitchen Exhaust Cleaning', 'Hood / Kitchen Exhaust Cleaning'), ('Grease Duct Cleaning', 'Hood / Kitchen Exhaust Cleaning'),
  ('Debris Removal', 'Junk Removal'), ('Trash Hauling', 'Junk Removal'), ('Cleanouts', 'Junk Removal'),
  ('Movers', 'Moving & Labor Services'), ('General Labor', 'Moving & Labor Services'),
  ('Handyman', 'Handyman Services'), ('Odd Jobs', 'Handyman Services'),
  ('Make-Ready', 'Property Maintenance'), ('Rental Maintenance', 'Property Maintenance'),
  ('Building Maintenance', 'Facilities Maintenance'),
  ('Line Striping', 'Parking Lot Maintenance & Striping'), ('Sealcoating', 'Parking Lot Maintenance & Striping'), ('Parking Lot Sweeping', 'Parking Lot Maintenance & Striping'),
  ('Mold Removal', 'Mold Remediation'),
  ('Water Mitigation', 'Water Damage Restoration'), ('Flood Cleanup', 'Water Damage Restoration'),
  ('Fire Damage', 'Fire & Smoke Restoration'), ('Smoke Damage', 'Fire & Smoke Restoration'),
  ('Crime Scene Cleanup', 'Biohazard Cleanup'),
  ('Asbestos Abatement', 'Environmental Services'), ('Lead Abatement', 'Environmental Services'),
  ('Welder', 'Welding & Fabrication'), ('Metal Fabrication', 'Welding & Fabrication'), ('Fabricator', 'Welding & Fabrication'),
  ('Signage', 'Sign Installation'),
  ('Locksmith', 'Locksmith Services'), ('Rekey', 'Locksmith Services'),
  ('Low Voltage', 'Low Voltage / Data Cabling'), ('Data Cabling', 'Low Voltage / Data Cabling'), ('Structured Cabling', 'Low Voltage / Data Cabling'), ('Network Cabling', 'Low Voltage / Data Cabling'),
  ('Alarm Systems', 'Security Systems'), ('Alarm Installation', 'Security Systems'),
  ('Security Cameras', 'CCTV / Camera Installation'), ('Surveillance Cameras', 'CCTV / Camera Installation'),
  ('Keycard Systems', 'Access Control'),
  ('Home Theater', 'Audio / Video Installation'), ('TV Mounting', 'Audio / Video Installation'),
  ('Seawall', 'Marine Construction'), ('Bulkhead', 'Marine Construction'),
  ('Dock Builder', 'Dock / Pier Construction'), ('Boat Dock', 'Dock / Pier Construction'), ('Pier', 'Dock / Pier Construction'),
  ('Marine Electrician', 'Marine Electrical & Mechanical'), ('Marine Mechanic', 'Marine Electrical & Mechanical'),
  ('Land Surveyor', 'Surveying'), ('Surveyor', 'Surveying'),
  ('Structural Engineer', 'Engineering'), ('Civil Engineer', 'Engineering'),
  ('Architect', 'Architecture & Drafting'), ('Drafting', 'Architecture & Drafting'), ('House Plans', 'Architecture & Drafting'),
  ('Interior Designer', 'Interior Design'),
  ('Home Inspector', 'Inspections'), ('Building Inspection', 'Inspections'),
  ('Permit Expediter', 'Permit & Code Services'), ('Permitting', 'Permit & Code Services')
) as v(a, t)
where exists (select 1 from trade_types where name = v.t)
on conflict do nothing;

-- Aliases must never shadow a real service name.
delete from trade_aliases a using trade_types t where lower(a.alias) = lower(t.name);

-- =============================================================
-- 10. AUDIT LOG (attached after seeding so the seed isn't logged)
-- =============================================================

create table if not exists admin_audit_log (
  id         bigint generated always as identity primary key,
  actor      uuid,
  table_name text not null,
  action     text not null,
  row_key    text,
  old_data   jsonb,
  new_data   jsonb,
  created_at timestamptz default now()
);
create index if not exists admin_audit_log_created_idx on admin_audit_log (created_at desc);

alter table admin_audit_log enable row level security;
drop policy if exists "admins read audit log" on admin_audit_log;
create policy "admins read audit log" on admin_audit_log for select using (is_admin(auth.uid()));
grant select on admin_audit_log to authenticated;
grant all on admin_audit_log to service_role;

create or replace function log_catalog_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
begin
  insert into admin_audit_log (actor, table_name, action, row_key, old_data, new_data)
  values (auth.uid(), tg_table_name, lower(tg_op),
          coalesce(rec->>'name', rec->>'alias', rec->>'slug', rec->>'id'),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;

drop trigger if exists service_groups_audit on service_groups;
create trigger service_groups_audit after insert or update or delete on service_groups
  for each row execute function log_catalog_change();
drop trigger if exists trade_types_audit on trade_types;
create trigger trade_types_audit after insert or update or delete on trade_types
  for each row execute function log_catalog_change();
drop trigger if exists trade_aliases_audit on trade_aliases;
create trigger trade_aliases_audit after insert or update or delete on trade_aliases
  for each row execute function log_catalog_change();
drop trigger if exists requirement_rules_audit on requirement_rules;
create trigger requirement_rules_audit after insert or update or delete on requirement_rules
  for each row execute function log_catalog_change();

create or replace function log_contractor_verification_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into admin_audit_log (actor, table_name, action, row_key, old_data, new_data)
  values (auth.uid(), 'contractors', 'verification', new.id::text,
          jsonb_build_object('verified', old.verified, 'denied_at', old.denied_at, 'credential_reviews', old.credential_reviews),
          jsonb_build_object('verified', new.verified, 'denied_at', new.denied_at, 'denial_reason', new.denial_reason, 'credential_reviews', new.credential_reviews));
  return new;
end;
$$;

drop trigger if exists contractors_verification_audit on contractors;
create trigger contractors_verification_audit
  after update on contractors
  for each row
  when (old.verified is distinct from new.verified
        or old.denied_at is distinct from new.denied_at
        or old.credential_reviews is distinct from new.credential_reviews)
  execute function log_contractor_verification_change();
