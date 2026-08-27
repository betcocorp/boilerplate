-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed from the live catalog on 2026-08-27, not from memory.
--
-- B0-574 added run-level version stamping to `public.workflow_runs` live with no migration file.
-- The sibling change to test_results/test_result_items WAS committed
-- (20260814190000_add_app_version_to_test_results_and_items_b0472.sql) — only the workflow_runs
-- half drifted, so scripts/check-schema-drift.mjs reported both columns as `col-missing`.
--
-- Every statement below is a NO-OP against the current live database.

alter table public.workflow_runs add column if not exists app_version text;
alter table public.workflow_runs add column if not exists prompt_bundle_version text;

comment on column public.workflow_runs.app_version is
  'B0-574: package.json version of the app build that executed this run. NULL = unversioned (pre-B0-574 run), never attribute to a current version.';
comment on column public.workflow_runs.prompt_bundle_version is
  'B0-574: run-level prompt bundle hash (B0-393 PROMPT_BUNDLE_VERSION). NULL = unversioned (pre-B0-574 run).';
