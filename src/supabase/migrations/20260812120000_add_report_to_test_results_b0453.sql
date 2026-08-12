-- B0-453: persist the LLM-graded eval report ("Generate report" button) so it
-- survives page reloads and large runs can resume mid-scoring instead of
-- restarting, mirroring the insights columns added in
-- 20260725110000_add_insights_to_test_results.sql.
ALTER TABLE public.test_results
  ADD COLUMN IF NOT EXISTS report_state jsonb,
  ADD COLUMN IF NOT EXISTS report_markdown text,
  ADD COLUMN IF NOT EXISTS report_generated_at timestamptz;

COMMENT ON COLUMN public.test_results.report_state IS
  'Checkpointed progress and per-case scores for the "Generate report" eval: {status, model, totalCases, completedCases, startedAt, updatedAt, caseScores: {[testItemId]: CaseScore}, synthesis, error}. Lets scoring resume across requests on large runs instead of restarting.';
COMMENT ON COLUMN public.test_results.report_markdown IS
  'Final rendered Markdown eval report (executive summary + case-by-case detail), set once report_state.status reaches "completed".';
COMMENT ON COLUMN public.test_results.report_generated_at IS
  'Timestamp the Markdown report was last fully rendered.';
