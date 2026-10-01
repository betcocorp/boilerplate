-- B0-878 — Tom's call: rag.product_alias is being reset to hold ONLY corpus-grounded
-- acronym/synonym/common-name aliases (mined from literal chunk text via
-- scripts/mine-corpus-alias-candidates.mjs, B0-484), dropping the deterministic
-- SKU/InvtID/prod_line_id/title seeding from B0-200/B0-248/B0-481.
--
-- Known consequence (explicitly accepted): resolveProductEntityByName /
-- resolveProductLineKeyByName (~/lib/rag/entity-context.ts) lose all 22,638 verified rows
-- they use for exact-match resolution today. Backed up here, not dropped, in case that
-- needs restoring.
create table if not exists rag.product_alias_backup_20260906 as
table rag.product_alias;

truncate table rag.product_alias;
