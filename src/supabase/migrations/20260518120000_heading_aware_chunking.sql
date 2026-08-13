-- ============================================================
-- 20260518120000_heading_aware_chunking.sql
--
-- Replaces the naive \n\n+ paragraph split in
-- sync_legacy_product_profile_chunks with a two-level strategy:
--
--   Level 1 – Primary split: detect "Section Name:" heading
--   lines and collect ALL content under each heading into one
--   logical section, regardless of blank lines within it.
--   This fixes the core problem where a section like "Features:"
--   spanning multiple paragraphs was fractured into several weak,
--   decontextualised chunks.
--
--   Level 2 – Secondary split: if a section exceeds p_max_chars
--   (default 2400 chars ≈ 600 tokens), split it further by its
--   internal blank-line paragraphs, packing greedily and
--   prepending a ~200-char (~50-token) overlap from the tail of
--   the previous sub-chunk so retrieval context is preserved
--   across boundaries.
--
-- Token estimation: ceil(length(final_chunk_text) / 4.0) — same
-- approximation as before, applied consistently to the final
-- emitted text (after product prefix and overlap prefix).
--
-- After applying this migration the pipeline MUST be re-run:
--   1. All existing product_line_profile chunks become stale on
--      the next sync call because chunk boundaries shift.
--   2. Run chunk sync until remaining_documents = 0.
--   3. Run embeddings until pending chunks = 0.
--
-- The function rag.chunk_document_text is a standalone helper;
-- it can be called directly for testing/inspection:
--   SELECT * FROM rag.chunk_document_text(body_text, title)
--   FROM rag.document WHERE document_key = 'my-product-key';
-- ============================================================


-- ── Part 1: heading-aware chunking helper ────────────────────────────────────
--
-- Returns one row per chunk for a single document body.
-- Parameters:
--   p_body_text     – raw document body text
--   p_title         – product title used in "Product: {title}" prefix
--   p_max_chars     – max characters per chunk before sub-splitting
--                     (default 2400 ≈ 600 tokens at 4 chars/token)
--   p_overlap_chars – tail characters from previous sub-chunk prepended
--                     as overlap context (default 200 ≈ 50 tokens)

CREATE OR REPLACE FUNCTION rag.chunk_document_text(
  p_body_text     text,
  p_title         text    DEFAULT NULL,
  p_max_chars     integer DEFAULT 2400,
  p_overlap_chars integer DEFAULT 200
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
  -- Matches lines like "Features:", "Dilution Ratios:", "Safety Information:"
  v_heading_re   constant text := '^[A-Za-z][A-Za-z0-9 /&()_-]*:$';
  v_title        text    := coalesce(nullif(trim(p_title), ''), 'Unknown product');

  -- Line iteration
  v_lines        text[];
  v_n            integer;
  v_i            integer;
  v_line         text;

  -- Section accumulator (one section per heading group)
  v_cur_heading  text    := NULL;   -- NULL signals the implicit Overview section
  v_cur_body     text    := '';

  -- Section arrays (one entry per detected section)
  v_sec_headings text[]  := '{}';
  v_sec_bodies   text[]  := '{}';
  v_sec_n        integer := 0;

  -- Output state
  v_chunk_idx    integer := 0;

  -- Per-section working variables
  v_sec_heading  text;
  v_sec_slug     text;
  v_body         text;

  -- Sub-splitting variables
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
BEGIN
  -- ── Phase 1: line-by-line section detection ────────────────────────────

  v_lines := string_to_array(p_body_text, E'\n');
  v_n     := coalesce(array_length(v_lines, 1), 0);

  FOR v_i IN 1 .. v_n LOOP
    v_line := v_lines[v_i];

    IF trim(v_line) ~ v_heading_re THEN
      -- Save whatever we have accumulated into the section lists
      v_sec_n        := v_sec_n + 1;
      v_sec_headings := v_sec_headings || ARRAY[v_cur_heading];
      v_sec_bodies   := v_sec_bodies   || ARRAY[v_cur_body];

      -- Begin a new named section
      v_cur_heading  := trim(trailing ':' from trim(v_line));
      v_cur_body     := '';

    ELSE
      -- Accumulate line into current section body
      v_cur_body := CASE
        WHEN v_cur_body = '' THEN v_line
        ELSE v_cur_body || E'\n' || v_line
      END;
    END IF;
  END LOOP;

  -- Flush the final section
  v_sec_n        := v_sec_n + 1;
  v_sec_headings := v_sec_headings || ARRAY[v_cur_heading];
  v_sec_bodies   := v_sec_bodies   || ARRAY[v_cur_body];

  -- ── Phase 2: emit chunks ───────────────────────────────────────────────

  FOR v_i IN 1 .. v_sec_n LOOP
    v_sec_heading := v_sec_headings[v_i];   -- NULL = Overview section
    v_body        := trim(v_sec_bodies[v_i]);

    -- Skip empty or degenerate sections (< 30 chars raw content)
    CONTINUE WHEN v_body IS NULL OR length(v_body) < 30;

    -- Build section_path slug from heading
    v_sec_slug := CASE
      WHEN v_sec_heading IS NULL
        THEN 'overview'
      ELSE trim(both '_' from lower(regexp_replace(v_sec_heading, '[^a-z0-9]+', '_', 'gi')))
    END;

    -- ── Case A: section fits within the token budget ─────────────────────

    IF length(v_body) <= p_max_chars THEN
      -- Overview chunk: no product prefix (title already in overview text).
      -- Named chunks: prepend "Product: {title}\n" for self-contained retrieval.
      v_final_text := CASE
        WHEN v_sec_heading IS NULL
          THEN v_body
        ELSE 'Product: ' || v_title || E'\n' || v_body
      END;

      chunk_index  := v_chunk_idx;
      heading      := coalesce(v_sec_heading, 'Overview');
      section_path := ARRAY['product_line_profile', v_sec_slug];
      chunk_text   := v_final_text;
      token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
      RETURN NEXT;
      v_chunk_idx := v_chunk_idx + 1;

    -- ── Case B: section exceeds budget → sub-split with overlap ──────────

    ELSE
      v_paragraphs := regexp_split_to_array(v_body, E'\\n\\s*\\n+');
      v_para_n     := coalesce(array_length(v_paragraphs, 1), 0);
      v_sub_parts  := '{}';
      v_sub_chars  := 0;
      v_prev_text  := '';

      FOR v_j IN 1 .. v_para_n LOOP
        v_para := trim(v_paragraphs[v_j]);
        CONTINUE WHEN v_para = '';

        -- Would adding this paragraph exceed the budget?
        IF v_sub_chars + length(v_para) > p_max_chars AND v_sub_parts <> '{}' THEN
          -- Emit the accumulated sub-chunk with optional overlap prefix
          v_sub_body := array_to_string(v_sub_parts, E'\n\n');
          v_overlap  := CASE
            WHEN v_prev_text <> '' AND p_overlap_chars > 0
              THEN '[…] ' || right(v_prev_text, p_overlap_chars) || E'\n\n'
            ELSE ''
          END;
          v_final_text := CASE
            WHEN v_sec_heading IS NULL
              THEN v_overlap || v_sub_body
            ELSE 'Product: ' || v_title || E'\n' || v_overlap || v_sub_body
          END;

          chunk_index  := v_chunk_idx;
          heading      := coalesce(v_sec_heading, 'Overview');
          section_path := ARRAY['product_line_profile', v_sec_slug];
          chunk_text   := v_final_text;
          token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
          RETURN NEXT;

          v_chunk_idx := v_chunk_idx + 1;
          v_prev_text := v_sub_body;
          v_sub_parts := ARRAY[v_para];
          v_sub_chars := length(v_para);

        ELSE
          v_sub_parts := v_sub_parts || ARRAY[v_para];
          v_sub_chars := v_sub_chars + length(v_para);
        END IF;
      END LOOP;

      -- Emit any remaining paragraphs in the sub-chunk accumulator
      IF v_sub_parts <> '{}' THEN
        v_sub_body := array_to_string(v_sub_parts, E'\n\n');
        v_overlap  := CASE
          WHEN v_prev_text <> '' AND p_overlap_chars > 0
            THEN '[…] ' || right(v_prev_text, p_overlap_chars) || E'\n\n'
          ELSE ''
        END;
        v_final_text := CASE
          WHEN v_sec_heading IS NULL
            THEN v_overlap || v_sub_body
          ELSE 'Product: ' || v_title || E'\n' || v_overlap || v_sub_body
        END;

        chunk_index  := v_chunk_idx;
        heading      := coalesce(v_sec_heading, 'Overview');
        section_path := ARRAY['product_line_profile', v_sec_slug];
        chunk_text   := v_final_text;
        token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
        RETURN NEXT;

        v_chunk_idx := v_chunk_idx + 1;
      END IF;

    END IF; -- Case A / Case B
  END LOOP;  -- sections
END;
$$;

COMMENT ON FUNCTION rag.chunk_document_text(text, text, integer, integer) IS
  'Splits a product_line_profile document body into retrieval-ready chunks using heading-aware primary splitting and paragraph-level secondary splitting with overlap. Callable standalone for testing.';

GRANT EXECUTE ON FUNCTION rag.chunk_document_text(text, text, integer, integer) TO service_role;


-- ── Part 2: updated sync function using the helper ───────────────────────────

CREATE OR REPLACE FUNCTION rag.sync_legacy_product_profile_chunks(
  p_language_code text    DEFAULT 'EN',
  p_max_chars     integer DEFAULT 2400,   -- 600 tokens × 4 chars/token
  p_overlap_chars integer DEFAULT 200     --  50 tokens × 4 chars/token
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
  v_remaining_document_count     integer := 0;
BEGIN
  -- ── Step 1: Collect candidate documents (batch) ───────────────────────────

  DROP TABLE IF EXISTS pg_temp.rag_chunk_sync_candidates;

  CREATE TEMPORARY TABLE rag_chunk_sync_candidates
  ON COMMIT DROP AS
  WITH document_state AS (
    SELECT
      d.id              AS document_id,
      d.document_key,
      d.title,
      d.language_code,
      d.body_text,
      coalesce(d.metadata, '{}'::jsonb) AS metadata,
      sr.is_active,
      d.updated_at      AS document_updated_at,
      count(dc.id)::integer AS existing_chunk_count,
      max(dc.updated_at)    AS latest_chunk_updated_at,
      nullif(trim(d.body_text), '') IS NOT NULL AS has_chunkable_text
    FROM rag.document d
    JOIN rag.source_record sr
      ON sr.id = d.source_record_id
    LEFT JOIN rag.document_chunk dc
      ON dc.document_id = d.id
    WHERE d.document_kind = 'product_line_profile'
      AND upper(d.language_code) = v_language_code
    GROUP BY
      d.id, d.document_key, d.title, d.language_code,
      d.body_text, d.metadata, sr.is_active, d.updated_at
  )
  SELECT *
  FROM document_state ds
  WHERE
    (
      ds.is_active
      AND (
        (
          ds.has_chunkable_text
          AND (
            ds.existing_chunk_count = 0
            OR ds.latest_chunk_updated_at IS NULL
            OR ds.latest_chunk_updated_at < ds.document_updated_at
          )
        )
        OR (NOT ds.has_chunkable_text AND ds.existing_chunk_count > 0)
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
  FROM rag_chunk_sync_candidates;

  -- ── Step 2: Generate chunks via heading-aware helper ─────────────────────
  --
  -- Store in a temp table so we reference the result set twice:
  -- once for the upsert (Step 3) and once for stale deletion (Step 4).
  -- Using a temp table avoids calling chunk_document_text twice per document.

  DROP TABLE IF EXISTS pg_temp.rag_new_chunks;

  CREATE TEMPORARY TABLE rag_new_chunks
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
        'document_kind',   'product_line_profile',
        'language_code',   c.language_code,
        'chunk_index',     ch.chunk_index,
        'section_heading', ch.heading
      )
    ) AS chunk_metadata
  FROM rag_chunk_sync_candidates c
  CROSS JOIN LATERAL rag.chunk_document_text(
    c.body_text,
    c.title,
    p_max_chars,
    p_overlap_chars
  ) ch
  WHERE c.is_active = true
    AND c.has_chunkable_text = true;

  -- ── Step 3: Upsert new chunks ─────────────────────────────────────────────
  --
  -- Clear embeddings when heading or chunk_text changes so the embedding
  -- pipeline re-embeds the updated content on the next run.

  WITH upserted AS (
    INSERT INTO rag.document_chunk (
      chunk_key,
      document_id,
      chunk_index,
      section_path,
      heading,
      chunk_text,
      token_count,
      metadata
    )
    SELECT
      nc.chunk_key,
      nc.document_id,
      nc.chunk_index,
      nc.section_path,
      nc.heading,
      nc.chunk_text,
      nc.token_count,
      nc.chunk_metadata
    FROM rag_new_chunks nc
    ON CONFLICT (chunk_key) DO UPDATE
      SET
        document_id  = excluded.document_id,
        chunk_index  = excluded.chunk_index,
        section_path = excluded.section_path,
        heading      = excluded.heading,
        chunk_text   = excluded.chunk_text,
        token_count  = excluded.token_count,
        -- Null out embeddings when content changes so re-embedding is triggered
        embedding_model = CASE
          WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
            OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text
            THEN NULL
          ELSE rag.document_chunk.embedding_model
        END,
        embedding = CASE
          WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
            OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text
            THEN NULL
          ELSE rag.document_chunk.embedding
        END,
        embedding_model_large = CASE
          WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
            OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text
            THEN NULL
          ELSE rag.document_chunk.embedding_model_large
        END,
        embedding_large = CASE
          WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
            OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text
            THEN NULL
          ELSE rag.document_chunk.embedding_large
        END,
        metadata = excluded.metadata
    RETURNING 1
  )
  SELECT count(*) INTO v_chunk_count FROM upserted;

  -- ── Step 4: Delete stale chunks ───────────────────────────────────────────
  --
  -- Remove chunks whose keys are no longer produced by the new chunking
  -- strategy for active documents in this batch.  Documents with
  -- has_chunkable_text = false produce no entries in rag_new_chunks, so all
  -- their existing chunks are correctly removed here.

  DELETE FROM rag.document_chunk dc
  WHERE EXISTS (
    SELECT 1
    FROM rag_chunk_sync_candidates c
    WHERE c.document_id = dc.document_id
      AND c.is_active = true
  )
  AND NOT EXISTS (
    SELECT 1
    FROM rag_new_chunks nc
    WHERE nc.document_id = dc.document_id
      AND nc.chunk_key = dc.chunk_key
  );

  GET DIAGNOSTICS v_stale_chunk_count = ROW_COUNT;

  -- ── Step 5: Delete all chunks for inactive documents ─────────────────────

  DELETE FROM rag.document_chunk dc
  USING rag_chunk_sync_candidates c
  WHERE c.document_id = dc.document_id
    AND c.is_active = false;

  GET DIAGNOSTICS v_inactive_chunk_count = ROW_COUNT;

  -- ── Step 6: Compute remaining work ───────────────────────────────────────

  WITH document_state AS (
    SELECT
      d.id AS document_id,
      sr.is_active,
      d.updated_at AS document_updated_at,
      count(dc.id)::integer AS existing_chunk_count,
      max(dc.updated_at)    AS latest_chunk_updated_at,
      nullif(trim(d.body_text), '') IS NOT NULL AS has_chunkable_text
    FROM rag.document d
    JOIN rag.source_record sr
      ON sr.id = d.source_record_id
    LEFT JOIN rag.document_chunk dc
      ON dc.document_id = d.id
    WHERE d.document_kind = 'product_line_profile'
      AND upper(d.language_code) = v_language_code
    GROUP BY d.id, sr.is_active, d.updated_at, d.body_text
  )
  SELECT count(*) INTO v_remaining_document_count
  FROM document_state ds
  WHERE
    (
      ds.is_active
      AND (
        (
          ds.has_chunkable_text
          AND (
            ds.existing_chunk_count = 0
            OR ds.latest_chunk_updated_at IS NULL
            OR ds.latest_chunk_updated_at < ds.document_updated_at
          )
        )
        OR (NOT ds.has_chunkable_text AND ds.existing_chunk_count > 0)
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
    'remaining_documents',          v_remaining_document_count,
    'has_more',                     v_remaining_document_count > 0,
    'chunking_config', jsonb_build_object(
      'strategy',      'heading-aware',
      'max_chars',     p_max_chars,
      'overlap_chars', p_overlap_chars
    )
  );
END;
$$;

COMMENT ON FUNCTION rag.sync_legacy_product_profile_chunks(text, integer, integer) IS
  'Chunks product_line_profile documents using heading-aware primary splitting and paragraph-level sub-splitting with overlap. Stale chunks from previous chunking strategy are deleted automatically. After first run all existing chunks will be stale; run chunk sync until remaining_documents = 0 then re-embed.';

GRANT EXECUTE ON FUNCTION rag.sync_legacy_product_profile_chunks(text, integer, integer) TO service_role;
