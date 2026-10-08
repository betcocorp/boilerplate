-- Drop the six one-off backup tables left behind by the 2026-09-03 eval purge (B0-826) and the
-- 2026-09-11 concept split (B0-953). None was ever created by a checked-in migration, so
-- `pnpm check:schema-drift` reported each as rel-missing; B0-895 only enabled RLS on them.
--
-- Verified live 2026-10-07 before dropping: no dependent views, no inbound or outbound foreign keys,
-- and no application code reads them (the only repo reference is the B0-895 RLS loop, which skips
-- tables that no longer exist via its to_regclass guard).
--
-- One statement per table: the schema-drift checker parses a single relation per DROP clause.

DROP TABLE IF EXISTS public.test_items_concepts_backup_b0953_20260911;
DROP TABLE IF EXISTS public.test_items_purged_20260903;
DROP TABLE IF EXISTS public.test_result_comparisons_purged_20260903;
DROP TABLE IF EXISTS public.test_result_items_purged_20260903;
DROP TABLE IF EXISTS public.test_results_purged_20260903;
DROP TABLE IF EXISTS public.tests_purged_20260903;
