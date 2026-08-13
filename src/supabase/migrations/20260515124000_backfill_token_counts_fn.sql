-- Batch-backfills token_count for document_chunk rows where it is NULL.
--
-- Disables the updated_at trigger during the UPDATE so PostgreSQL can use
-- HOT (Heap-Only Tuple) updates — token_count is unindexed, so no index
-- entries change, and skipping the updated_at write avoids breaking HOT.
-- The trigger is always re-enabled before the function returns.
--
-- Call via the /api/rag/backfill/token-counts route (loops until hasMore=false).

CREATE OR REPLACE FUNCTION rag.backfill_token_counts_batch(p_batch_size int DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rag, public
SET statement_timeout = '250s'
AS $$
DECLARE
  v_updated  integer;
  v_remaining integer;
BEGIN
  ALTER TABLE rag.document_chunk DISABLE TRIGGER set_document_chunk_updated_at;

  UPDATE rag.document_chunk
  SET token_count = ceil(greatest(length(chunk_text), 1) / 4.0)::integer
  WHERE id IN (
    SELECT id FROM rag.document_chunk WHERE token_count IS NULL LIMIT p_batch_size
  );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  ALTER TABLE rag.document_chunk ENABLE TRIGGER set_document_chunk_updated_at;

  SELECT count(*) INTO v_remaining FROM rag.document_chunk WHERE token_count IS NULL;

  RETURN jsonb_build_object(
    'chunksUpdated',   v_updated,
    'remainingChunks', v_remaining,
    'hasMore',         v_remaining > 0
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rag.backfill_token_counts_batch(int) TO service_role;

COMMENT ON FUNCTION rag.backfill_token_counts_batch IS
  'Backfills token_count = ceil(length(chunk_text)/4) for NULL rows in batches. Safe to call repeatedly.';
