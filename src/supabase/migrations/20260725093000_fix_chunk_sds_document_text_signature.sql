-- B0-284 hotfix: Restore chunk_sds_document_text TABLE signature
--
-- Migration 20260725091000 incorrectly converted chunk_sds_document_text from
-- RETURNS TABLE (...) to RETURNS jsonb, breaking sync_sds_chunks RPC which
-- depends on the TABLE signature. This migration restores the proper TABLE-based
-- signature while keeping SECURITY INVOKER (per B0-284 intent).

DROP FUNCTION IF EXISTS rag.chunk_sds_document_text CASCADE;

CREATE FUNCTION rag.chunk_sds_document_text(
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
      v_heading  := null;
      v_sec_slug := null;
      v_body     := v_section_text;
    END IF;

    v_paragraphs := regexp_split_to_array(v_body, E'\\n{2,}');
    v_para_n := coalesce(array_length(v_paragraphs, 1), 0);

    IF v_para_n = 0 THEN
      CONTINUE;
    END IF;

    v_sub_parts := '{}';
    v_sub_chars := 0;
    v_prev_text := '';

    FOR v_j IN 1 .. v_para_n LOOP
      v_para := trim(v_paragraphs[v_j]);
      CONTINUE WHEN v_para IS NULL OR length(v_para) = 0;

      IF v_sub_chars + length(v_para) + length(v_prev_text) + 2 <= p_max_chars THEN
        v_sub_parts := array_append(v_sub_parts, v_para);
        v_sub_chars := v_sub_chars + length(v_para) + 2;
        v_prev_text := v_para;
      ELSE
        IF array_length(v_sub_parts, 1) > 0 THEN
          v_sub_body := array_to_string(v_sub_parts, E'\n\n');
          v_overlap := CASE
            WHEN length(v_prev_text) <= p_overlap_chars THEN v_prev_text
            ELSE substring(v_prev_text FROM length(v_prev_text) - p_overlap_chars + 1)
          END;
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
            ARRAY[v_sec_slug],
            v_final_text,
            ceil(greatest(length(v_final_text), 1) / 4.0)::integer;
        END IF;
        v_sub_parts := ARRAY[v_para];
        v_sub_chars := length(v_para);
        v_prev_text := v_para;
      END IF;
    END LOOP;

    IF array_length(v_sub_parts, 1) > 0 THEN
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
        ARRAY[v_sec_slug],
        v_final_text,
        ceil(greatest(length(v_final_text), 1) / 4.0)::integer;
    END IF;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION rag.chunk_sds_document_text TO service_role;
