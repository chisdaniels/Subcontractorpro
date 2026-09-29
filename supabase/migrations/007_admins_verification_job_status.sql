-- Migration 007: admins, contractor verification, job status + completion
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.
-- Then run the BOOTSTRAP block at the bottom with your email.

-- =============================================================
-- ADMIN TABLES + is_admin() predicate
-- =============================================================

create table if not exists admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  created_at timestamptz default now(),
  invited_by uuid references auth.users(id) on delete set null
);

create table if not exists admin_invites (
  email      text primary key,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

alter table admins        enable row level security;
alter table admin_invites enable row level security;

create or replace function is_admin(u uuid) returns boolean
language sql stable security definer as $$
  select exists(select 1 from admins where user_id = u)
$$;

-- A user can read their own admin row (to know they're an admin);
-- admins can read the full list.
drop policy if exists "signed-in read admins" on admins;
create policy "read own or admin sees all" on admins for select
  using (user_id = auth.uid() or is_admin(auth.uid()));

drop policy if exists "admins manage admins" on admins;
create policy "admins insert admins" on admins for insert
  with check (is_admin(auth.uid()));

drop policy if exists "admins delete admins" on admins;
create policy "admins delete admins" on admins for delete
  using (is_admin(auth.uid()));

drop policy if exists "admins manage invites" on admin_invites;
create policy "admins select invites" on admin_invites for select using (is_admin(auth.uid()));
create policy "admins insert invites" on admin_invites for insert with check (is_admin(auth.uid()));
create policy "admins delete invites" on admin_invites for delete using (is_admin(auth.uid()));

grant select, insert, delete on admins        to authenticated;
grant select, insert, delete on admin_invites to authenticated;

-- Auto-promote from an invite when the invited email signs up
create or replace function promote_admin_from_invite() returns trigger
language plpgsql security definer as $$
begin
  if exists (select 1 from admin_invites where email = new.email) then
    insert into admins (user_id, email, invited_by)
    select new.id, new.email, invited_by from admin_invites where email = new.email
    on conflict (user_id) do nothing;
    delete from admin_invites where email = new.email;
  end if;
  return new;
end;
$$;

drop trigger if exists auth_user_admin_promote on auth.users;
create trigger auth_user_admin_promote
  after insert on auth.users
  for each row execute function promote_admin_from_invite();

-- =============================================================
-- CONTRACTOR VERIFICATION
-- =============================================================

alter table contractors add column if not exists verified           boolean default false;
alter table contractors add column if not exists verified_at        timestamptz;
alter table contractors add column if not exists verified_by        uuid references auth.users(id) on delete set null;
alter table contractors add column if not exists verification_notes text;

-- Tighten the contractor update policy: owner can edit their own row,
-- admins can edit anyone's row. Removes the earlier permissive policy.
drop policy if exists "contractors update any" on contractors;
create policy "owner or admin updates contractor" on contractors
  for update using (
    auth.uid() = user_id or is_admin(auth.uid())
  ) with check (
    auth.uid() = user_id or is_admin(auth.uid())
  );

-- Prevent non-admins from flipping their own `verified` flag.
create or replace function enforce_verified_admin_only() returns trigger
language plpgsql security definer as $$
begin
  if (new.verified           is distinct from old.verified)
     or (new.verified_at     is distinct from old.verified_at)
     or (new.verified_by     is distinct from old.verified_by)
     or (new.verification_notes is distinct from old.verification_notes) then
    if not is_admin(auth.uid()) then
      raise exception 'Only admins can modify verification fields';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists contractors_verified_admin_only on contractors;
create trigger contractors_verified_admin_only
  before update on contractors
  for each row execute function enforce_verified_admin_only();

-- =============================================================
-- JOB STATUS + COMPLETION
-- =============================================================

alter table jobs add column if not exists status              text default 'open'
  check (status in ('open','accepted','completed'));
alter table jobs add column if not exists completed_at        timestamptz;
alter table jobs add column if not exists completion_rating   int check (completion_rating between 1 and 5);
alter table jobs add column if not exists completion_comment  text;

-- Backfill existing rows
update jobs set status = case when accepted_by is not null then 'accepted' else 'open' end
  where status is null or status = 'open';

-- Keep status in sync automatically
create or replace function jobs_sync_status() returns trigger
language plpgsql as $$
begin
  if new.completed_at is not null then
    new.status := 'completed';
  elsif new.accepted_by is not null then
    new.status := 'accepted';
  else
    new.status := 'open';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_status_sync on jobs;
create trigger jobs_status_sync
  before insert or update on jobs
  for each row execute function jobs_sync_status();

-- Job update policy:
--  - poster can edit their own open job or mark it complete;
--  - any signed-in user can claim an open job (used by the accept flow);
--  - the accepting contractor can update their claimed job;
--  - admins can do anything.
drop policy if exists "jobs update any" on jobs;
create policy "jobs update scoped" on jobs
  for update using (
    (auth.uid() = posted_by)
    or (auth.uid() is not null and accepted_by is null)
    or (auth.uid() = accepted_by)
    or is_admin(auth.uid())
  ) with check (
    auth.uid() is not null
  );

-- =============================================================
-- BOOTSTRAP FIRST ADMIN
-- Uncomment the block below with your email after running everything above.
-- This is a one-time bootstrap — every admin after this is added via
-- the in-app Admin dashboard.
-- =============================================================
-- insert into admins (user_id, email)
-- select id, email from auth.users where email = 'you@example.com'
-- on conflict (user_id) do nothing;
