-- Migration 034: web push subscriptions
--
-- One row per device that turned on notifications. People can read and
-- remove only their own rows. Saving goes through save_push_subscription()
-- so a device that switches accounts moves to the new account instead of
-- tripping over the old owner's row (endpoints are unique per device).
-- The notify-message-push Edge Function reads these with the service role.
-- Idempotent without removing anything, so it can be re-run safely.

create table if not exists push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_id_idx on push_subscriptions (user_id);
alter table push_subscriptions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'owner reads push subscriptions') then
    create policy "owner reads push subscriptions" on push_subscriptions for select to authenticated
      using (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'owner removes push subscriptions') then
    create policy "owner removes push subscriptions" on push_subscriptions for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;
end $$;
revoke all on push_subscriptions from anon, authenticated;
grant select, delete on push_subscriptions to authenticated;
grant all on push_subscriptions to service_role;

create or replace function private.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to turn on notifications';
  end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Invalid push subscription';
  end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end;
$$;
revoke all on function private.save_push_subscription(text, text, text) from public, anon;
grant execute on function private.save_push_subscription(text, text, text) to authenticated;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language sql
security invoker
set search_path = public, private, pg_catalog
as $$ select private.save_push_subscription(p_endpoint, p_p256dh, p_auth) $$;
revoke all on function public.save_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;
