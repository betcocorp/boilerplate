-- B0-218 — Retire the dead 1536-dim embedding columns (unblocks B0-203 item 1). APPLIED to prod 2026-07-15.
-- Step 1: CREATE OR REPLACE rag.sync_sds_chunks so its ON CONFLICT block only invalidates the
--   live large columns (embedding_large / embedding_model_large) and no longer writes the dead
--   embedding / embedding_model columns.
-- Step 2: drop the old HNSW index, then drop the two dead columns (0 / 27,620 populated).
-- Verified post-apply: dead columns gone; embedding_large present on 100% of chunks; function clean.
-- NOTE: run `pnpm run types:supabase:rag` to drop embedding/embedding_model from types/supabase.rag.ts.

-- (Full CREATE OR REPLACE FUNCTION body applied in the Supabase migration of the same name;
--  reproduced here for the repo record.)
CREATE OR REPLACE FUNCTION rag.sync_sds_chunks(p_language_code text DEFAULT 'EN'::text, p_max_chars integer DEFAULT 1600, p_overlap_chars integer DEFAULT 150)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'rag', 'public'
AS $function$
DECLARE
  v_language_code  text    := upper(coalesce(nullif(trim(p_language_code), ''), 'EN'));
  v_document_limit integer := 100;
  v_documents_processed          integer := 0;
  v_active_documents_processed   integer := 0;
  v_inactive_documents_processed integer := 0;
  v_chunk_count                  integer := 0;
  v_inactive_chunk_count         integer := 0;
  v_remaining_docs               integer := 0;
BEGIN
  DROP TABLE IF EXISTS pg_temp.rag_sds_sync_candidates;
  CREATE TEMPORARY TABLE rag_sds_sync_candidates ON COMMIT DROP AS
  WITH document_state AS (
    SELECT d.id AS document_id, d.document_key, d.title, d.language_code, d.body_text,
      coalesce(d.metadata, '{}'::jsonb) AS metadata, sr.is_active, d.updated_at AS document_updated_at,
      count(dc.id)::integer AS existing_chunk_count,
      nullif(trim(d.body_text), '') IS NOT NULL AS has_chunkable_text
    FROM rag.document d
    JOIN rag.source_record sr ON sr.id = d.source_record_id
    LEFT JOIN rag.document_chunk dc ON dc.document_id = d.id
    WHERE d.document_kind = 'sds' AND upper(d.language_code) = v_language_code
    GROUP BY d.id, d.document_key, d.title, d.language_code, d.body_text, d.metadata, sr.is_active, d.updated_at
  )
  SELECT * FROM document_state ds
  WHERE (ds.is_active AND ds.has_chunkable_text AND ds.existing_chunk_count = 0)
     OR (NOT ds.is_active AND ds.existing_chunk_count > 0)
  ORDER BY ds.document_updated_at, ds.document_id
  LIMIT v_document_limit;

  SELECT count(*), count(*) FILTER (WHERE is_active), count(*) FILTER (WHERE NOT is_active)
  INTO v_documents_processed, v_active_documents_processed, v_inactive_documents_processed
  FROM rag_sds_sync_candidates;

  DROP TABLE IF EXISTS pg_temp.rag_sds_new_chunks;
  CREATE TEMPORARY TABLE rag_sds_new_chunks ON COMMIT DROP AS
  SELECT c.document_id, concat(c.document_key, ':chunk:', ch.chunk_index) AS chunk_key,
    ch.chunk_index, ch.heading, ch.section_path, ch.chunk_text, ch.token_count,
    c.metadata || jsonb_strip_nulls(jsonb_build_object(
      'document_kind','sds','language_code',c.language_code,'chunk_index',ch.chunk_index,'section_heading',ch.heading
    )) AS chunk_metadata
  FROM rag_sds_sync_candidates c
  CROSS JOIN LATERAL rag.chunk_sds_document_text(c.body_text, p_max_chars, p_overlap_chars, c.title) ch
  WHERE c.is_active = true AND c.has_chunkable_text = true;

  WITH upserted AS (
    INSERT INTO rag.document_chunk (chunk_key, document_id, chunk_index, section_path, heading, chunk_text, token_count, metadata)
    SELECT nc.chunk_key, nc.document_id, nc.chunk_index, nc.section_path, nc.heading, nc.chunk_text, nc.token_count, nc.chunk_metadata
    FROM rag_sds_new_chunks nc
    ON CONFLICT (chunk_key) DO UPDATE SET
      document_id = excluded.document_id, chunk_index = excluded.chunk_index, section_path = excluded.section_path,
      heading = excluded.heading, chunk_text = excluded.chunk_text, token_count = excluded.token_count,
      embedding_model_large = CASE WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
        OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text THEN NULL ELSE rag.document_chunk.embedding_model_large END,
      embedding_large = CASE WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
        OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text THEN NULL ELSE rag.document_chunk.embedding_large END,
      metadata = excluded.metadata
    RETURNING 1
  )
  SELECT count(*) INTO v_chunk_count FROM upserted;

  DELETE FROM rag.document_chunk dc USING rag_sds_sync_candidates c
  WHERE c.document_id = dc.document_id AND c.is_active = false;
  GET DIAGNOSTICS v_inactive_chunk_count = ROW_COUNT;

  SELECT count(*) INTO v_remaining_docs
  FROM rag.document d JOIN rag.source_record sr ON sr.id = d.source_record_id
  WHERE d.document_kind = 'sds' AND upper(d.language_code) = v_language_code AND sr.is_active = true
    AND nullif(trim(d.body_text), '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM rag.document_chunk dc WHERE dc.document_id = d.id);

  RETURN jsonb_build_object(
    'language_code', v_language_code, 'batch_limit', v_document_limit,
    'documents_processed', v_documents_processed, 'active_documents_processed', v_active_documents_processed,
    'inactive_documents_processed', v_inactive_documents_processed, 'chunks_upserted', v_chunk_count,
    'inactive_chunks_deleted', v_inactive_chunk_count, 'remaining_documents', v_remaining_docs,
    'has_more', v_remaining_docs > 0,
    'chunking_config', jsonb_build_object('strategy','sds-section-aware','max_chars',p_max_chars,'overlap_chars',p_overlap_chars)
  );
END;
$function$;

DROP INDEX IF EXISTS rag.document_chunk_embedding_hnsw_idx;

ALTER TABLE rag.document_chunk
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_model;
