-- B0-394 — promote `promptVersion` and `answerProvenance` out of `test_result_items.response_payload`
-- into stored generated columns so prompt-version grouping and run-over-run comparison can be
-- indexed instead of scanning jsonb across every historical run.
--
-- Both are plain `text`, not enums and not CHECK-constrained. A generated column is computed on
-- every insert, so a constraint here would turn an unexpected payload value into a failed test-run
-- write (losing the run) rather than a queryable oddity. `answerProvenance` is validated at the
-- application boundary by `answerProvenanceSchema`; the enum is expected to gain members, and
-- widening a DB enum/CHECK in lockstep with the Zod schema is a migration we do not want to owe.
--
-- Existing rows are safe: `->>` on a jsonb value that lacks the key yields NULL, and on a NULL
-- `response_payload` yields NULL — so the 10,159 payload-bearing rows and the 17 null-payload rows
-- all backfill to NULL rather than erroring. `nullif(..., '')` additionally folds an empty-string
-- value to NULL so it cannot form a junk grouping bucket (matches the non-empty-string checks the
-- extractors in `~/lib/tests/response-payload.ts` already apply).
--
-- DELIBERATELY NOT INCLUDED: `workflow_run_id`. The ticket floats it, but `public.test_result_items`
-- already carries a real (non-generated) `workflow_run_id uuid` column with a foreign key to
-- `public.workflow_runs (id) on delete set null`, index `test_result_items_workflow_run_id_idx`, and
-- a completed backfill. Re-adding it as a generated column would be actively harmful: Postgres
-- rejects `on delete set null` on a foreign key covering a generated column, so a fresh database
-- that applied this migration first would then fail to apply the real one. The existing column also
-- gives referential integrity and direct joins, which a generated text/uuid copy would not.
alter table public.test_result_items
  add column if not exists prompt_version text
    generated always as (nullif(response_payload ->> 'promptVersion', '')) stored,
  add column if not exists answer_provenance text
    generated always as (nullif(response_payload ->> 'answerProvenance', '')) stored;

comment on column public.test_result_items.prompt_version is
  'B0-394. Generated from response_payload->>''promptVersion'' (B0-393 hash of the specialist policy that ran). Null for items recorded before prompt-version stamping, or where the workflow declined before a specialist was selected.';

comment on column public.test_result_items.answer_provenance is
  'B0-394. Generated from response_payload->>''answerProvenance'' — which stage produced the final answer text (model_generated, template_override, cross_reference_composed, decline_gate, usage_safety_fallback, validator_fallback, revision_pass). Null for items predating provenance stamping. Free text by design; the enum is enforced by answerProvenanceSchema in the app.';

-- Partial indexes: every one of the 10,176 rows recorded before this epic has a NULL for both
-- columns, and that skew is permanent for historical data. `where ... is not null` keeps the
-- indexes proportional to instrumented rows only. This costs nothing for the intended queries —
-- grouping/filtering a prompt version always excludes the NULL bucket, and the planner proves the
-- predicate from either an explicit `is not null` or an equality on the column.
create index if not exists test_result_items_prompt_version_idx
  on public.test_result_items (prompt_version)
  where prompt_version is not null;

create index if not exists test_result_items_answer_provenance_idx
  on public.test_result_items (answer_provenance)
  where answer_provenance is not null;

-- Run-over-run comparison reads one prompt version's items ordered/joined by run, so lead with
-- prompt_version and carry test_result_id to keep the lookup index-only where possible.
create index if not exists test_result_items_prompt_version_result_idx
  on public.test_result_items (prompt_version, test_result_id)
  where prompt_version is not null;
