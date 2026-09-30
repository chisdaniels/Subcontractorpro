-- Migration 019: only admins can un-deactivate an admin-deactivated contractor
--
-- Rule: if `deactivated_by` matches the contractor's own user_id, they can
-- flip themselves back on. If it's anyone else's user_id (i.e. an admin
-- took them off the board), only an admin can put them back on.
--
-- Enforced by a BEFORE UPDATE trigger so the RLS-level "owner updates"
-- policy can't be bypassed.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

create or replace function enforce_admin_reactivate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Transition from deactivated -> reactivated?
  if old.deactivated_at is not null and new.deactivated_at is null then
    -- If the original deactivation was done by someone OTHER than the
    -- contractor themselves, only an admin can lift it.
    if old.deactivated_by is distinct from old.user_id then
      if not is_admin(auth.uid()) then
        raise exception 'This profile was taken off the board by an admin. Only an admin can put it back on.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists contractors_admin_reactivate on contractors;
create trigger contractors_admin_reactivate
  before update on contractors
  for each row execute function enforce_admin_reactivate();
