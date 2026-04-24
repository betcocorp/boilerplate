-- Test runner schema for bex2.0
-- Creates:
--   public.tests
--   public.test_items
--   public.test_results
--   public.test_result_items

BEGIN;

CREATE TABLE IF NOT EXISTS public.tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  source_file_name text NOT NULL,
  source_bucket text NOT NULL,
  source_key text NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ready',
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.test_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  prompt text NOT NULL,
  expected_should_answer boolean,
  expected_result_type text,
  expected_canonical_product text,
  expected_reason_code text,
  input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.test_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running',
  total_items integer NOT NULL DEFAULT 0,
  passed_items integer NOT NULL DEFAULT 0,
  failed_items integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  elapsed_ms integer,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.test_result_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_result_id uuid NOT NULL REFERENCES public.test_results(id) ON DELETE CASCADE,
  test_item_id uuid NOT NULL REFERENCES public.test_items(id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  passed boolean NOT NULL DEFAULT false,
  elapsed_ms integer NOT NULL,
  error_message text,
  response_text text,
  response_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_test_items_test_id ON public.test_items (test_id);
CREATE INDEX IF NOT EXISTS idx_test_items_row_index ON public.test_items (test_id, row_index);
CREATE INDEX IF NOT EXISTS idx_test_results_test_id ON public.test_results (test_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_result_items_result_id ON public.test_result_items (test_result_id, row_index);

-- One row per failing prompt (latest failure when a test set is run many times).
CREATE OR REPLACE VIEW public.latest_failed_test_result_items AS
SELECT DISTINCT ON (tri.test_item_id)
  tri.id,
  tri.test_result_id,
  tri.test_item_id,
  tri.row_index,
  tri.passed,
  tri.status,
  tri.elapsed_ms,
  tri.error_message,
  tri.response_text,
  tri.response_payload,
  tri.created_at,
  ti.prompt,
  ti.test_id,
  ti.row_index AS item_row_index,
  t.name AS test_name,
  tr.created_at AS run_created_at
FROM public.test_result_items tri
INNER JOIN public.test_items ti ON ti.id = tri.test_item_id
INNER JOIN public.test_results tr ON tr.id = tri.test_result_id
INNER JOIN public.tests t ON t.id = ti.test_id
WHERE tri.passed = false
ORDER BY tri.test_item_id, tri.created_at DESC;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tests_updated_at ON public.tests;
CREATE TRIGGER trg_tests_updated_at
BEFORE UPDATE ON public.tests
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

COMMIT;
