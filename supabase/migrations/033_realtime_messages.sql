-- Migration 033: live message delivery
--
-- Adds messages to Supabase Realtime so open pages receive new messages
-- without a refresh. Realtime applies the table's RLS read policy to each
-- subscriber, so people only receive messages they could already read.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
