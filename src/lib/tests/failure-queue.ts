/**
 * B0-617 — the heuristic `suggestResolution()` classifier that used to live here has been
 * replaced: every failing `test_result_item` now gets an automatic, evidence-based root-cause
 * analysis (~/lib/tests/failure-root-cause.ts), persisted via `ai_suggestions` and surfaced
 * through `latest_failed_test_result_items.root_cause_*` (see the failure-queue page). This
 * file keeps the one piece of UI copy that state still needs.
 */
export const FAILURE_ROOT_CAUSE_PENDING_COPY =
  'Root-cause analysis pending — the AI call may still be running, or failed silently; refresh in a moment, or open Item history to inspect manually.';
