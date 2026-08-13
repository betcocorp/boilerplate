-- Enrich existing SDS chunks with section headings and structured section_path.
--
-- SDS body_text is extracted from PDFs and split at page breaks (\n\n). Sections
-- frequently start mid-page, so section headers appear inline in chunk_text rather
-- than at the start. This pass scans each chunk for the first GHS/SDS section header
-- it contains and uses that to populate heading and section_path.
--
-- Supported patterns (all languages present in the corpus):
--   English : "Section N. Name" or "Section N: Name"
--   Spanish : "Sección N. Name" / "Seccion N. Name"
--   French  : "Section N. Nom"  (same pattern as English)
--
-- Implemented as a procedure with per-batch commits because a single 44k-row UPDATE
-- exceeds the Supabase MCP statement timeout. Call from the SQL editor or CLI:
--   CALL rag.enrich_sds_section_headings();

CREATE OR REPLACE PROCEDURE rag.enrich_sds_section_headings(p_batch_size int default 500)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rag, public
AS $$
DECLARE
  v_rows int;
  v_total int := 0;
BEGIN
  LOOP
    WITH candidates AS (
      SELECT dc.id
      FROM rag.document_chunk dc
      JOIN rag.document d ON d.id = dc.document_id
      WHERE d.document_kind = 'sds'
        AND (dc.heading IS NULL OR dc.heading = 'SDS content')
      LIMIT p_batch_size
    ),
    extracted AS (
      SELECT
        dc.id,
        regexp_match(
          dc.chunk_text,
          E'(?:Section|Secci[oó]n|SECTION)\\s+(\\d{1,2})[.:]\\s+([^\\n.]{3,80})',
          'i'
        ) AS section_match
      FROM rag.document_chunk dc
      WHERE dc.id IN (SELECT id FROM candidates)
    )
    UPDATE rag.document_chunk dc
    SET
      heading      = concat('Section ', e.section_match[1], '. ', trim(e.section_match[2])),
      section_path = ARRAY['sds', concat('section_', e.section_match[1])]::text[]
    FROM extracted e
    WHERE dc.id = e.id
      AND e.section_match IS NOT NULL;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;
    COMMIT;

    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM rag.document_chunk dc
      JOIN rag.document d ON d.id = dc.document_id
      WHERE d.document_kind = 'sds'
        AND (dc.heading IS NULL OR dc.heading = 'SDS content')
      LIMIT 1
    );
  END LOOP;
  RAISE NOTICE 'enrich_sds_section_headings: enriched % chunks', v_total;
END;
$$;

GRANT EXECUTE ON PROCEDURE rag.enrich_sds_section_headings(int) TO service_role;

COMMENT ON PROCEDURE rag.enrich_sds_section_headings IS
  'Scans SDS chunks for GHS/SDS section header patterns and populates heading + section_path. Commits every p_batch_size rows. Safe to call repeatedly.';
