-- B0-988: SDS Section 7 (Handling and storage) missing from 721 of 1,162 chunked current SDS docs.
--
-- Root cause (confirmed live 2026-09-14 by dry-running the previous rag.chunk_sds_document_text on
-- an affected body): after splitting the body on the "Section N." marker, the old chunker took the
-- FIRST LINE of each section as its heading and everything after the first newline as its body.
-- Betco SDS PDFs extract as nearly flat text (~21 newlines in a 26,000-character body — page breaks
-- only), so a section with no page break inside it had an empty body and emitted NO chunk at all.
-- Section 7 is short and almost never spans a page break, so it was dropped from 721 documents;
-- Sections 1, 3, 5, 10 and 13 were dropped the same way. The 412 documents that DID have a
-- Section 7 chunk only had it because a page break happened to fall inside the section — and their
-- "heading" was the entire pre-break text, not a heading.
--
-- Fix (same signature, CREATE OR REPLACE keeps the existing ACL):
--   * the section marker is matched at the start of the section text, not on a "first line";
--   * the heading is "Section N. <title>" where the title is bounded (stops at the first newline or
--     period, max 80 chars, then trimmed to the sentence-case or ALL-CAPS title run — Betco SDS
--     print the title in sentence case immediately followed by the first field name);
--   * the body is the remainder after the marker, so nothing is lost when the text is flat;
--   * a paragraph longer than p_max_chars is split at sentence boundaries (falling back to the last
--     space) so flat text still respects the chunk size instead of becoming one oversized chunk;
--   * section_path is ARRAY['sds','section_N'] / ARRAY['sds','preamble'], the shape the B0-545-era
--     enrich_sds_section_headings_batch already writes.
--
-- rag.sync_sds_chunks (same signature, CREATE OR REPLACE) now stamps section_type from the section
-- number using the GHS mapping the corpus already carries (section_7 -> handling_storage, ...), so a
-- re-chunked Section 7 is reachable through filter_section_type='handling_storage' — the filter
-- inferSectionTypeFromQuery applies to "shelf life" / "how to store" queries. Previously new SDS
-- chunks were inserted with section_type NULL and depended on a periodic coarse backfill to 'sds'.
--
-- Chunking is a pure function of body text; this migration edits no rag.document row. Re-chunking the
-- affected documents (delete their chunks, run sync_sds_chunks, re-embed) is an operational step run
-- after this migration, with the deleted rows first copied to rag._backup_b0988_document_chunk_20260914.

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
SECURITY INVOKER
SET search_path = rag, public
AS $$
DECLARE
  v_sentinel     text := E'\x1E';
  -- Split marker: "Section 7." / "Section 7:" / "SECTION 7 :" / "Sección 7." — the number may be
  -- followed by optional whitespace before the period/colon (a few templates print "Section 7 .").
  v_section_re   constant text := '((?:Section|Secci[oó]n|SECTION)\s+\d{1,2}\s*[.:]\s?)';
  v_marker_re    constant text := '^(?:Section|Secci[oó]n|SECTION)\s+(\d{1,2})\s*[.:]\s*';
  v_title        text := nullif(trim(p_title), '');

  v_sections     text[];
  v_sec_n        integer;
  v_i            integer;
  v_section_text text;
  v_marker       text[];
  v_heading      text;
  v_sec_path     text[];
  v_section_num  text;
  v_body         text;
  v_title_raw    text;
  v_title_short  text;

  v_paragraphs   text[];
  v_para_n       integer;
  v_j            integer;
  v_para         text;
  v_pieces       text[];
  v_piece_n      integer;
  v_rest         text;
  v_head         text;
  v_pos          integer;
  v_cut          integer;

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

  IF p_max_chars IS NULL OR p_max_chars < 200 THEN
    p_max_chars := 1600;
  END IF;

  v_sections := string_to_array(
    regexp_replace(p_body_text, v_section_re, v_sentinel || '\1', 'gi'),
    v_sentinel
  );

  v_sec_n := coalesce(array_length(v_sections, 1), 0);

  FOR v_i IN 1 .. v_sec_n LOOP
    v_section_text := trim(v_sections[v_i]);
    CONTINUE WHEN v_section_text IS NULL OR length(v_section_text) = 0;

    v_marker := regexp_match(v_section_text, v_marker_re, 'i');

    IF v_marker IS NOT NULL THEN
      v_section_num := v_marker[1];
      -- Body = everything after the marker. The title stays in the body so nothing is lost when
      -- the title heuristic under-trims; the heading only needs to be a bounded label.
      v_body := trim(regexp_replace(v_section_text, v_marker_re, '', 'i'));

      v_title_raw := trim(coalesce((regexp_match(v_body, '^([^\n.]{1,80})'))[1], ''));
      IF v_title_raw ~ '^[A-Z][A-Z]' THEN
        -- ALL-CAPS template: keep the run of capitalised words and connectors.
        v_title_short := (regexp_match(
          v_title_raw,
          '^([A-Z][A-Z0-9/&,-]*(?:\s+(?:[A-Z][A-Z0-9/&,-]*|and|or|of|the|on|for|to|de|la|y|et))*)'
        ))[1];
      ELSE
        -- Sentence-case template ("Handling and storage Advice on general…"): the title is the
        -- first word plus every following word that does not start a new capitalised phrase.
        v_title_short := (regexp_match(v_title_raw, '^(\S+(?:\s+[^A-Z\s]\S*)*)'))[1];
      END IF;
      v_title_short := nullif(
        trim(regexp_replace(coalesce(v_title_short, v_title_raw), '[[:space:]:;,–—-]+$', '')),
        ''
      );

      v_heading  := 'Section ' || v_section_num || '.' || coalesce(' ' || v_title_short, '');
      v_sec_path := ARRAY['sds', 'section_' || v_section_num];
    ELSE
      v_heading  := NULL;
      v_sec_path := ARRAY['sds', 'preamble'];
      v_body     := v_section_text;
    END IF;

    CONTINUE WHEN v_body IS NULL OR length(v_body) = 0;

    -- Paragraphs on blank lines, then split any oversized paragraph at sentence boundaries so a
    -- flat-text section still yields chunks of at most p_max_chars.
    v_paragraphs := regexp_split_to_array(v_body, E'\\n{2,}');
    v_para_n     := coalesce(array_length(v_paragraphs, 1), 0);
    v_pieces     := '{}';

    FOR v_j IN 1 .. v_para_n LOOP
      v_para := trim(v_paragraphs[v_j]);
      CONTINUE WHEN v_para IS NULL OR length(v_para) = 0;

      v_rest := v_para;
      WHILE length(v_rest) > p_max_chars LOOP
        v_head := substring(v_rest FROM 1 FOR p_max_chars);

        -- Last sentence end (". ", "? ", "! ") inside the window.
        v_cut := 0;
        FOREACH v_pos IN ARRAY ARRAY[
          position(' .' IN reverse(v_head)),
          position(' ?' IN reverse(v_head)),
          position(' !' IN reverse(v_head))
        ] LOOP
          IF v_pos > 0 AND (length(v_head) - v_pos) > v_cut THEN
            v_cut := length(v_head) - v_pos;
          END IF;
        END LOOP;

        -- No sentence end in the second half: fall back to the last space, then to a hard cut.
        IF v_cut < p_max_chars / 2 THEN
          v_pos := position(' ' IN reverse(v_head));
          v_cut := CASE WHEN v_pos > 0 THEN length(v_head) - v_pos ELSE 0 END;
        END IF;
        IF v_cut < 1 THEN
          v_cut := p_max_chars;
        END IF;

        v_pieces := array_append(v_pieces, trim(substring(v_rest FROM 1 FOR v_cut)));
        v_rest   := trim(substring(v_rest FROM v_cut + 1));
      END LOOP;

      IF length(v_rest) > 0 THEN
        v_pieces := array_append(v_pieces, v_rest);
      END IF;
    END LOOP;

    v_piece_n := coalesce(array_length(v_pieces, 1), 0);
    CONTINUE WHEN v_piece_n = 0;

    v_sub_parts := '{}';
    v_sub_chars := 0;
    v_prev_text := '';

    FOR v_j IN 1 .. v_piece_n LOOP
      v_para := v_pieces[v_j];
      CONTINUE WHEN v_para IS NULL OR length(v_para) = 0;

      IF v_sub_chars = 0 OR v_sub_chars + length(v_para) + 2 <= p_max_chars THEN
        v_sub_parts := array_append(v_sub_parts, v_para);
        v_sub_chars := v_sub_chars + length(v_para) + 2;
        v_prev_text := v_para;
      ELSE
        v_sub_body := array_to_string(v_sub_parts, E'\n\n');
        v_final_text := CASE
          WHEN v_title IS NOT NULL AND v_heading IS NULL THEN 'Product: ' || v_title || E'\n' || v_sub_body
          WHEN v_title IS NOT NULL AND v_heading IS NOT NULL THEN 'Product: ' || v_title || E'\n' || v_heading || E'\n' || v_sub_body
          WHEN v_heading IS NOT NULL THEN v_heading || E'\n' || v_sub_body
          ELSE v_sub_body
        END;
        v_chunk_idx := v_chunk_idx + 1;
        RETURN QUERY SELECT
          v_chunk_idx,
          v_heading,
          v_sec_path,
          v_final_text,
          ceil(greatest(length(v_final_text), 1) / 4.0)::integer;

        -- Carry a tail of the previous piece into the next chunk as overlap.
        v_overlap := CASE
          WHEN p_overlap_chars IS NULL OR p_overlap_chars <= 0 THEN ''
          WHEN length(v_prev_text) <= p_overlap_chars THEN v_prev_text
          ELSE substring(v_prev_text FROM length(v_prev_text) - p_overlap_chars + 1)
        END;
        IF length(v_overlap) > 0 AND length(v_overlap) + length(v_para) + 2 <= p_max_chars THEN
          v_sub_parts := ARRAY[v_overlap, v_para];
          v_sub_chars := length(v_overlap) + length(v_para) + 4;
        ELSE
          v_sub_parts := ARRAY[v_para];
          v_sub_chars := length(v_para) + 2;
        END IF;
        v_prev_text := v_para;
      END IF;
    END LOOP;

    IF coalesce(array_length(v_sub_parts, 1), 0) > 0 THEN
      v_sub_body := array_to_string(v_sub_parts, E'\n\n');
      v_final_text := CASE
        WHEN v_title IS NOT NULL AND v_heading IS NULL THEN 'Product: ' || v_title || E'\n' || v_sub_body
        WHEN v_title IS NOT NULL AND v_heading IS NOT NULL THEN 'Product: ' || v_title || E'\n' || v_heading || E'\n' || v_sub_body
        WHEN v_heading IS NOT NULL THEN v_heading || E'\n' || v_sub_body
        ELSE v_sub_body
      END;
      v_chunk_idx := v_chunk_idx + 1;
      RETURN QUERY SELECT
        v_chunk_idx,
        v_heading,
        v_sec_path,
        v_final_text,
        ceil(greatest(length(v_final_text), 1) / 4.0)::integer;
    END IF;
  END LOOP;
END $$;

-- GHS section number -> the section_type vocabulary the corpus already uses (verified live 2026-09-14:
-- every fine-grained SDS section_type present in rag.document_chunk maps 1:1 to one section number).
CREATE OR REPLACE FUNCTION rag.sds_section_type_for_path(p_section_path text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = rag, public
AS $$
  SELECT CASE p_section_path[array_length(p_section_path, 1)]
    WHEN 'section_2'  THEN 'hazard'
    WHEN 'section_3'  THEN 'composition'
    WHEN 'section_4'  THEN 'first_aid'
    WHEN 'section_5'  THEN 'fire_fighting'
    WHEN 'section_6'  THEN 'spill_response'
    WHEN 'section_7'  THEN 'handling_storage'
    WHEN 'section_8'  THEN 'exposure_ppe'
    WHEN 'section_9'  THEN 'physical_properties'
    WHEN 'section_10' THEN 'stability'
    WHEN 'section_11' THEN 'toxicology'
    WHEN 'section_12' THEN 'ecological'
    WHEN 'section_13' THEN 'disposal'
    WHEN 'section_14' THEN 'transport'
    WHEN 'section_15' THEN 'regulatory'
    WHEN 'section_16' THEN 'other_info'
    ELSE 'sds'
  END
$$;

REVOKE ALL ON FUNCTION rag.sds_section_type_for_path(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rag.sds_section_type_for_path(text[]) TO service_role;

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
  -- B0-804 GUARD: the retrievable corpus is English-only. Blank/NULL already coalesced
  -- to 'EN' above; anything else is refused before a single row is chunked or embedded.
  IF v_language_code <> 'EN' THEN
    RAISE EXCEPTION
      'B0-804: rag.sync_sds_chunks refuses language code %. The retrievable corpus is English-only -- chunking another language would put untranslated regulated text into the retrieval candidate pool. See src/lib/rag/retrieval-language.ts.',
      v_language_code
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

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
    -- B0-988: GHS section type from the section number, never left NULL for a backfill.
    rag.sds_section_type_for_path(ch.section_path) AS section_type,
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
    c.title
  ) ch
  WHERE c.is_active = true
    AND c.has_chunkable_text = true;

  WITH upserted AS (
    INSERT INTO rag.document_chunk (
      chunk_key, document_id, chunk_index, section_path, section_type,
      heading, chunk_text, token_count, metadata
    )
    SELECT
      nc.chunk_key, nc.document_id, nc.chunk_index, nc.section_path, nc.section_type,
      nc.heading, nc.chunk_text, nc.token_count, nc.chunk_metadata
    FROM rag_sds_new_chunks nc
    ON CONFLICT (chunk_key) DO UPDATE
      SET
        document_id   = excluded.document_id,
        chunk_index   = excluded.chunk_index,
        section_path  = excluded.section_path,
        section_type  = excluded.section_type,
        heading       = excluded.heading,
        chunk_text    = excluded.chunk_text,
        token_count   = excluded.token_count,
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
      'strategy',      'sds-section-aware-v2-b0988',
      'max_chars',     p_max_chars,
      'overlap_chars', p_overlap_chars
    )
  );
END;
$function$;
