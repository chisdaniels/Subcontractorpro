-- Migration 010: dynamic trade types managed from the admin console
-- Adds a `trade_types` reference table so admins can add / remove trades
-- without a code deploy. Includes Painting and Sheetrock.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

create table if not exists trade_types (
  name       text primary key,
  created_at timestamptz default now()
);

alter table trade_types enable row level security;

drop policy if exists "everyone reads trade types" on trade_types;
drop policy if exists "admins insert trade types" on trade_types;
drop policy if exists "admins delete trade types" on trade_types;

create policy "everyone reads trade types" on trade_types
  for select using (true);

create policy "admins insert trade types" on trade_types
  for insert with check (is_admin(auth.uid()));

create policy "admins delete trade types" on trade_types
  for delete using (is_admin(auth.uid()));

grant select on trade_types to anon, authenticated;
grant insert, delete on trade_types to authenticated;

-- Seed with the existing hardcoded list plus the two new ones
insert into trade_types (name) values
  ('General Contractor'),
  ('Plumber'),
  ('Electrician'),
  ('Roofer'),
  ('Carpenter'),
  ('Mason'),
  ('Flooring'),
  ('Cabinets'),
  ('Countertops'),
  ('Landscaping'),
  ('Dirt Work'),
  ('Painting'),
  ('Sheetrock')
on conflict (name) do nothing;
