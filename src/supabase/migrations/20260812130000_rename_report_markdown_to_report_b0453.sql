-- B0-453 follow-up: rename report_markdown -> report per naming request.
ALTER TABLE public.test_results RENAME COLUMN report_markdown TO report;

COMMENT ON COLUMN public.test_results.report IS
  'Final rendered Markdown eval report (executive summary + case-by-case detail), set once report_state.status reaches "completed". Persisted so the report page never needs to regenerate on view -- only on explicit Generate/Regenerate.';
