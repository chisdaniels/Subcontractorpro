-- Migration 004: scope messages to the logged-in user
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table messages add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- Replace the permissive MVP policies with per-user ones.
drop policy if exists "public read messages"   on messages;
drop policy if exists "public insert messages" on messages;

create policy "users read own messages"   on messages for select using      (auth.uid() = user_id);
create policy "users insert own messages" on messages for insert with check (auth.uid() = user_id);

-- The demo seed message has no owner under the new model — drop it.
delete from messages where user_id is null;
