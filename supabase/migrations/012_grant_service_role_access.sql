-- Migration 012: grant service_role access to all app tables
--
-- Edge Functions run under the service_role postgres role. In Supabase,
-- tables created via SQL migrations don't automatically receive service_role
-- grants (unlike tables created via the dashboard UI). Without them, the
-- Edge Function's contractor / admin lookups fail with "permission denied
-- for table X" even though service_role should bypass RLS.
--
-- Grant everything on the public schema, and set default privileges so
-- future tables also inherit.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables    in schema public to service_role;
grant usage,  select                on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;
