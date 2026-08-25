-- B0-671: record which resolved OpenAI model id an `llm` routing-test run actually called, so a
-- past run's history shows the model used to produce it (not just that it was the "llm" router).
-- Additive, nullable — null for keyword/semantic runs and for any pre-existing llm run rows.
ALTER TABLE public.routing_test_runs
  ADD COLUMN model text NULL;

COMMENT ON COLUMN public.routing_test_runs.model IS
  'B0-671: resolved OpenAI model id the llm router called for this run (via resolveResponsesModel), null for keyword/semantic runs or an llm run with no explicit model tag chosen.';
