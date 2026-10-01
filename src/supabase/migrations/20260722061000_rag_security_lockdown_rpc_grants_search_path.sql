-- B0-282 / B0-283 — DB security lockdown for the rag schema.
--
-- Applied ad-hoc to production on 2026-07-22 via the Supabase API; this file makes it durable
-- in the repo so a rebuild / fresh environment reproduces it and a later CREATE OR REPLACE of
-- any maintenance routine can't silently re-open the default PUBLIC grant.
--
-- (1) Maintenance routines (chunk/sync/backfill/enrich) were flagged by Supabase advisor 0028/0029:
--     SECURITY DEFINER + executable by anon/authenticated via /rest/v1/rpc/*. Root cause is the
--     default EXECUTE grant to PUBLIC. Revoke from PUBLIC/anon/authenticated and re-grant only to
--     service_role (how the app invokes them server-side). ON ROUTINE covers both the FUNCTION and
--     PROCEDURE members. Idempotent.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'rag' AND p.proname IN (
      'backfill_sds_token_counts','backfill_token_counts_batch','chunk_document_text',
      'chunk_sds_document_text','enrich_sds_section_headings','enrich_sds_section_headings_batch',
      'run_bulk_sds_heading_backfill','sync_legacy_product_profile_chunks',
      'sync_legacy_product_profiles','sync_sds_chunks')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC, anon, authenticated;', r.sig);
    EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO service_role;', r.sig);
  END LOOP;
END $$;

-- (2) Advisor 0011: pin the role-mutable search_path on these functions (extensions kept in path
--     so trigger/admin bodies that touch pg_trgm/vector helpers keep resolving). Idempotent.
ALTER FUNCTION public.set_agent_message_feedback_updated_at() SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.set_updated_at() SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.set_orphan_ignore(text, text, text, text, boolean) SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.admin_latest_failures_count(text) SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.admin_latest_failures_page(text, integer, integer) SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.classify_prompt_category(text) SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.test_items_auto_classify() SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION rag.set_updated_at() SET search_path = rag, extensions, public, pg_catalog;
