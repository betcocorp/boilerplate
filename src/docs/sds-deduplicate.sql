-- SDS duplicate cleanup for rag schema
-- Purpose: keep one canonical SDS document per source file and remove duplicate copies.
--
-- Run this in Supabase SQL editor against the target project.
-- Recommended flow:
--   1) Run the PREVIEW query first.
--   2) Review rows that would be removed.
--   3) Run the APPLY transaction.

/* -------------------------------------------------------------------------- */
/* PREVIEW                                                                     */
/* -------------------------------------------------------------------------- */
WITH sds_docs AS (
  SELECT
    d.id AS document_id,
    d.source_record_id,
    d.document_key,
    d.title,
    d.updated_at,
    d.created_at,
    COALESCE(chunk_counts.chunk_count, 0) AS chunk_count,
    sr.source_pk,
    sr.source_uri,
    sr.metadata,
    COALESCE(
      NULLIF(LOWER(sr.metadata::jsonb #>> '{ingestion,s3_key}'), ''),
      NULLIF(LOWER(sr.metadata::jsonb #>> '{ingestion,local_path}'), ''),
      NULLIF(LOWER(sr.source_uri), ''),
      LOWER(REGEXP_REPLACE(d.title, '\s+', ' ', 'g'))
    ) AS dedupe_key
  FROM rag.document d
  JOIN rag.source_record sr
    ON sr.id = d.source_record_id
  LEFT JOIN (
    SELECT document_id, COUNT(*)::int AS chunk_count
    FROM rag.document_chunk
    GROUP BY document_id
  ) chunk_counts
    ON chunk_counts.document_id = d.id
  WHERE d.document_kind = 'sds'
    AND sr.source_schema = 'sds'
    AND sr.source_table = 'sheet'
    AND sr.source_type = 's3_pdf'
),
ranked AS (
  SELECT
    sds_docs.*,
    ROW_NUMBER() OVER (
      PARTITION BY dedupe_key
      ORDER BY chunk_count DESC, updated_at DESC, created_at DESC, document_id DESC
    ) AS rn
  FROM sds_docs
)
SELECT
  dedupe_key,
  document_id,
  source_record_id,
  document_key,
  title,
  chunk_count,
  source_pk,
  source_uri,
  CASE WHEN rn = 1 THEN 'KEEP' ELSE 'REMOVE' END AS action
FROM ranked
WHERE dedupe_key IS NOT NULL
ORDER BY dedupe_key, action DESC, chunk_count DESC, updated_at DESC;

/* -------------------------------------------------------------------------- */
/* APPLY                                                                       */
/* -------------------------------------------------------------------------- */
BEGIN;

CREATE TEMP TABLE _sds_ranked_docs ON COMMIT DROP AS
WITH sds_docs AS (
  SELECT
    d.id AS document_id,
    d.source_record_id,
    d.document_key,
    d.title,
    d.updated_at,
    d.created_at,
    COALESCE(chunk_counts.chunk_count, 0) AS chunk_count,
    sr.source_pk,
    sr.source_uri,
    sr.metadata,
    COALESCE(
      NULLIF(LOWER(sr.metadata::jsonb #>> '{ingestion,s3_key}'), ''),
      NULLIF(LOWER(sr.metadata::jsonb #>> '{ingestion,local_path}'), ''),
      NULLIF(LOWER(sr.source_uri), ''),
      LOWER(REGEXP_REPLACE(d.title, '\s+', ' ', 'g'))
    ) AS dedupe_key
  FROM rag.document d
  JOIN rag.source_record sr
    ON sr.id = d.source_record_id
  LEFT JOIN (
    SELECT document_id, COUNT(*)::int AS chunk_count
    FROM rag.document_chunk
    GROUP BY document_id
  ) chunk_counts
    ON chunk_counts.document_id = d.id
  WHERE d.document_kind = 'sds'
    AND sr.source_schema = 'sds'
    AND sr.source_table = 'sheet'
    AND sr.source_type = 's3_pdf'
),
ranked AS (
  SELECT
    sds_docs.*,
    ROW_NUMBER() OVER (
      PARTITION BY dedupe_key
      ORDER BY chunk_count DESC, updated_at DESC, created_at DESC, document_id DESC
    ) AS rn
  FROM sds_docs
  WHERE dedupe_key IS NOT NULL
)
SELECT *
FROM ranked;

CREATE TEMP TABLE _sds_dupe_docs ON COMMIT DROP AS
SELECT *
FROM _sds_ranked_docs
WHERE rn > 1;

-- Remove chunks for duplicate documents.
DELETE FROM rag.document_chunk dc
USING _sds_dupe_docs dup
WHERE dc.document_id = dup.document_id;

-- Remove duplicate documents.
DELETE FROM rag.document d
USING _sds_dupe_docs dup
WHERE d.id = dup.document_id;

-- Deactivate source records that became orphaned after duplicate document removal.
UPDATE rag.source_record sr
SET
  is_active = false,
  last_seen_at = NOW(),
  updated_at = NOW(),
  metadata = (
    jsonb_set(
      jsonb_set(
        COALESCE(sr.metadata::jsonb, '{}'::jsonb),
        '{ingestion,status}',
        '"deduped"'::jsonb,
        true
      ),
      '{ingestion,last_error}',
      'null'::jsonb,
      true
    )
    || jsonb_build_object(
      'dedupe_note',
      'Duplicate SDS source deactivated by sds-deduplicate.sql',
      'dedupe_at',
      NOW()
    )
  )::json
WHERE sr.id IN (SELECT DISTINCT source_record_id FROM _sds_dupe_docs)
  AND NOT EXISTS (
    SELECT 1
    FROM rag.document d
    WHERE d.source_record_id = sr.id
  );

-- Post-run summary.
SELECT
  (SELECT COUNT(*) FROM _sds_dupe_docs) AS duplicate_documents_removed,
  (
    SELECT COUNT(DISTINCT source_record_id)
    FROM _sds_dupe_docs
  ) AS duplicate_source_records_touched;

COMMIT;
