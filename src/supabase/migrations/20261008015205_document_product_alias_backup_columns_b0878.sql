-- rag.product_alias_backup_20260906 was created by 20260906232414_reset_product_alias_b0878.sql as
-- `CREATE TABLE … AS TABLE rag.product_alias`, so no checked-in migration names its columns and
-- `pnpm check:schema-drift` reports each one as col-missing.
--
-- The table is kept on purpose: it holds the 22,697 alias rows (incl. the verified exact-match rows
-- resolveProductEntityByName relied on) that B0-878 truncated from rag.product_alias, retained in
-- case they need restoring. This migration only records its shape; it changes no data or columns.

COMMENT ON TABLE rag.product_alias_backup_20260906 IS
  'B0-878 backup of rag.product_alias taken 2026-09-06 before the corpus-only alias reset. Restore source only; not read by the app.';

COMMENT ON COLUMN rag.product_alias_backup_20260906.id IS 'Copied from rag.product_alias.id.';
COMMENT ON COLUMN rag.product_alias_backup_20260906.entity_id IS 'Copied from rag.product_alias.entity_id.';
COMMENT ON COLUMN rag.product_alias_backup_20260906.product_line_key IS 'Copied from rag.product_alias.product_line_key.';
COMMENT ON COLUMN rag.product_alias_backup_20260906.alias_norm IS 'Copied from rag.product_alias.alias_norm.';
COMMENT ON COLUMN rag.product_alias_backup_20260906.alias_type IS 'Copied from rag.product_alias.alias_type.';
COMMENT ON COLUMN rag.product_alias_backup_20260906.source IS 'Copied from rag.product_alias.source.';
COMMENT ON COLUMN rag.product_alias_backup_20260906.confidence IS 'Copied from rag.product_alias.confidence.';
COMMENT ON COLUMN rag.product_alias_backup_20260906.reviewed_by IS 'Copied from rag.product_alias.reviewed_by.';
COMMENT ON COLUMN rag.product_alias_backup_20260906.reviewed_at IS 'Copied from rag.product_alias.reviewed_at.';
COMMENT ON COLUMN rag.product_alias_backup_20260906.created_at IS 'Copied from rag.product_alias.created_at.';
