-- Backfill token_count for SDS document chunks.
-- The SDS ingestion pipeline never populated this column, leaving all 44k+ SDS chunks
-- with NULL token_count. The pipeline's context-budgeting logic relies on this field.
-- Estimate: 1 token ≈ 4 characters (standard GPT/embedding approximation).
--
-- Implemented as a procedure with per-batch commits because a single 44k-row UPDATE
-- exceeds the Supabase MCP statement timeout. Call from the SQL editor or CLI:
--   CALL rag.backfill_sds_token_counts();

CREATE OR REPLACE PROCEDURE rag.backfill_sds_token_counts(p_batch_size int default 500)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rag, public
AS $$
DECLARE
  v_rows int;
  v_total int := 0;
BEGIN
  LOOP
    UPDATE rag.document_chunk
    SET token_count = ceil(greatest(length(chunk_text), 1) / 4.0)::integer
    WHERE token_count IS NULL
      AND ctid = ANY(ARRAY(
        SELECT ctid FROM rag.document_chunk
        WHERE token_count IS NULL
        LIMIT p_batch_size
      ));
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;
    COMMIT;
    EXIT WHEN v_rows = 0;
  END LOOP;
  RAISE NOTICE 'backfill_sds_token_counts: updated % rows total', v_total;
END;
$$;

GRANT EXECUTE ON PROCEDURE rag.backfill_sds_token_counts(int) TO service_role;

COMMENT ON PROCEDURE rag.backfill_sds_token_counts IS
  'Backfills token_count for chunks where it is NULL (SDS corpus). Commits every p_batch_size rows. Safe to call repeatedly; exits when nothing remains.';
