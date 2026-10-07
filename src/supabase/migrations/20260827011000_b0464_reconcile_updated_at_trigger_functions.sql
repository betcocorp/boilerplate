-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed verbatim from pg_get_functiondef() on 2026-08-27, not from memory.
--
-- `public.set_updated_at()` and `public.set_agent_message_feedback_updated_at()` are used by
-- triggers on public.tests, public.routing_test_items, public.test_result_comparisons and
-- public.agent_message_feedback, and 20260722061000_rag_security_lockdown_rpc_grants_search_path.sql
-- ALTERs both of them — but neither was ever CREATEd by a committed migration. Only
-- `rag.set_updated_at()` (20260403121000_create_rag_core_tables.sql) is in git; the `public`
-- namesake is a live-only object.
--
-- The name-based `fn-missing` check missed both (their names DO appear in migration text). The
-- tightened check added in this ticket — a migration must actually CREATE the function — surfaces
-- them.
--
-- Both are zero-argument trigger functions and the signatures below match live exactly, so
-- CREATE OR REPLACE replaces rather than overloading. Verified against
-- pg_get_function_identity_arguments (both: empty).
--
-- Every statement below is a NO-OP against the current live database.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions, pg_catalog
as $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

create or replace function public.set_agent_message_feedback_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions, pg_catalog
as $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Live ACL for both is the Supabase schema-public default (owner + anon/authenticated/service_role
-- EXECUTE, plus PUBLIC on these two). Nothing to grant or revoke; recorded here so a future
-- lockdown pass does not mistake the absence of GRANTs for an oversight.
