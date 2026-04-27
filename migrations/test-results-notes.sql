-- Optional free-form notes on a test run (e.g. what changed vs prior runs).
ALTER TABLE public.test_results
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN public.test_results.notes IS
  'Human-entered context for this run (dataset changes, similarity tweaks, etc.).';
