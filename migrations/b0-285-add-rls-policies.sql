-- B0-285: Add RLS policies to tables with RLS enabled but no policies
-- Resolves security issue where RLS-enabled tables lack explicit policies
--
-- Tables fixed:
-- 1. rag.cross_reference_recommendation_candidates
-- 2. rag.cross_reference_recommendations
--
-- Pattern: PERMISSIVE policies allowing service_role full access (read + write)
-- This allows the backend service to manage these tables while enforcing
-- RLS boundaries for other roles.

BEGIN;

-- Add RLS policy to cross_reference_recommendation_candidates
-- Grants service_role full read and write access
CREATE POLICY cross_reference_recommendation_candidates_service_role
  ON rag.cross_reference_recommendation_candidates
  FOR ALL
  USING (true)
  WITH CHECK (true)
  TO service_role;

COMMENT ON POLICY cross_reference_recommendation_candidates_service_role
  ON rag.cross_reference_recommendation_candidates
  IS 'Allows service_role full access to cross_reference_recommendation_candidates table for backend operations. RLS enforces caller identity for other roles.';

-- Add RLS policy to cross_reference_recommendations
-- Grants service_role full read and write access
CREATE POLICY cross_reference_recommendations_service_role
  ON rag.cross_reference_recommendations
  FOR ALL
  USING (true)
  WITH CHECK (true)
  TO service_role;

COMMENT ON POLICY cross_reference_recommendations_service_role
  ON rag.cross_reference_recommendations
  IS 'Allows service_role full access to cross_reference_recommendations table for backend operations. RLS enforces caller identity for other roles.';

COMMIT;
