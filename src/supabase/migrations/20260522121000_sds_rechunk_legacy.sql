-- ============================================================
-- 20260522121000_sds_rechunk_legacy.sql
--
-- Upgrades sync_sds_chunks to match the robustness of the PLP
-- sync function:
--
--   1. Adds staleness detection: picks up docs where chunks are
--      older than the document (not just docs with zero chunks).
--      This handles the 1,523 documents still carrying old
--      char-window chunks created by the external PDF pipeline.
--
--   2. Adds stale-chunk deletion: removes chunks whose keys are
--      no longer produced for a document being re-chunked,
--      preventing orphaned old chunks alongside new ones.
--
--   3. Adds strategy + overlap_chars to chunk metadata so the
--      chunk generation method is always recorded.
--
-- After the function update, all SDS documents that still carry
-- char-window chunks are touched (updated_at = now()) so the
-- new staleness detection picks them up on the next sync run.
-- ============================================================


CREATE OR REPLACE FUNCTION rag.sync_sds_chunks(
  p_language_code text    DEFAULT 'EN',
  p_max_chars     integer DEFAULT 1600,
  p_overlap_chars integer DEFAULT 150
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rag, public
AS $$
DECLARE
  v_language_code  text    := upper(coalesce(nullif(trim(p_language_code), ''), 'EN'));
  v_document_limit integer := 100;

  v_documents_processed          integer := 0;
  v_active_documents_processed   integer := 0;
  v_inactive_documents_processed integer := 0;
  v_chunk_count                  integer := 0;
  v_stale_chunk_count            integer := 0;
  v_inactive_chunk_count         integer := 0;
  v_remaining_docs               integer := 0;
BEGIN
  -- ── Step 1: Candidate selection ───────────────────────────────────────────
  --
  -- A document needs (re-)chunking if:
  --   a. It is active with chunkable text and has NO existing chunks, OR
  --   b. It is active and its chunks are STALE (chunk updated_at < doc updated_at).
  --      This catches docs whose chunks were created by an older pipeline pass.
  -- An inactive document needs its chunks purged if any exist.

  DROP TABLE IF EXISTS pg_temp.rag_sds_sync_candidates;

  CREATE TEMPORARY TABLE rag_sds_sync_candidates
  ON COMMIT DROP AS
  WITH document_state AS (
    SELECT
      d.id            AS document_id,
      d.document_key,
      d.title,
      d.language_code,
      d.body_text,
      coalesce(d.metadata, '{}'::jsonb) AS metadata,
      sr.is_active,
      d.updated_at    AS document_updated_at,
      count(dc.id)::integer         AS existing_chunk_count,
      max(dc.updated_at)            AS latest_chunk_updated_at,
      nullif(trim(d.body_text), '') IS NOT NULL AS has_chunkable_text
    FROM rag.document d
    JOIN rag.source_record sr
      ON sr.id = d.source_record_id
    LEFT JOIN rag.document_chunk dc
      ON dc.document_id = d.id
    WHERE d.document_kind = 'sds'
      AND upper(d.language_code) = v_language_code
    GROUP BY d.id, d.document_key, d.title, d.language_code, d.body_text, d.metadata, sr.is_active, d.updated_at
  )
  SELECT *
  FROM document_state ds
  WHERE
    (
      ds.is_active
      AND ds.has_chunkable_text
      AND (
        ds.existing_chunk_count = 0
        OR ds.latest_chunk_updated_at IS NULL
        OR ds.latest_chunk_updated_at < ds.document_updated_at
      )
    )
    OR (NOT ds.is_active AND ds.existing_chunk_count > 0)
  ORDER BY
    coalesce(ds.latest_chunk_updated_at, '-infinity'::timestamptz),
    ds.document_updated_at,
    ds.document_id
  LIMIT v_document_limit;

  SELECT
    count(*),
    count(*) FILTER (WHERE is_active),
    count(*) FILTER (WHERE NOT is_active)
  INTO
    v_documents_processed,
    v_active_documents_processed,
    v_inactive_documents_processed
  FROM rag_sds_sync_candidates;

  -- ── Step 2: Generate new chunks ───────────────────────────────────────────

  DROP TABLE IF EXISTS pg_temp.rag_sds_new_chunks;

  CREATE TEMPORARY TABLE rag_sds_new_chunks
  ON COMMIT DROP AS
  SELECT
    c.document_id,
    concat(c.document_key, ':chunk:', ch.chunk_index) AS chunk_key,
    ch.chunk_index,
    ch.heading,
    ch.section_path,
    ch.chunk_text,
    ch.token_count,
    c.metadata || jsonb_strip_nulls(
      jsonb_build_object(
        'document_kind',   'sds',
        'language_code',   c.language_code,
        'chunk_index',     ch.chunk_index,
        'section_heading', ch.heading,
        'strategy',        'sds-section-aware',
        'overlap_chars',   p_overlap_chars
      )
    ) AS chunk_metadata
  FROM rag_sds_sync_candidates c
  CROSS JOIN LATERAL rag.chunk_sds_document_text(
    c.body_text,
    p_max_chars,
    p_overlap_chars
  ) ch
  WHERE c.is_active = true
    AND c.has_chunkable_text = true;

  -- ── Step 3: Delete stale chunks BEFORE upsert ────────────────────────────
  --
  -- Must happen before the upsert: old chunks from the external PDF pipeline
  -- have a different chunk_key format, so ON CONFLICT (chunk_key) won't fire,
  -- but (document_id, chunk_index) uniqueness would be violated.

  DELETE FROM rag.document_chunk dc
  WHERE EXISTS (
    SELECT 1 FROM rag_sds_sync_candidates c
    WHERE c.document_id = dc.document_id AND c.is_active = true
  )
  AND NOT EXISTS (
    SELECT 1 FROM rag_sds_new_chunks nc
    WHERE nc.document_id = dc.document_id AND nc.chunk_key = dc.chunk_key
  );

  GET DIAGNOSTICS v_stale_chunk_count = ROW_COUNT;

  -- ── Step 4: Upsert new chunks ─────────────────────────────────────────────

  WITH upserted AS (
    INSERT INTO rag.document_chunk (
      chunk_key, document_id, chunk_index, section_path,
      heading, chunk_text, token_count, metadata
    )
    SELECT
      nc.chunk_key, nc.document_id, nc.chunk_index, nc.section_path,
      nc.heading, nc.chunk_text, nc.token_count, nc.chunk_metadata
    FROM rag_sds_new_chunks nc
    ON CONFLICT (chunk_key) DO UPDATE
      SET
        document_id   = excluded.document_id,
        chunk_index   = excluded.chunk_index,
        section_path  = excluded.section_path,
        heading       = excluded.heading,
        chunk_text    = excluded.chunk_text,
        token_count   = excluded.token_count,
        embedding_model = CASE
          WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
            OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text
            THEN NULL ELSE rag.document_chunk.embedding_model END,
        embedding = CASE
          WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
            OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text
            THEN NULL ELSE rag.document_chunk.embedding END,
        embedding_model_large = CASE
          WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
            OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text
            THEN NULL ELSE rag.document_chunk.embedding_model_large END,
        embedding_large = CASE
          WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
            OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text
            THEN NULL ELSE rag.document_chunk.embedding_large END,
        metadata = excluded.metadata
    RETURNING 1
  )
  SELECT count(*) INTO v_chunk_count FROM upserted;

  -- ── Step 5: Purge chunks for inactive documents ───────────────────────────

  DELETE FROM rag.document_chunk dc
  USING rag_sds_sync_candidates c
  WHERE c.document_id = dc.document_id AND c.is_active = false;

  GET DIAGNOSTICS v_inactive_chunk_count = ROW_COUNT;

  -- ── Step 6: Remaining work count ─────────────────────────────────────────

  WITH document_state AS (
    SELECT
      d.id AS document_id,
      sr.is_active,
      d.updated_at AS document_updated_at,
      count(dc.id)::integer   AS existing_chunk_count,
      max(dc.updated_at)      AS latest_chunk_updated_at,
      nullif(trim(d.body_text), '') IS NOT NULL AS has_chunkable_text
    FROM rag.document d
    JOIN rag.source_record sr ON sr.id = d.source_record_id
    LEFT JOIN rag.document_chunk dc ON dc.document_id = d.id
    WHERE d.document_kind = 'sds'
      AND upper(d.language_code) = v_language_code
    GROUP BY d.id, sr.is_active, d.updated_at, d.body_text
  )
  SELECT count(*) INTO v_remaining_docs
  FROM document_state ds
  WHERE
    (
      ds.is_active
      AND ds.has_chunkable_text
      AND (
        ds.existing_chunk_count = 0
        OR ds.latest_chunk_updated_at IS NULL
        OR ds.latest_chunk_updated_at < ds.document_updated_at
      )
    )
    OR (NOT ds.is_active AND ds.existing_chunk_count > 0);

  RETURN jsonb_build_object(
    'language_code',                v_language_code,
    'batch_limit',                  v_document_limit,
    'documents_processed',          v_documents_processed,
    'active_documents_processed',   v_active_documents_processed,
    'inactive_documents_processed', v_inactive_documents_processed,
    'chunks_upserted',              v_chunk_count,
    'stale_chunks_deleted',         v_stale_chunk_count,
    'inactive_chunks_deleted',      v_inactive_chunk_count,
    'remaining_documents',          v_remaining_docs,
    'has_more',                     v_remaining_docs > 0,
    'chunking_config', jsonb_build_object(
      'strategy',      'sds-section-aware',
      'max_chars',     p_max_chars,
      'overlap_chars', p_overlap_chars
    )
  );
END;
$$;

COMMENT ON FUNCTION rag.sync_sds_chunks(text, integer, integer) IS
  'Syncs SDS chunks using section-aware splitting. Detects stale docs (chunk updated_at < doc updated_at) in addition to zero-chunk docs. Stale chunks are deleted when keys shift. Call in a loop until has_more = false.';

GRANT EXECUTE ON FUNCTION rag.sync_sds_chunks(text, integer, integer) TO service_role;


-- Touch all SDS documents that still carry char-window chunks so the
-- updated staleness detection above picks them up for re-chunking.
UPDATE rag.document d
SET updated_at = now()
WHERE d.document_kind = 'sds'
  AND EXISTS (
    SELECT 1 FROM rag.document_chunk dc
    WHERE dc.document_id = d.id
      AND dc.metadata->>'strategy' = 'char-window'
  );
