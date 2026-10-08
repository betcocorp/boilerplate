-- Retire the objects that three July migrations declared but that never reached the live database
-- (none of 20260725100000 / 101000 / 102000 is in supabase_migrations.schema_migrations):
--   B0-256 rag.label, rag.label_chunk, rag.update_label_updated_at()
--   B0-258 rag.betco_active_products_for_labels
--   B0-283 rag.out_of_scope_documents, rag.document.corpus_scope
--
-- Verified 2026-10-07: none of them exists live and no application code reads them. Labels live in
-- rag.document (document_kind = 'label'), and the B0-283 out-of-scope SDS purge was carried out
-- without the corpus_scope column (see 20260813120000_restore_efficacy_lifecycle_guard_b0444.sql).
-- Applying the original files now would create an empty duplicate label store, so they are retired
-- instead. Every statement is IF EXISTS, so this is a no-op live; it records the decision so
-- `pnpm check:schema-drift` reports these as retired rather than as baselined unapplied debt.
--
-- One statement per object: the schema-drift checker parses a single object per DROP clause.

DROP VIEW IF EXISTS rag.betco_active_products_for_labels;
DROP VIEW IF EXISTS rag.out_of_scope_documents;
DROP TABLE IF EXISTS rag.label_chunk;
DROP TABLE IF EXISTS rag.label;
DROP FUNCTION IF EXISTS rag.update_label_updated_at();
ALTER TABLE IF EXISTS rag.document DROP COLUMN IF EXISTS corpus_scope;
