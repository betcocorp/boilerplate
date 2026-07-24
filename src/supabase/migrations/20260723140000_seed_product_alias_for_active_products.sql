-- Add SKU / InvtID aliases for active products to rag.product_alias (B0-248, depends on B0-246).
-- Idempotent: relies on the existing unique(alias_norm) constraint; within this insert's own
-- candidate set, rows are deduped up front so a single statement never targets the same
-- alias_norm twice.
--
-- Collision handling against pre-existing rows: 243 of this backfill's SKU alias_norm values
-- already exist, seeded by an unrelated, separate prior effort (source = 'backfill_sku_20260721',
-- master-product-grain entities, e.g. one "Kling" entity aliasing all of its pack-size SKUs --
-- a different tier than the per-SKU-variant rag.entity rows from B0-246). Of those 243, 229
-- already carry the correct product_line_key (harmless overlap -- resolveProductLineKeyByName()
-- in src/lib/rag/entity-context.ts only ever reads product_alias.product_line_key, never
-- entity_id, so a different entity_id there doesn't affect that live resolution path). The other
-- 14 carry a WRONG product_line_key today -- a pre-existing bug in that live resolver for those
-- 14 SKUs. This migration corrects product_line_key ONLY where it's actually wrong, and only
-- that column -- entity_id, alias, and source on any pre-existing row are left untouched, so this
-- doesn't take a position on or disturb the other process's entity linkage.
--
-- Per product, up to 3 candidate aliases:
--   1. SKU, standard-normalized (lower, (R)/(TM) stripped, whitespace collapsed to a single space)
--   2. InvtID, standard-normalized (same rule -- keeps one embedded space, e.g. "F000795C4 0000BE1200"
--      -> "f000795c4 0000be1200")
--   3. InvtID, space-stripped (all whitespace removed -- "f000795c40000be1200") so a query that
--      drops the embedded space still resolves.
-- product_line_key is NOT NULL on rag.product_alias; populated from the product entity's own
-- product_line_key (set by B0-246), which is guaranteed non-null for these rows.

with active_product_entities as (
  select e.id as entity_id, e.product_line_key, e.product_key
  from rag.entity e
  where e.entity_type = 'product'
    and e.metadata->>'source_table' = 'products'
    and e.metadata->>'source_schema' = 'legacy'
),
source_values as (
  select
    ape.entity_id,
    ape.product_line_key,
    p."SKU" as sku,
    p."InvtID" as invt_id
  from active_product_entities ape
  join legacy.products p on p."ProductsKey" = ape.product_key
),
candidates as (
  select
    entity_id,
    product_line_key,
    trim(sku) as alias,
    trim(lower(regexp_replace(regexp_replace(sku, '[®™]', '', 'g'), '\s+', ' ', 'g'))) as alias_norm,
    'legacy-product' as source
  from source_values
  where nullif(trim(sku), '') is not null

  union all

  select
    entity_id,
    product_line_key,
    trim(invt_id) as alias,
    trim(lower(regexp_replace(regexp_replace(invt_id, '[®™]', '', 'g'), '\s+', ' ', 'g'))) as alias_norm,
    'legacy-product' as source
  from source_values
  where nullif(trim(invt_id), '') is not null

  union all

  select
    entity_id,
    product_line_key,
    trim(invt_id) as alias,
    regexp_replace(lower(regexp_replace(invt_id, '[®™]', '', 'g')), '\s+', '', 'g') as alias_norm,
    'legacy-product' as source
  from source_values
  where nullif(trim(invt_id), '') is not null
),
deduped as (
  select distinct on (alias_norm)
    entity_id, product_line_key, alias, alias_norm, source
  from candidates
  where alias_norm <> ''
  order by alias_norm, entity_id
)
insert into rag.product_alias (alias_norm, alias, entity_id, product_line_key, source, confidence)
select alias_norm, alias, entity_id, product_line_key, source, 1.0
from deduped
on conflict (alias_norm) do update
  set product_line_key = excluded.product_line_key
  where rag.product_alias.product_line_key is distinct from excluded.product_line_key;
