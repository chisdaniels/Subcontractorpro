-- Migration 009: fix admin promotion trigger so signup works
--
-- Symptom: signing up in the app returned "Database error saving new user"
-- whenever there was a matching row in admin_invites, because the
-- auth.users AFTER INSERT trigger was rolling back the auth insert.
--
-- Two root causes:
--   1. The SECURITY DEFINER function inherited an empty / unexpected
--      search_path when fired from GoTrue, so unqualified table refs
--      (admin_invites, admins) failed to resolve.
--   2. Even after resolving, RLS on admins requires is_admin(auth.uid()),
--      but auth.uid() is null while GoTrue is still creating the row.
--
-- Fix:
--   * Recreate the function with fully-qualified schema names and a
--     pinned search_path so it always finds the right tables.
--   * Wrap the body in an exception block so a promotion failure never
--     blocks a signup — worst case, the admin is added later manually.
--   * Relax the "admins insert" RLS policy to also permit inserts when
--     the new row's email matches a pending admin_invite. Safe because
--     only existing admins can write to admin_invites.

create or replace function public.promote_admin_from_invite()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  begin
    if exists (select 1 from public.admin_invites where email = new.email) then
      insert into public.admins (user_id, email, invited_by)
      select new.id, new.email, invited_by
        from public.admin_invites
       where email = new.email
      on conflict (user_id) do nothing;

      delete from public.admin_invites where email = new.email;
    end if;
  exception when others then
    raise notice 'promote_admin_from_invite failed for %: %', new.email, sqlerrm;
  end;
  return new;
end;
$$;

-- Ensure the trigger points at the recreated function.
drop trigger if exists auth_user_admin_promote on auth.users;
create trigger auth_user_admin_promote
  after insert on auth.users
  for each row execute function public.promote_admin_from_invite();

-- Allow the trigger's insert path via RLS (matching pending invite).
drop policy if exists "admins insert admins"          on admins;
drop policy if exists "admins or invited insert admins" on admins;
create policy "admins or invited insert admins" on admins
  for insert with check (
    is_admin(auth.uid())
    or exists (select 1 from admin_invites where email = admins.email)
  );
