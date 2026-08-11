-- B0-420: give persisted AI suggestions somewhere to record how they were generated.
--
-- The trace page's prompt insights are moving from POST-only (re-billing a gpt-4.1-mini
-- call on every panel open, over input that cannot change — a completed run is immutable)
-- to persisted rows under the existing `ai_suggestions` table, scope `entity_type =
-- 'workflow_run'`, alongside the current 'item' scope.
--
-- Those insights are generated either WITH harness grading context (the run resolves to a
-- test_result_items row, so the model can see pass/fail, the expected answer and the ideal
-- response) or WITHOUT it (a live Bex chat run, or a harness run whose test data was since
-- deleted). Without recording which, a stored row generated before the harness link
-- resolved is indistinguishable from a grading-aware one, and would be served forever as
-- though it had seen the expectations.
--
-- jsonb rather than a single boolean: the flag is metadata *about the generation*, and this
-- leaves room for the next one (model tier, prompt version) without another migration.
-- Deliberately NOT a column on workflow_runs — that is the hot table behind the
-- /admin/observability list.

BEGIN;

alter table public.ai_suggestions
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.ai_suggestions.metadata is
  'Generation metadata for this suggestion set. B0-420 stores {"gradingContext": true|false} for entity_type=''workflow_run'' rows: whether harness pass/fail, expected-should-answer and ideal_response were available to the model when these insights were produced. A row lacking gradingContext=true is regenerated once grading context becomes available. Defaults to an empty object for pre-B0-420 rows and for the ''item'' scope.';

COMMIT;
