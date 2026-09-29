-- Migration 006: real two-party messaging
-- The previous model scoped every message to a single user_id, which meant
-- neither party could see the other's messages. Add explicit sender/recipient
-- columns and rewrite RLS so both parties see the thread.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

alter table messages add column if not exists sender_id    uuid references auth.users(id) on delete cascade;
alter table messages add column if not exists recipient_id uuid references auth.users(id) on delete cascade;
alter table messages add column if not exists sender_email text;

-- The old sender text ('me'/'them') column is redundant now. Drop the CHECK
-- so new inserts don't need to satisfy it, and make the column nullable.
alter table messages drop constraint if exists messages_sender_check;
alter table messages alter column sender drop not null;

-- Old rows are one-sided notes with no recipient — clear them out.
delete from messages where recipient_id is null;

-- Replace the single-owner RLS policies with real party-based ones.
drop policy if exists "users read own messages"   on messages;
drop policy if exists "users insert own messages" on messages;

create policy "party reads messages" on messages
  for select using (auth.uid() in (sender_id, recipient_id));

create policy "sender inserts messages" on messages
  for insert with check (
    auth.uid() = sender_id
    and sender_id   is not null
    and recipient_id is not null
    and recipient_id <> sender_id
  );

grant insert (contractor_id, sender_id, recipient_id, sender_email, text) on messages to authenticated;

create index if not exists messages_thread_idx
  on messages (contractor_id, sender_id, recipient_id, created_at);
