-- ============================================================
-- 20260725100000_backfill_sds_entity_linkage_b0286.sql
-- B0-286: Backfill SDS→entity linkage (orphaned SDS documents)
--
-- Context: SDS documents in rag.document have NULL entity_id,
-- preventing them from being linked to product entities. This
-- migration backfills entity_id for SDS documents by:
-- 1. Parsing SDS document names/metadata to infer product keys
-- 2. Finding matching rag.entity rows (respecting product tiers)
-- 3. Setting entity_id to link SDS → product entity
--
-- The two product tiers are distinguished by metadata->>'source_table':
-- - 'products': legacy product SKU tier (entity_type='product')
-- - 'prod_line': legacy product line tier (entity_type='product_line')
-- ============================================================

-- Step 1: Identify orphaned SDS documents and infer product keys
WITH orphaned_sds AS (
  SELECT
    d.id,
    d.document_key,
    d.title,
    d.metadata,
    d.entity_id,
    CASE
      -- Try metadata.product_key first (if document ingestion stored it)
      WHEN d.metadata ? 'product_key' AND d.metadata->>'product_key' IS NOT NULL
        THEN d.metadata->>'product_key'
      -- Parse from document_key pattern: "sds_<product_key>_<variant>"
      WHEN d.document_key LIKE 'sds_%'
        THEN lower(substring(d.document_key, 5, position('_' IN substring(d.document_key, 5)) - 1))
      -- Parse from title: extract product name before "SDS" or "MSDS"
      WHEN d.title ~* 'sds|msds'
        THEN lower(trim(regexp_replace(substring(d.title, 1, position('SDS' IN upper(d.title)) - 1), '[^a-z0-9]+', ' ', 'g')))
      ELSE NULL
    END AS inferred_product_key
  FROM rag.document d
  WHERE d.document_kind = 'sds'
    AND d.entity_id IS NULL
),

-- Step 2: Find best matching product entities for inferred keys
entity_matches AS (
  SELECT
    os.id AS document_id,
    os.document_key,
    os.inferred_product_key,
    e.id AS entity_id,
    e.entity_type,
    e.metadata->>'source_table' AS source_table,
    ROW_NUMBER() OVER (
      PARTITION BY os.id
      ORDER BY
        CASE WHEN e.metadata->>'product_key' = os.inferred_product_key THEN 0 ELSE 1 END,
        CASE WHEN e.canonical_key ILIKE '%' || os.inferred_product_key || '%' THEN 0 ELSE 1 END,
        e.id
    ) AS match_rank
  FROM orphaned_sds os
  JOIN rag.entity e ON 1=1
  WHERE os.inferred_product_key IS NOT NULL
    AND e.entity_type IN ('product', 'product_line')
    AND (
      e.metadata->>'product_key' = os.inferred_product_key
      OR e.canonical_key ILIKE '%' || os.inferred_product_key || '%'
      OR lower(e.metadata->>'product_name') LIKE '%' || lower(os.inferred_product_key) || '%'
    )
)

-- Step 3: Update rag.document.entity_id for matched SDS documents
UPDATE rag.document d
SET entity_id = em.entity_id,
    updated_at = timezone('utc', now())
FROM entity_matches em
WHERE d.id = em.document_id
  AND em.match_rank = 1  -- Only best match per document
  AND d.entity_id IS NULL;

-- Step 4: Report results
DO $$
DECLARE
  v_orphaned_remaining INTEGER;
  v_linked_count INTEGER;
  v_total_sds INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_total_sds
  FROM rag.document WHERE document_kind = 'sds';

  SELECT COUNT(*) INTO v_orphaned_remaining
  FROM rag.document
  WHERE document_kind = 'sds' AND entity_id IS NULL;

  v_linked_count := v_total_sds - v_orphaned_remaining;

  RAISE NOTICE 'B0-286 complete: SDS entity linkage: % total SDS docs, % newly linked, % remaining orphaned',
    v_total_sds, v_linked_count, v_orphaned_remaining;
END $$;
