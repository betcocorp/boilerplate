-- ============================================================
-- 20260602121000_sds_chunk_product_name_prefix.sql
--
-- Adds product name to SDS chunk_text for BM25 discrimination.
--
-- Problem:
--   SDS chunks only contained the section heading + body:
--     "Section 8. Personal Protection Equipment\n..."
--   Two different products' Section 8 chunks look identical to
--   BM25 because neither mentions the product name in chunk_text.
--
-- Fix:
--   Prepend "Product: {title}\n" before the section heading
--   for all non-preamble chunks, matching the pattern already
--   used for product_line_profile chunks.
--
--   Result:
--     "Product: Fastlane Drain Opener\nSection 8. ...\n..."
--
-- Two-part approach:
--   Part 1: Backfill — UPDATE existing chunks in-place.
--           Nulls embeddings so the embedding pipeline picks
--           them up automatically. Skips preamble chunks (the
--           preamble text already names the product).
--           Guard: NOT LIKE 'Product:%' makes it idempotent.
--
--   Part 2: Update the chunker function and sync function so
--           future rechunks produce the same prefix.
-- ============================================================


-- ── Part 1: Backfill existing SDS chunks ─────────────────────────────────────

UPDATE rag.document_chunk dc
SET
  chunk_text            = 'Product: ' || d.title || E'\n' || dc.chunk_text,
  token_count           = ceil((length('Product: ' || d.title || E'\n') + length(dc.chunk_text))::float / 4.0)::integer,
  embedding             = NULL,
  embedding_large       = NULL,
  embedding_model       = NULL,
  embedding_model_large = NULL
FROM rag.document d
JOIN rag.source_record sr ON sr.id = d.source_record_id
WHERE d.id             = dc.document_id
  AND d.document_kind  = 'sds'
  AND sr.is_active     = true
  AND upper(coalesce(d.language_code, '')) = 'EN'
  AND nullif(trim(d.title), '') IS NOT NULL
  AND dc.heading       IS DISTINCT FROM 'Preamble'
  AND dc.chunk_text    NOT LIKE 'Product:%';


-- ── Part 2: Update chunk_sds_document_text to accept p_title ─────────────────

CREATE OR REPLACE FUNCTION rag.chunk_sds_document_text(
  p_body_text     text,
  p_max_chars     integer DEFAULT 1600,
  p_overlap_chars integer DEFAULT 150,
  p_title         text    DEFAULT NULL
)
RETURNS TABLE (
  chunk_index  integer,
  heading      text,
  section_path text[],
  chunk_text   text,
  token_count  integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rag, public
AS $$
DECLARE
  v_sentinel     text := E'\x1E';
  v_section_re   constant text := '((?:Section|Secci[oó]n|SECTION)\s+\d{1,2}[.:]\s?)';
  v_title        text := nullif(trim(p_title), '');

  v_sections     text[];
  v_sec_n        integer;
  v_i            integer;
  v_section_text text;
  v_first_line   text;
  v_heading      text;
  v_sec_slug     text;
  v_section_num  text;
  v_body         text;

  v_paragraphs   text[];
  v_para_n       integer;
  v_j            integer;
  v_para         text;
  v_sub_parts    text[]  := '{}';
  v_sub_chars    integer := 0;
  v_prev_text    text    := '';
  v_sub_body     text;
  v_overlap      text;
  v_final_text   text;

  v_chunk_idx    integer := 0;
BEGIN
  IF p_body_text IS NULL OR length(trim(p_body_text)) = 0 THEN
    RETURN;
  END IF;

  v_sections := string_to_array(
    regexp_replace(p_body_text, v_section_re, v_sentinel || '\1', 'gi'),
    v_sentinel
  );

  v_sec_n := coalesce(array_length(v_sections, 1), 0);

  FOR v_i IN 1 .. v_sec_n LOOP
    v_section_text := trim(v_sections[v_i]);
    CONTINUE WHEN v_section_text IS NULL OR length(v_section_text) = 0;

    v_first_line := split_part(v_section_text, E'\n', 1);

    IF v_first_line ~ '(?:Section|Secci[oó]n|SECTION)\s+\d{1,2}' THEN
      v_section_num := coalesce(
        (regexp_match(v_first_line, '(?:Section|Secci[oó]n|SECTION)\s+(\d{1,2})', 'i'))[1],
        v_i::text
      );
      v_heading  := trim(v_first_line);
      v_sec_slug := 'section_' || v_section_num;
      v_body := CASE
        WHEN strpos(v_section_text, E'\n') > 0
          THEN trim(substring(v_section_text FROM strpos(v_section_text, E'\n') + 1))
        ELSE ''
      END;
    ELSE
      v_heading  := 'Preamble';
      v_sec_slug := 'preamble';
      v_body     := v_section_text;
    END IF;

    v_body := trim(v_body);
    CONTINUE WHEN v_body IS NULL OR length(v_body) < 20;

    IF length(v_body) <= p_max_chars THEN
      -- Preamble: no product prefix (preamble text already names the product).
      -- Named sections: prepend "Product: {title}\n{heading}\n" if title is available.
      v_final_text := CASE
        WHEN v_heading = 'Preamble'
          THEN v_body
        WHEN v_title IS NOT NULL
          THEN 'Product: ' || v_title || E'\n' || v_heading || E'\n' || v_body
        ELSE
          v_heading || E'\n' || v_body
      END;

      IF length(v_final_text) >= 60 THEN
        chunk_index  := v_chunk_idx;
        heading      := v_heading;
        section_path := ARRAY['sds', v_sec_slug];
        chunk_text   := v_final_text;
        token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
        RETURN NEXT;
        v_chunk_idx := v_chunk_idx + 1;
      END IF;

    ELSE
      v_paragraphs := regexp_split_to_array(v_body, E'\\n\\s*\\n+');
      v_para_n     := coalesce(array_length(v_paragraphs, 1), 0);
      v_sub_parts  := '{}';
      v_sub_chars  := 0;
      v_prev_text  := '';

      FOR v_j IN 1 .. v_para_n LOOP
        v_para := trim(v_paragraphs[v_j]);
        CONTINUE WHEN v_para = '';

        IF v_sub_chars + length(v_para) > p_max_chars AND v_sub_parts <> '{}' THEN
          v_sub_body := array_to_string(v_sub_parts, E'\n\n');
          v_overlap  := CASE
            WHEN v_prev_text <> '' AND p_overlap_chars > 0
              THEN '[...] ' || right(v_prev_text, p_overlap_chars) || E'\n\n'
            ELSE ''
          END;
          v_final_text := CASE
            WHEN v_heading = 'Preamble'
              THEN v_overlap || v_sub_body
            WHEN v_title IS NOT NULL
              THEN 'Product: ' || v_title || E'\n' || v_heading || E'\n' || v_overlap || v_sub_body
            ELSE
              v_heading || E'\n' || v_overlap || v_sub_body
          END;

          IF length(v_final_text) >= 60 THEN
            chunk_index  := v_chunk_idx;
            heading      := v_heading;
            section_path := ARRAY['sds', v_sec_slug];
            chunk_text   := v_final_text;
            token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
            RETURN NEXT;
            v_chunk_idx := v_chunk_idx + 1;
          END IF;

          v_prev_text := v_sub_body;
          v_sub_parts := ARRAY[v_para];
          v_sub_chars := length(v_para);

        ELSE
          v_sub_parts := v_sub_parts || ARRAY[v_para];
          v_sub_chars := v_sub_chars + length(v_para);
        END IF;
      END LOOP;

      IF v_sub_parts <> '{}' THEN
        v_sub_body := array_to_string(v_sub_parts, E'\n\n');
        v_overlap  := CASE
          WHEN v_prev_text <> '' AND p_overlap_chars > 0
            THEN '[...] ' || right(v_prev_text, p_overlap_chars) || E'\n\n'
          ELSE ''
        END;
        v_final_text := CASE
          WHEN v_heading = 'Preamble'
            THEN v_overlap || v_sub_body
          WHEN v_title IS NOT NULL
            THEN 'Product: ' || v_title || E'\n' || v_heading || E'\n' || v_overlap || v_sub_body
          ELSE
            v_heading || E'\n' || v_overlap || v_sub_body
        END;

        IF length(v_final_text) >= 60 THEN
          chunk_index  := v_chunk_idx;
          heading      := v_heading;
          section_path := ARRAY['sds', v_sec_slug];
          chunk_text   := v_final_text;
          token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
          RETURN NEXT;
          v_chunk_idx := v_chunk_idx + 1;
        END IF;
      END IF;

    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION rag.chunk_sds_document_text(text, integer, integer, text) IS
  'Splits an SDS document body into retrieval-ready chunks. Non-preamble chunks are prefixed with "Product: {title}\n{section heading}\n" for BM25 product discrimination. Preamble chunks are left as-is (they already name the product). Chunks shorter than 60 chars are suppressed.';

GRANT EXECUTE ON FUNCTION rag.chunk_sds_document_text(text, integer, integer, text) TO service_role;


-- ── Part 3: Update sync_sds_chunks to pass title to the chunker ──────────────

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
  v_inactive_chunk_count         integer := 0;
  v_remaining_docs               integer := 0;
BEGIN
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
      count(dc.id)::integer AS existing_chunk_count,
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
    (ds.is_active AND ds.has_chunkable_text AND ds.existing_chunk_count = 0)
    OR (NOT ds.is_active AND ds.existing_chunk_count > 0)
  ORDER BY ds.document_updated_at, ds.document_id
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
        'section_heading', ch.heading
      )
    ) AS chunk_metadata
  FROM rag_sds_sync_candidates c
  CROSS JOIN LATERAL rag.chunk_sds_document_text(
    c.body_text,
    p_max_chars,
    p_overlap_chars,
    c.title          -- pass document title for product name prefix
  ) ch
  WHERE c.is_active = true
    AND c.has_chunkable_text = true;

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

  DELETE FROM rag.document_chunk dc
  USING rag_sds_sync_candidates c
  WHERE c.document_id = dc.document_id
    AND c.is_active = false;

  GET DIAGNOSTICS v_inactive_chunk_count = ROW_COUNT;

  SELECT count(*) INTO v_remaining_docs
  FROM rag.document d
  JOIN rag.source_record sr ON sr.id = d.source_record_id
  WHERE d.document_kind = 'sds'
    AND upper(d.language_code) = v_language_code
    AND sr.is_active = true
    AND nullif(trim(d.body_text), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM rag.document_chunk dc WHERE dc.document_id = d.id
    );

  RETURN jsonb_build_object(
    'language_code',                v_language_code,
    'batch_limit',                  v_document_limit,
    'documents_processed',          v_documents_processed,
    'active_documents_processed',   v_active_documents_processed,
    'inactive_documents_processed', v_inactive_documents_processed,
    'chunks_upserted',              v_chunk_count,
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
  'Syncs SDS document chunks using section-aware splitting with product name prefix. Passes document title to chunker so each non-preamble chunk begins with "Product: {title}". Call in a loop until has_more = false.';

GRANT EXECUTE ON FUNCTION rag.sync_sds_chunks(text, integer, integer) TO service_role;
