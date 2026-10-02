-- Migration 031: admins can list every signed-up account
--
-- Accounts live in auth.users, which the API can't read. private.admin_list_users()
-- reads it as the owner and returns nothing unless the caller is an admin;
-- public.admin_list_users() is the invoker wrapper the app calls via rpc().
-- Returns only what the Admin "Users" section shows: no phone numbers,
-- addresses, or credential data.

create or replace function private.admin_list_users()
returns table (
  id              uuid,
  email           text,
  name            text,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  confirmed       boolean,
  is_admin        boolean,
  contractor_id   bigint,
  jobs_posted     bigint
)
language plpgsql
stable
security definer
set search_path = public, private, pg_catalog
as $$
begin
  if not private.is_admin(auth.uid()) then
    raise exception 'Only admins can list users';
  end if;
  return query
    select u.id,
           u.email::text,
           coalesce(nullif(c.name, ''), nullif(u.raw_user_meta_data->>'homeowner_name', ''))::text,
           u.created_at,
           u.last_sign_in_at,
           u.email_confirmed_at is not null,
           exists (select 1 from admins a where a.user_id = u.id),
           c.id,
           (select count(*) from jobs j where j.posted_by = u.id and j.deleted_at is null)
      from auth.users u
      left join contractors c on c.user_id = u.id
     where u.deleted_at is null
       and not coalesce(u.is_anonymous, false)
     order by u.created_at desc;
end;
$$;
revoke all on function private.admin_list_users() from public, anon;
grant execute on function private.admin_list_users() to authenticated;

create or replace function public.admin_list_users()
returns table (
  id              uuid,
  email           text,
  name            text,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  confirmed       boolean,
  is_admin        boolean,
  contractor_id   bigint,
  jobs_posted     bigint
)
language sql
stable
security invoker
set search_path = public, private, pg_catalog
as $$ select * from private.admin_list_users() $$;
revoke all on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;
