-- Persist deterministic document-retrieval evaluation snapshots for completed test runs.
-- Kept separate from test_results.summary so ordinary run-list queries do not carry the full
-- per-item metric ledger. One row per run is idempotently recomputed after retries.

CREATE TABLE IF NOT EXISTS public.test_result_rag_evaluations (
  test_result_id uuid PRIMARY KEY REFERENCES public.test_results(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  snapshot jsonb,
  error_message text,
  claim_token uuid,
  lease_expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  CONSTRAINT test_result_rag_evaluations_status_check CHECK (
    status IN ('pending', 'running', 'ready', 'failed')
  ),
  CONSTRAINT test_result_rag_evaluations_ready_snapshot_check CHECK (
    status <> 'ready' OR snapshot IS NOT NULL
  )
);

COMMENT ON TABLE public.test_result_rag_evaluations IS
  'One immutable-by-run Phase 3 RAG evaluation snapshot per completed test run. The snapshot stores coverage, label denominators, per-item metrics, aggregates, scoring options and provenance.';
COMMENT ON COLUMN public.test_result_rag_evaluations.snapshot IS
  'Validated rag-evaluation snapshot schema. Null until status=ready; retained so later corpus re-ingests cannot invalidate the measured baseline.';

ALTER TABLE public.test_result_rag_evaluations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS test_result_rag_evaluations_service_role
  ON public.test_result_rag_evaluations;
CREATE POLICY test_result_rag_evaluations_service_role
  ON public.test_result_rag_evaluations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_test_result_rag_evaluations_updated_at
  ON public.test_result_rag_evaluations;
CREATE TRIGGER trg_test_result_rag_evaluations_updated_at
  BEFORE UPDATE ON public.test_result_rag_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS test_result_rag_evaluations_status_idx
  ON public.test_result_rag_evaluations (status, updated_at DESC);
