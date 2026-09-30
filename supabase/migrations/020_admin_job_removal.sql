-- Migration 020: admin can remove jobs; customer can't restore an admin-removed job
--
-- Adds jobs.deleted_by so we know who took the job off the board.
-- - Customer deletes their own job → deleted_by = posted_by, gone from
--   their view as before, permanent from the customer's side.
-- - Admin removes any job → deleted_by = admin's user_id. The customer
--   still sees the job in their "My Posted Jobs" with a "Removed by
--   admin" badge, but can't restore it.
-- Trigger blocks any UPDATE that clears deleted_at when the original
-- remover was not the caller and the caller is not an admin.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table jobs add column if not exists deleted_by uuid references auth.users(id) on delete set null;

create or replace function enforce_admin_only_undelete_jobs()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Fire only when the job transitions from deleted -> not deleted.
  if old.deleted_at is not null and new.deleted_at is null then
    if old.deleted_by is distinct from auth.uid() then
      if not is_admin(auth.uid()) then
        raise exception 'This job was removed by an admin. Only an admin can put it back on the board.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_admin_only_undelete on jobs;
create trigger jobs_admin_only_undelete
  before update on jobs
  for each row execute function enforce_admin_only_undelete_jobs();
