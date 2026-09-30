-- Migration 028: security + performance hardening
--
--   * is_admin() moves to a `private` schema so it is no longer an
--     exposed /rpc endpoint. RLS policies keep working (they reference
--     the function by oid); functions that call it get `private` on their
--     search_path.
--   * rename_trade() becomes SECURITY INVOKER — admins' own RLS rights
--     cover every write it makes — and the one-off seed worker
--     _apply_trade_rename() is dropped.
--   * Trigger functions are no longer executable through the API, and
--     every function pins its search_path.
--   * Every RLS policy is rewritten to evaluate auth.uid()/is_admin once
--     per query instead of once per row, and scoped to the roles that
--     actually use it.
--   * Closes write holes: anyone (even logged out) could create contractor
--     profiles or jobs under any user id; any signed-in user could edit any
--     field of any open job; the admin-invite policy let a signed-in user
--     add themselves as admin if they knew a pending invite email.
--   * Jobs: non-posters may only claim an open job for themselves, and only
--     when their profile is approved for that service.
--   * Admin invites for people who already have an account now take effect
--     immediately (previously they only applied at signup).
--   * Support tickets are created by the notify-admins-support-ticket Edge
--     Function (service role), which also fixes logged-out submissions.
--   * Indexes every foreign key.
--
-- Safe to re-run.

-- =============================================================
-- 1. is_admin() -> private schema
-- =============================================================

create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'is_admin' and pronamespace = 'public'::regnamespace) then
    alter function public.is_admin(uuid) set schema private;
  end if;
end $$;

alter function private.is_admin(uuid) set search_path = public, pg_catalog;
revoke all on function private.is_admin(uuid) from public;
grant execute on function private.is_admin(uuid) to anon, authenticated, service_role;

alter function public.enforce_admin_only_undelete_jobs() set search_path = public, private, pg_catalog;
alter function public.enforce_admin_reactivate()         set search_path = public, private, pg_catalog;
alter function public.enforce_contractor_admin_fields()  set search_path = public, private, pg_catalog;
alter function public.enforce_verified_admin_only()      set search_path = public, private, pg_catalog;
alter function public.update_contractor_stats()          set search_path = public, pg_catalog;
alter function public.jobs_sync_status()                 set search_path = public, pg_catalog;

-- =============================================================
-- 2. rename_trade(): security invoker, single implementation
-- =============================================================

drop function if exists public._apply_trade_rename(text, text);

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
alter function public.rename_trade(text, text) security invoker;
revoke all on function public.rename_trade(text, text) from public, anon;
grant execute on function public.rename_trade(text, text) to authenticated;

-- =============================================================
-- 3. Job update rules
-- =============================================================

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

  -- Claiming an open job: always for yourself, and only with an approved
  -- profile that covers the job's service.
  if old.accepted_by is null and new.accepted_by is not null then
    if new.accepted_by is distinct from uid or old.deleted_at is not null or not exists (
      select 1 from contractors c
       where c.user_id = uid
         and c.verified
         and c.deactivated_at is null
         and (c.business_license_url is not null or c.license_url is not null)
         and c.insurance_url is not null
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

  -- Everyone else may only claim.
  if old.accepted_by is null and new.accepted_by = uid
     and (to_jsonb(new) - 'accepted_by' - 'accepted_at' - 'status')
       = (to_jsonb(old) - 'accepted_by' - 'accepted_at' - 'status') then
    return new;
  end if;
  raise exception 'Only the person who posted this job can change it.';
end;
$$;

drop trigger if exists jobs_update_rules on jobs;
create trigger jobs_update_rules
  before update on jobs
  for each row execute function public.enforce_job_update_rules();

-- =============================================================
-- 4. Admin invites for existing accounts take effect immediately
-- =============================================================

create or replace function public.promote_existing_user_on_invite()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  existing uuid;
begin
  select id into existing from auth.users where lower(email) = lower(new.email) limit 1;
  if existing is not null then
    insert into public.admins (user_id, email, invited_by)
    values (existing, new.email, new.invited_by)
    on conflict (user_id) do nothing;
    delete from public.admin_invites where email = new.email;
  end if;
  return null;
end;
$$;

drop trigger if exists admin_invites_promote_existing on admin_invites;
create trigger admin_invites_promote_existing
  after insert on admin_invites
  for each row execute function public.promote_existing_user_on_invite();

-- =============================================================
-- 5. Functions that only run as triggers are not API-callable
-- =============================================================

revoke all on function public.enforce_admin_only_undelete_jobs()   from public, anon, authenticated;
revoke all on function public.enforce_admin_reactivate()           from public, anon, authenticated;
revoke all on function public.enforce_contractor_admin_fields()    from public, anon, authenticated;
revoke all on function public.enforce_verified_admin_only()        from public, anon, authenticated;
revoke all on function public.enforce_job_update_rules()           from public, anon, authenticated;
revoke all on function public.jobs_sync_status()                   from public, anon, authenticated;
revoke all on function public.log_catalog_change()                 from public, anon, authenticated;
revoke all on function public.log_contractor_verification_change() from public, anon, authenticated;
revoke all on function public.promote_admin_from_invite()          from public, anon, authenticated;
revoke all on function public.promote_existing_user_on_invite()    from public, anon, authenticated;
revoke all on function public.update_contractor_stats()            from public, anon, authenticated;
revoke all on function public.rls_auto_enable()                    from public, anon, authenticated;

-- =============================================================
-- 6. Table privileges: logged-out visitors can only read
-- =============================================================

revoke insert, update on contractors from anon;
revoke insert, update on jobs from anon;
revoke insert on messages, reviews from anon;
revoke insert on support_tickets from anon, authenticated;

-- =============================================================
-- 7. RLS policies — per-query auth evaluation, scoped roles
-- =============================================================

-- admin_audit_log
drop policy if exists "admins read audit log" on admin_audit_log;
create policy "admins read audit log" on admin_audit_log for select to authenticated
  using ((select private.is_admin((select auth.uid()))));

-- admin_invites
drop policy if exists "admins select invites" on admin_invites;
drop policy if exists "admins insert invites" on admin_invites;
drop policy if exists "admins delete invites" on admin_invites;
create policy "admins select invites" on admin_invites for select to authenticated
  using ((select private.is_admin((select auth.uid()))));
create policy "admins insert invites" on admin_invites for insert to authenticated
  with check ((select private.is_admin((select auth.uid()))));
create policy "admins delete invites" on admin_invites for delete to authenticated
  using ((select private.is_admin((select auth.uid()))));

-- admins
drop policy if exists "read own or admin sees all" on admins;
drop policy if exists "admins or invited insert admins" on admins;
drop policy if exists "admins insert admins" on admins;
drop policy if exists "admins delete admins" on admins;
create policy "read own or admin sees all" on admins for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin((select auth.uid()))));
create policy "admins insert admins" on admins for insert to authenticated
  with check ((select private.is_admin((select auth.uid()))));
create policy "admins delete admins" on admins for delete to authenticated
  using ((select private.is_admin((select auth.uid()))));

-- contractors
drop policy if exists "contractors insert any" on contractors;
drop policy if exists "users create own contractor profile" on contractors;
drop policy if exists "owner or admin updates contractor" on contractors;
create policy "users create own contractor profile" on contractors for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "owner or admin updates contractor" on contractors for update to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin((select auth.uid()))))
  with check (user_id = (select auth.uid()) or (select private.is_admin((select auth.uid()))));

-- job_releases
drop policy if exists "customers insert own releases" on job_releases;
drop policy if exists "customer sees own; admin sees all" on job_releases;
create policy "customers insert own releases" on job_releases for insert to authenticated
  with check (
    released_by = (select auth.uid())
    and exists (select 1 from jobs j where j.id = job_releases.job_id and j.posted_by = (select auth.uid()))
  );
create policy "customer sees own; admin sees all" on job_releases for select to authenticated
  using (released_by = (select auth.uid()) or (select private.is_admin((select auth.uid()))));

-- jobs
drop policy if exists "public insert jobs" on jobs;
drop policy if exists "users post own jobs" on jobs;
drop policy if exists "scoped read jobs" on jobs;
drop policy if exists "jobs update scoped" on jobs;
create policy "users post own jobs" on jobs for insert to authenticated
  with check (posted_by = (select auth.uid()));
create policy "scoped read jobs" on jobs for select to anon, authenticated
  using (
    (accepted_by is null and deleted_at is null)
    or posted_by = (select auth.uid())
    or accepted_by = (select auth.uid())
    or (select private.is_admin((select auth.uid())))
  );
-- Row access only; column-level rules live in the jobs_update_rules trigger.
create policy "jobs update scoped" on jobs for update to authenticated
  using (
    posted_by = (select auth.uid())
    or accepted_by is null
    or accepted_by = (select auth.uid())
    or (select private.is_admin((select auth.uid())))
  )
  with check (
    posted_by = (select auth.uid())
    or accepted_by = (select auth.uid())
    or (select private.is_admin((select auth.uid())))
  );

-- messages
drop policy if exists "sender inserts messages" on messages;
drop policy if exists "party reads messages" on messages;
create policy "sender inserts messages" on messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and recipient_id is not null
    and recipient_id <> sender_id
  );
create policy "party reads messages" on messages for select to authenticated
  using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));

-- reviews
drop policy if exists "customers delete own reviews" on reviews;
drop policy if exists "customers review own jobs" on reviews;
create policy "customers delete own reviews" on reviews for delete to authenticated
  using (user_id = (select auth.uid()));
create policy "customers review own jobs" on reviews for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from jobs j join contractors c on c.user_id = j.accepted_by
       where j.id = reviews.job_id
         and j.posted_by = (select auth.uid())
         and c.id = reviews.contractor_id
    )
  );

-- support_tickets (created by the notify-admins-support-ticket function)
drop policy if exists "anyone can submit tickets" on support_tickets;
drop policy if exists "user sees own tickets or admin sees all" on support_tickets;
drop policy if exists "admins update tickets" on support_tickets;
create policy "user sees own tickets or admin sees all" on support_tickets for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin((select auth.uid()))));
create policy "admins update tickets" on support_tickets for update to authenticated
  using ((select private.is_admin((select auth.uid()))))
  with check ((select private.is_admin((select auth.uid()))));

-- catalog tables: public read stays, admin writes
do $$
declare
  t text;
begin
  foreach t in array array['trade_types', 'service_groups', 'trade_aliases', 'requirement_rules'] loop
    execute format('drop policy if exists %I on %I', 'admins insert ' || replace(t, '_', ' '), t);
    execute format('drop policy if exists %I on %I', 'admins update ' || replace(t, '_', ' '), t);
    execute format('drop policy if exists %I on %I', 'admins delete ' || replace(t, '_', ' '), t);
    execute format('create policy %I on %I for insert to authenticated with check ((select private.is_admin((select auth.uid()))))', 'admins insert ' || replace(t, '_', ' '), t);
    execute format('create policy %I on %I for update to authenticated using ((select private.is_admin((select auth.uid())))) with check ((select private.is_admin((select auth.uid()))))', 'admins update ' || replace(t, '_', ' '), t);
    execute format('create policy %I on %I for delete to authenticated using ((select private.is_admin((select auth.uid()))))', 'admins delete ' || replace(t, '_', ' '), t);
  end loop;
end $$;

-- =============================================================
-- 8. Index every foreign key
-- =============================================================

create index if not exists admin_invites_invited_by_idx        on admin_invites (invited_by);
create index if not exists admins_invited_by_idx               on admins (invited_by);
create index if not exists contractors_deactivated_by_idx      on contractors (deactivated_by);
create index if not exists contractors_denied_by_idx           on contractors (denied_by);
create index if not exists contractors_verified_by_idx         on contractors (verified_by);
create index if not exists job_releases_contractor_user_id_idx on job_releases (contractor_user_id);
create index if not exists job_releases_job_id_idx             on job_releases (job_id);
create index if not exists job_releases_released_by_idx        on job_releases (released_by);
create index if not exists jobs_accepted_by_idx                on jobs (accepted_by);
create index if not exists jobs_deleted_by_idx                 on jobs (deleted_by);
create index if not exists jobs_posted_by_idx                  on jobs (posted_by);
create index if not exists messages_recipient_id_idx           on messages (recipient_id);
create index if not exists messages_sender_id_idx              on messages (sender_id);
create index if not exists messages_user_id_idx                on messages (user_id);
create index if not exists requirement_rules_reviewed_by_idx   on requirement_rules (reviewed_by);
create index if not exists reviews_contractor_id_idx           on reviews (contractor_id);
create index if not exists reviews_user_id_idx                 on reviews (user_id);
create index if not exists support_tickets_resolved_by_idx     on support_tickets (resolved_by);
create index if not exists support_tickets_user_id_idx         on support_tickets (user_id);
create index if not exists trade_types_group_slug_idx          on trade_types (group_slug);
