-- Migration 032: admins can message any user, as a team
--
-- Admin conversations aren't about a contractor listing, so contractor_id
-- becomes optional. A message with no contractor_id must have an admin on
-- one side: an admin writing to a user, or the user replying to an admin.
-- from_admin marks the team's side; only admins can set it, and the sending
-- admin's email isn't stored on it, so users just see "the team". Every
-- admin can read every admin conversation (a shared team inbox); admins see
-- which of them sent each message from sender_id.

alter table messages alter column contractor_id drop not null;
alter table messages add column if not exists from_admin boolean not null default false;

create or replace function public.enforce_message_rules()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;
  if new.from_admin and not private.is_admin(auth.uid()) then
    raise exception 'Only admins can send admin messages';
  end if;
  if new.contractor_id is null
     and not (private.is_admin(new.sender_id) or private.is_admin(new.recipient_id)) then
    raise exception 'Messages must be about a contractor listing';
  end if;
  if new.from_admin then
    new.sender_email := null;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_message_rules() from public, anon, authenticated;

drop trigger if exists messages_rules on messages;
create trigger messages_rules before insert on messages
  for each row execute function public.enforce_message_rules();

-- One read policy (not two) so the advisor's multiple-permissive check stays clean.
drop policy if exists "party reads messages" on messages;
create policy "party reads messages" on messages for select to authenticated
  using (
    sender_id = (select auth.uid())
    or recipient_id = (select auth.uid())
    or (contractor_id is null and (select private.is_admin((select auth.uid()))))
  );
