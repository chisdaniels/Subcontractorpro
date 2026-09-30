-- Migration 030: denial details are private
--
-- denied_at / denied_by / denial_reason move off the publicly readable
-- contractors table into contractor_denials, readable only by the pro and
-- admins. A row exists only while a pro is denied: admins create it, and
-- it's removed when the pro resubmits or an admin approves them.
-- Also drops contractors.verification_notes, which nothing uses.

create table if not exists contractor_denials (
  contractor_id bigint primary key references contractors(id) on delete cascade,
  denied_at     timestamptz not null default now(),
  denied_by     uuid references auth.users(id) on delete set null,
  reason        text not null
);
create index if not exists contractor_denials_denied_by_idx on contractor_denials (denied_by);
alter table contractor_denials enable row level security;

drop policy if exists "pro or admin reads denial" on contractor_denials;
drop policy if exists "admins deny" on contractor_denials;
drop policy if exists "admins edit denial" on contractor_denials;
drop policy if exists "pro or admin clears denial" on contractor_denials;
create policy "pro or admin reads denial" on contractor_denials for select to authenticated
  using (
    exists (select 1 from contractors c where c.id = contractor_denials.contractor_id and c.user_id = (select auth.uid()))
    or (select private.is_admin((select auth.uid())))
  );
create policy "admins deny" on contractor_denials for insert to authenticated
  with check ((select private.is_admin((select auth.uid()))));
create policy "admins edit denial" on contractor_denials for update to authenticated
  using ((select private.is_admin((select auth.uid()))))
  with check ((select private.is_admin((select auth.uid()))));
create policy "pro or admin clears denial" on contractor_denials for delete to authenticated
  using (
    exists (select 1 from contractors c where c.id = contractor_denials.contractor_id and c.user_id = (select auth.uid()))
    or (select private.is_admin((select auth.uid())))
  );
grant select, insert, update, delete on contractor_denials to authenticated;
grant all on contractor_denials to service_role;

-- Triggers that referenced the columns being dropped.
drop trigger if exists contractors_verification_audit on contractors;

create or replace function public.enforce_verified_admin_only()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
begin
  if (new.verified is distinct from old.verified)
     or (new.verified_at is distinct from old.verified_at)
     or (new.verified_by is distinct from old.verified_by) then
    if not private.is_admin(auth.uid()) then
      raise exception 'Only admins can modify verification fields';
    end if;
  end if;
  return new;
end;
$$;

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
    new.verified    := false;
    new.verified_at := null;
    new.verified_by := null;
  end if;
  return new;
end;
$$;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contractors' and column_name = 'denial_reason') then
    insert into contractor_denials (contractor_id, denied_at, denied_by, reason)
    select id, denied_at, denied_by, coalesce(denial_reason, '(no reason recorded)')
      from contractors where denied_at is not null
    on conflict (contractor_id) do nothing;
    alter table contractors
      drop column denied_at, drop column denied_by, drop column denial_reason,
      drop column verification_notes;
  end if;
end $$;

-- Audit: approvals on contractors, denials on their own table.
create or replace function public.log_contractor_verification_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into admin_audit_log (actor, table_name, action, row_key, old_data, new_data)
  values (auth.uid(), 'contractors', 'verification', new.id::text,
          jsonb_build_object('verified', old.verified),
          jsonb_build_object('verified', new.verified));
  return new;
end;
$$;
create trigger contractors_verification_audit
  after update on contractors
  for each row
  when (old.verified is distinct from new.verified)
  execute function public.log_contractor_verification_change();

create or replace function public.log_catalog_change()
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
          coalesce(rec->>'name', rec->>'alias', rec->>'slug', rec->>'contractor_id', rec->>'id'),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;
drop trigger if exists contractor_denials_audit on contractor_denials;
create trigger contractor_denials_audit after insert or update or delete on contractor_denials
  for each row execute function public.log_catalog_change();
