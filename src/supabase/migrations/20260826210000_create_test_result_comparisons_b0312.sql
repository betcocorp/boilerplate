-- B0-312: persist run-vs-previous-run post-mortem comparison reports (Phase 1 of the
-- "Test Run Post-Mortem Analysis" epic, B0-310). A comparison is inherently about a PAIR of runs,
-- so it gets its own table rather than piggybacking on the single-run `test_results.report_state`
-- jsonb column, which is scoped to one run's own resumable eval-report state.

CREATE TABLE IF NOT EXISTS public.test_result_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_result_id uuid NOT NULL UNIQUE REFERENCES public.test_results(id) ON DELETE CASCADE,
  previous_test_result_id uuid REFERENCES public.test_results(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'generating',
  verdict text,
  verdict_summary text,
  current_pass_rate numeric,
  previous_pass_rate numeric,
  score_delta numeric,
  new_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  fixes jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT test_result_comparisons_status_check CHECK (
    status IN ('generating', 'ready', 'failed', 'no_baseline')
  ),
  CONSTRAINT test_result_comparisons_verdict_check CHECK (
    verdict IS NULL OR verdict IN ('improved', 'regressed', 'flat')
  )
);

COMMENT ON TABLE public.test_result_comparisons IS
  'B0-310/312 -- one row per completed test run, comparing it against the previous completed run on the same test (new failures with LLM cause+fix, fixes/recoveries, pass-rate delta, one-line verdict). Populated asynchronously via after() at run completion (B0-311/314); see ~/lib/tests/run-comparison.ts.';
COMMENT ON COLUMN public.test_result_comparisons.status IS
  'generating: job started, not yet complete. ready: analysis persisted. failed: job errored (see error_message). no_baseline: no previous completed run existed to compare against -- a clean, non-error outcome.';
COMMENT ON COLUMN public.test_result_comparisons.new_failures IS
  'Array of {resultItemId, testItemId, rowIndex, prompt, errorMessage, cause, fix}. One entry per test case that passed in the previous run and fails in this one; cause/fix come from the B0-314 LLM analysis.';
COMMENT ON COLUMN public.test_result_comparisons.fixes IS
  'Array of {resultItemId, testItemId, rowIndex, prompt, errorMessage} -- test cases that failed in the previous run and pass in this one.';

-- Same posture as public.tests / public.test_items / public.routing_test_items: RLS on,
-- service_role-only access. The app reads and writes exclusively through
-- `~/supabase/clients/service-role`.
ALTER TABLE public.test_result_comparisons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS test_result_comparisons_service_role ON public.test_result_comparisons;
CREATE POLICY test_result_comparisons_service_role ON public.test_result_comparisons
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Matches trg_routing_test_items_updated_at on public.routing_test_items.
DROP TRIGGER IF EXISTS trg_test_result_comparisons_updated_at ON public.test_result_comparisons;
CREATE TRIGGER trg_test_result_comparisons_updated_at
  BEFORE UPDATE ON public.test_result_comparisons
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS test_result_comparisons_previous_test_result_id_idx
  ON public.test_result_comparisons (previous_test_result_id);
