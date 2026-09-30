-- Migration 029: keep private data private
--
--   * job_contacts: a job's homeowner name/email/phone move out of the
--     publicly readable jobs table. Only the poster, the pro who accepted
--     the job, and admins can read them.
--   * contractor_credentials: license/insurance/bond numbers, carriers,
--     expiry dates, document paths, and admin review notes move out of the
--     publicly readable contractors table. Only the pro, admins, and a
--     customer whose job the pro accepted can read them.
--   * contractor_badges: the only credential data the public sees — which
--     credentials an admin has verified and are still current. Maintained
--     by triggers and refreshed nightly (pg_cron) so expired credentials
--     drop off without exposing expiry dates.
--   * Storage bucket `credentials` becomes private. Stored public URLs are
--     converted to object paths; the app and emails use short-lived signed
--     links instead.

-- =============================================================
-- 0. Helpers
-- =============================================================

create or replace function private.credential_path(url text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when url is null or url = '' then null
    when url like '%/credentials/%' then split_part(regexp_replace(url, '^.*?/credentials/', ''), '?', 1)
    else url
  end
$$;

-- =============================================================
-- 1. Homeowner contact details
-- =============================================================

create table if not exists job_contacts (
  job_id          bigint primary key references jobs(id) on delete cascade,
  homeowner_name  text,
  homeowner_email text,
  homeowner_phone text
);
alter table job_contacts enable row level security;

drop policy if exists "job parties read contact" on job_contacts;
drop policy if exists "poster adds contact" on job_contacts;
drop policy if exists "poster edits contact" on job_contacts;
create policy "job parties read contact" on job_contacts for select to authenticated
  using (
    exists (select 1 from jobs j where j.id = job_contacts.job_id
             and (j.posted_by = (select auth.uid()) or j.accepted_by = (select auth.uid())))
    or (select private.is_admin((select auth.uid())))
  );
create policy "poster adds contact" on job_contacts for insert to authenticated
  with check (exists (select 1 from jobs j where j.id = job_contacts.job_id and j.posted_by = (select auth.uid())));
create policy "poster edits contact" on job_contacts for update to authenticated
  using (exists (select 1 from jobs j where j.id = job_contacts.job_id and j.posted_by = (select auth.uid())))
  with check (exists (select 1 from jobs j where j.id = job_contacts.job_id and j.posted_by = (select auth.uid())));
grant select, insert, update on job_contacts to authenticated;
grant all on job_contacts to service_role;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'homeowner_email') then
    insert into job_contacts (job_id, homeowner_name, homeowner_email, homeowner_phone)
    select id, homeowner_name, homeowner_email, homeowner_phone from jobs
     where coalesce(homeowner_name, homeowner_email, homeowner_phone) is not null
    on conflict (job_id) do nothing;
    alter table jobs drop column homeowner_name, drop column homeowner_email, drop column homeowner_phone;
  end if;
end $$;

-- =============================================================
-- 2. Contractor credentials
-- =============================================================

create table if not exists contractor_credentials (
  contractor_id           bigint primary key references contractors(id) on delete cascade,
  business_license_number text,
  business_license_path   text,
  license_type            text,
  license_number          text,
  license_path            text,
  trade_licenses          jsonb not null default '{}'::jsonb,
  insurance_carrier       text,
  insurance_expires_at    date,
  insurance_path          text,
  bond_amount             int,
  bond_path               text,
  credential_reviews      jsonb not null default '{}'::jsonb,
  updated_at              timestamptz not null default now()
);
alter table contractor_credentials enable row level security;

drop policy if exists "pro, admin, or hiring customer reads credentials" on contractor_credentials;
drop policy if exists "pro adds own credentials" on contractor_credentials;
drop policy if exists "pro or admin updates credentials" on contractor_credentials;
create policy "pro, admin, or hiring customer reads credentials" on contractor_credentials for select to authenticated
  using (
    exists (select 1 from contractors c where c.id = contractor_credentials.contractor_id and c.user_id = (select auth.uid()))
    or (select private.is_admin((select auth.uid())))
    or exists (select 1 from contractors c join jobs j on j.accepted_by = c.user_id
                where c.id = contractor_credentials.contractor_id
                  and j.posted_by = (select auth.uid())
                  and j.deleted_at is null)
  );
create policy "pro adds own credentials" on contractor_credentials for insert to authenticated
  with check (exists (select 1 from contractors c where c.id = contractor_credentials.contractor_id and c.user_id = (select auth.uid())));
create policy "pro or admin updates credentials" on contractor_credentials for update to authenticated
  using (
    exists (select 1 from contractors c where c.id = contractor_credentials.contractor_id and c.user_id = (select auth.uid()))
    or (select private.is_admin((select auth.uid())))
  )
  with check (
    exists (select 1 from contractors c where c.id = contractor_credentials.contractor_id and c.user_id = (select auth.uid()))
    or (select private.is_admin((select auth.uid())))
  );
grant select, insert, update on contractor_credentials to authenticated;
grant all on contractor_credentials to service_role;

-- Only admins decide review outcomes.
create or replace function public.enforce_credential_review_admin_only()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or private.is_admin(auth.uid()) then
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.credential_reviews := '{}'::jsonb;
  elsif new.credential_reviews is distinct from old.credential_reviews then
    raise exception 'Only admins can review credentials';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists contractor_credentials_review_guard on contractor_credentials;
create trigger contractor_credentials_review_guard
  before insert or update on contractor_credentials
  for each row execute function public.enforce_credential_review_admin_only();

-- =============================================================
-- 3. Public verified-credential badges
-- =============================================================

create table if not exists contractor_badges (
  contractor_id bigint primary key references contractors(id) on delete cascade,
  verified      text[] not null default '{}'
);
alter table contractor_badges enable row level security;
drop policy if exists "everyone reads badges" on contractor_badges;
create policy "everyone reads badges" on contractor_badges for select to anon, authenticated using (true);
grant select on contractor_badges to anon, authenticated;
grant all on contractor_badges to service_role;

-- A credential counts only when an admin verified the exact file on record
-- and it hasn't expired.
create or replace function private.verified_credential_keys(cc public.contractor_credentials)
returns text[]
language sql
stable
set search_path = public, pg_catalog
as $$
  select coalesce(array_agg(r.key order by r.key), '{}')
    from jsonb_each(cc.credential_reviews) r(key, rev)
   where rev->>'status' = 'verified'
     and rev->>'doc_path' is not null
     and rev->>'doc_path' = case
           when r.key = 'business_license' then cc.business_license_path
           when r.key = 'insurance'        then cc.insurance_path
           when r.key = 'bond'             then cc.bond_path
           when r.key = 'license'          then cc.license_path
           when r.key like 'trade_license:%' then cc.trade_licenses -> substr(r.key, 15) ->> 'path'
         end
     and coalesce(nullif(rev->>'expires_on', '')::date,
                  case when r.key = 'insurance' then cc.insurance_expires_at end,
                  'infinity'::date) >= current_date
$$;

create or replace function public.sync_contractor_badges()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
begin
  insert into contractor_badges (contractor_id, verified)
  values (new.contractor_id, private.verified_credential_keys(new))
  on conflict (contractor_id) do update set verified = excluded.verified;
  return null;
end;
$$;
drop trigger if exists contractor_credentials_badges on contractor_credentials;
create trigger contractor_credentials_badges
  after insert or update on contractor_credentials
  for each row execute function public.sync_contractor_badges();

create or replace function private.refresh_contractor_badges()
returns void
language sql
security definer
set search_path = public, private, pg_catalog
as $$
  insert into contractor_badges (contractor_id, verified)
  select cc.contractor_id, private.verified_credential_keys(cc) from contractor_credentials cc
  on conflict (contractor_id) do update set verified = excluded.verified
  where contractor_badges.verified is distinct from excluded.verified;
$$;
revoke all on function private.refresh_contractor_badges() from public, anon, authenticated;
revoke all on function private.verified_credential_keys(public.contractor_credentials) from public, anon, authenticated;
revoke all on function private.credential_path(text) from public, anon, authenticated;

-- =============================================================
-- 4. Move credential data off the public contractors table
-- =============================================================

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contractors' and column_name = 'insurance_url') then
    insert into contractor_credentials (
      contractor_id, business_license_number, business_license_path,
      license_type, license_number, license_path, trade_licenses,
      insurance_carrier, insurance_expires_at, insurance_path,
      bond_amount, bond_path, credential_reviews)
    select c.id, c.business_license_number, private.credential_path(c.business_license_url),
           c.license_type, c.license_number, private.credential_path(c.license_url),
           coalesce((select jsonb_object_agg(t.key, (t.value - 'url') || jsonb_build_object('path', private.credential_path(t.value->>'url')))
                       from jsonb_each(coalesce(c.trade_licenses, '{}'::jsonb)) t), '{}'::jsonb),
           c.insurance_carrier, c.insurance_expires_at, private.credential_path(c.insurance_url),
           c.bond_amount, private.credential_path(c.bond_url),
           coalesce((select jsonb_object_agg(r.key, (r.value - 'doc_url') || jsonb_build_object('doc_path', private.credential_path(r.value->>'doc_url')))
                       from jsonb_each(coalesce(c.credential_reviews, '{}'::jsonb)) r), '{}'::jsonb)
      from contractors c
    on conflict (contractor_id) do nothing;

    drop trigger if exists contractors_verification_audit on contractors;
    alter table contractors
      drop column business_license_number, drop column business_license_url,
      drop column license_type, drop column license_number, drop column license_url,
      drop column trade_licenses,
      drop column insurance_carrier, drop column insurance_expires_at, drop column insurance_url,
      drop column bond_amount, drop column bond_url,
      drop column credential_reviews;
  end if;
end $$;

-- Contractors keep only the profile-approval guard.
create or replace function public.enforce_contractor_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or private.is_admin(auth.uid()) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.verified           := false;
    new.verified_at        := null;
    new.verified_by        := null;
    new.verification_notes := null;
  end if;
  return new;
end;
$$;

-- Audit: profile approvals on contractors, review decisions on credentials.
create or replace function public.log_contractor_verification_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into admin_audit_log (actor, table_name, action, row_key, old_data, new_data)
  values (auth.uid(), 'contractors', 'verification', new.id::text,
          jsonb_build_object('verified', old.verified, 'denied_at', old.denied_at),
          jsonb_build_object('verified', new.verified, 'denied_at', new.denied_at, 'denial_reason', new.denial_reason));
  return new;
end;
$$;
drop trigger if exists contractors_verification_audit on contractors;
create trigger contractors_verification_audit
  after update on contractors
  for each row
  when (old.verified is distinct from new.verified or old.denied_at is distinct from new.denied_at)
  execute function public.log_contractor_verification_change();

create or replace function public.log_credential_review_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into admin_audit_log (actor, table_name, action, row_key, old_data, new_data)
  values (auth.uid(), 'contractor_credentials', 'review', new.contractor_id::text,
          jsonb_build_object('credential_reviews', old.credential_reviews),
          jsonb_build_object('credential_reviews', new.credential_reviews));
  return new;
end;
$$;
drop trigger if exists contractor_credentials_review_audit on contractor_credentials;
create trigger contractor_credentials_review_audit
  after update on contractor_credentials
  for each row
  when (old.credential_reviews is distinct from new.credential_reviews)
  execute function public.log_credential_review_change();

-- Claiming a job checks documents on the private table.
create or replace function public.enforce_job_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
declare
  uid uuid := auth.uid();
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or private.is_admin(uid) then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.posted_by is distinct from old.posted_by
     or new.created_at is distinct from old.created_at
     or new.group_id is distinct from old.group_id then
    raise exception 'That job detail can''t be changed.';
  end if;
  if old.accepted_by is null and new.accepted_by is not null then
    if new.accepted_by is distinct from uid or old.deleted_at is not null or not exists (
      select 1 from contractors c
        join contractor_credentials cc on cc.contractor_id = c.id
       where c.user_id = uid
         and c.verified
         and c.deactivated_at is null
         and (cc.business_license_path is not null or cc.license_path is not null)
         and cc.insurance_path is not null
         and (old.trade = any(c.trades) or c.trade = old.trade)
    ) then
      raise exception 'You can only accept an open job that matches your approved services.';
    end if;
  end if;
  if uid is not null and uid = old.posted_by then
    if old.accepted_by is not null and new.accepted_by is distinct from old.accepted_by and new.accepted_by is not null then
      raise exception 'You can release the pro on your job, but not assign a different one.';
    end if;
    if new.deleted_by is distinct from old.deleted_by and new.deleted_by is not null and new.deleted_by <> uid then
      raise exception 'That job detail can''t be changed.';
    end if;
    return new;
  end if;
  if old.accepted_by is null and new.accepted_by = uid
     and (to_jsonb(new) - 'accepted_by' - 'accepted_at' - 'status')
       = (to_jsonb(old) - 'accepted_by' - 'accepted_at' - 'status') then
    return new;
  end if;
  raise exception 'Only the person who posted this job can change it.';
end;
$$;

-- Renames also carry license and review keys on the private table.
create or replace function public.rename_trade(old_name text, new_name text)
returns void
language plpgsql
security invoker
set search_path = public, private, pg_catalog
as $$
declare
  old_key text := 'trade_license:' || old_name;
  new_key text := 'trade_license:' || new_name;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') and not private.is_admin(auth.uid()) then
    raise exception 'Only admins can rename services';
  end if;
  if old_name is null or new_name is null or old_name = new_name then return; end if;
  if not exists (select 1 from trade_types where name = old_name) then return; end if;

  delete from trade_aliases where lower(alias) = lower(new_name);

  if exists (select 1 from trade_types where name = new_name) then
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
  update contractor_credentials
     set trade_licenses = case when trade_licenses ? new_name then trade_licenses - old_name
                               else (trade_licenses - old_name) || jsonb_build_object(new_name, trade_licenses -> old_name) end
   where trade_licenses ? old_name;
  update contractor_credentials
     set credential_reviews = case when credential_reviews ? new_key then credential_reviews - old_key
                                   else (credential_reviews - old_key) || jsonb_build_object(new_key, credential_reviews -> old_key) end
   where credential_reviews ? old_key;
end;
$$;

revoke all on function public.enforce_credential_review_admin_only() from public, anon, authenticated;
revoke all on function public.sync_contractor_badges()              from public, anon, authenticated;
revoke all on function public.log_credential_review_change()         from public, anon, authenticated;

-- =============================================================
-- 5. Private document storage
-- =============================================================

update storage.buckets set public = false where id = 'credentials';

drop policy if exists "credentials public read" on storage.objects;
drop policy if exists "credentials read" on storage.objects;
drop policy if exists "credentials owner insert" on storage.objects;
drop policy if exists "credentials owner update" on storage.objects;
drop policy if exists "credentials owner delete" on storage.objects;
create policy "credentials read" on storage.objects for select to authenticated
  using (
    bucket_id = 'credentials'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (select private.is_admin((select auth.uid())))
      or exists (select 1 from public.jobs j
                  where j.accepted_by::text = (storage.foldername(name))[1]
                    and j.posted_by = (select auth.uid())
                    and j.deleted_at is null)
    )
  );
create policy "credentials owner insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'credentials' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "credentials owner update" on storage.objects for update to authenticated
  using (bucket_id = 'credentials' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "credentials owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'credentials' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- =============================================================
-- 6. Nightly badge refresh so expired credentials drop off
-- =============================================================

create extension if not exists pg_cron;
select cron.schedule('refresh-contractor-badges', '15 6 * * *', 'select private.refresh_contractor_badges()');
select private.refresh_contractor_badges();
