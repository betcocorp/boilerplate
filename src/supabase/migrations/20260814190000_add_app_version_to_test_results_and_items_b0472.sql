-- B0-472 — stamp which codebase version (package.json `version`) produced a given test run,
-- so a shift in pass rate or timing can be correlated with a deploy rather than guessed at.
--
-- Plain (non-generated) columns: unlike `prompt_version`/`answer_provenance` (B0-394), the app
-- version has no relationship to `response_payload` — it must be read from the running process's
-- own package.json at write time, not derived from data already in the row. Nullable, no default:
-- every row written before this migration has no way to know its app version, so it stays NULL
-- rather than being backfilled with a value that would misrepresent history (same precedent as
-- `prompt_version`/`ttft_ms`).
alter table public.test_results
  add column if not exists app_version text;

alter table public.test_result_items
  add column if not exists app_version text;

comment on column public.test_results.app_version is
  'B0-472. package.json version of the app that executed this run. Set explicitly by the harness at run-creation time; null for runs recorded before this column existed.';

comment on column public.test_result_items.app_version is
  'B0-472. package.json version of the app that executed this item. Set explicitly by the harness/search-eval executor at insert time; null for items recorded before this column existed.';
