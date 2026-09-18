-- B0-1055: normalized identity columns for rag.cross_reference_recommendations, so duplicate
-- (competitor_brand, competitor_product) rows created by re-run golden-set prompts can be detected
-- and deduped. Generated + stored so they backfill automatically and stay derived, never
-- independently writable. The partial unique index that enforces this identity is added in a
-- follow-up migration (cross_reference_recommendations_dedupe_index), AFTER the one-time data
-- cleanup (cross_reference_recommendations_dedupe_data) — creating the index before cleanup would
-- fail immediately: 470 of 472 existing rows are not yet reviewed, and duplicate identities already
-- exist among them (e.g. bnc/bnc-15 x53).
alter table rag.cross_reference_recommendations
  add column competitor_brand_norm text generated always as (lower(trim(coalesce(competitor_brand, '')))) stored,
  add column competitor_product_norm text generated always as (lower(trim(competitor_product))) stored;
