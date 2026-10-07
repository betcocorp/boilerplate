-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed verbatim from pg_get_functiondef() on 2026-08-27, not from memory.
--
-- `public.list_available_app_versions()` (B0-575) exists live — the live supabase_migrations ledger
-- carries a row named `list_available_app_versions_rpc_b0575` — but no migration file was ever
-- committed, so scripts/check-schema-drift.mjs reported `fn-missing`.
--
-- Zero-argument function; the signature below matches live exactly, so CREATE OR REPLACE replaces
-- rather than creating a second overload. Verified against pg_get_function_identity_arguments
-- (live: empty) both before and after.
--
-- Every statement below is a NO-OP against the current live database.

create or replace function public.list_available_app_versions()
returns setof text
language sql
stable
set search_path = public
as $$
  select distinct v.app_version
  from (
    select wr.app_version
    from public.workflow_runs wr
    where wr.app_version is not null
    union
    select tr.app_version
    from public.test_results tr
    join public.tests t on t.id = tr.test_id
    where t.is_golden
      and tr.app_version is not null
  ) v;
$$;

-- Live ACL is {postgres=X, service_role=X}: PUBLIC/anon/authenticated were explicitly revoked,
-- matching the lockdown convention in 20260722061000_rag_security_lockdown_rpc_grants_search_path.sql.
revoke execute on function public.list_available_app_versions() from public, anon, authenticated;
grant execute on function public.list_available_app_versions() to service_role;
