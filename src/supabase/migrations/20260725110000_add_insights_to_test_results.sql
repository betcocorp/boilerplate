-- Persist "Analyze this run" AI insights so they survive page reloads
-- instead of only living in client state until the next click.
ALTER TABLE public.test_results
  ADD COLUMN IF NOT EXISTS insights jsonb,
  ADD COLUMN IF NOT EXISTS insights_generated_at timestamptz;

COMMENT ON COLUMN public.test_results.insights IS
  'Cached array of AI-generated run insights ({rank, title, description, category, impact}) from the "Analyze this run" action.';
COMMENT ON COLUMN public.test_results.insights_generated_at IS
  'Timestamp of the most recent successful insights analysis for this run.';
