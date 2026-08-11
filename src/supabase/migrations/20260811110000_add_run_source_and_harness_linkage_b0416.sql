-- B0-416: persist run provenance and harness linkage as real columns (epic B0-415).
--
-- Two facts the app needs constantly were not stored anywhere:
--
--  1. Where a workflow run came from. `/admin/observability` derived it by paging
--     `test_result_items` (up to 25 x 1,000 rows) and matching an unindexed JSON path,
--     `response_payload->>'workflowRunId'`, on every list load.
--  2. Which harness item a run graded. There was no link at all, so provenance was
--     DESTROYED by deletion: `test_result_items` cascades from `test_results`, so
--     "Delete run" removed the only evidence a run was a harness run while leaving
--     `workflow_runs` / `workflow_steps` / `audit_logs` alive. Those runs were then
--     silently re-tagged as live chat traffic.
--
-- `workflow_runs.source` is stamped at execution time going forward (harness runner,
-- /api/bex/chat/stream, /api/v1/orchestrator). `test_result_items.workflow_run_id` is
-- ON DELETE SET NULL so deleting a test run drops the link and keeps the trace.
--
-- Additive only: no drops, no renames, no row deletions.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. workflow_runs.source
-- ---------------------------------------------------------------------------

ALTER TABLE public.workflow_runs
  ADD COLUMN IF NOT EXISTS source text NULL;

COMMENT ON COLUMN public.workflow_runs.source IS
  'Entry point that produced this run: harness (golden-set test runner), bex_chat (/api/bex/chat/stream), or orchestrator_api (/api/v1/orchestrator). NULL means unknown — runs recorded before B0-416 that no harness item points at are permanently unattributable (workflow_name is uniformly product-support and user_input is {message, modelTag} for every run), so they are left NULL rather than guessed.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_source_check'
  ) THEN
    ALTER TABLE public.workflow_runs
      ADD CONSTRAINT workflow_runs_source_check
      CHECK (source IS NULL OR source IN ('harness', 'bex_chat', 'orchestrator_api'));
  END IF;
END
$$;

-- Indexed because the observability list filters on it (`.eq('source', …)` /
-- `source IS NULL`), replacing the paged JSON scan.
CREATE INDEX IF NOT EXISTS workflow_runs_source_idx
  ON public.workflow_runs (source);

-- ---------------------------------------------------------------------------
-- 2. test_result_items.workflow_run_id
-- ---------------------------------------------------------------------------

ALTER TABLE public.test_result_items
  ADD COLUMN IF NOT EXISTS workflow_run_id uuid NULL;

COMMENT ON COLUMN public.test_result_items.workflow_run_id IS
  'The workflow run that produced this graded item (B0-416). ON DELETE SET NULL: deleting a test run must not delete the trace, and deleting the trace must not delete the graded result. NULL for search-mode items, for items whose turn failed before a run existed, and for items whose run row was removed.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'test_result_items_workflow_run_id_fkey'
  ) THEN
    ALTER TABLE public.test_result_items
      ADD CONSTRAINT test_result_items_workflow_run_id_fkey
      FOREIGN KEY (workflow_run_id)
      REFERENCES public.workflow_runs (id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- Item -> run traversal is covered by workflow_runs' primary key; this covers
-- run -> item ("which harness item graded this trace?", B0-419/420/421) and makes
-- the ON DELETE SET NULL lookup indexed.
CREATE INDEX IF NOT EXISTS test_result_items_workflow_run_id_idx
  ON public.test_result_items (workflow_run_id);

-- ---------------------------------------------------------------------------
-- 3. Backfill
-- ---------------------------------------------------------------------------

-- Joined on `r.id::text` rather than casting the JSON value to uuid: the payload is
-- untrusted text, and a malformed value would abort the whole migration instead of
-- simply not matching.
UPDATE public.test_result_items t
SET workflow_run_id = r.id
FROM public.workflow_runs r
WHERE t.workflow_run_id IS NULL
  AND r.id::text = t.response_payload->>'workflowRunId';

-- Every run reachable from a harness item is a harness run. Runs with no such item
-- stay NULL (unknown) — see the column comment.
UPDATE public.workflow_runs r
SET source = 'harness'
WHERE r.source IS NULL
  AND EXISTS (
    SELECT 1 FROM public.test_result_items t WHERE t.workflow_run_id = r.id
  );

COMMIT;
