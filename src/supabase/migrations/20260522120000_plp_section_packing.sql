-- ============================================================
-- 20260522120000_plp_section_packing.sql
--
-- Replaces the per-section emit in chunk_document_text with a
-- greedy packing strategy so small adjacent sections are merged
-- into a single chunk targeting the 300-600 token (1200-2400
-- char) range.
--
-- How packing works:
--   Sections are accumulated in a pack until the next section
--   would push it over p_max_chars. The pack is then flushed
--   as one chunk. A section that is itself larger than
--   p_max_chars is handled by the existing paragraph sub-split
--   (first the pending pack is flushed, then the section is
--   sub-split with overlap).
--
-- Named sections now embed their heading as a label within the
-- chunk text: "Heading:\n{body}", making packed chunks
-- self-contained without requiring the heading column.
--
-- After this migration ALL PLP documents are touched so the
-- sync function detects them as stale and re-chunks them on the
-- next pipeline run (100 at a time, no service gap).
-- ============================================================


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
  -- Matches lines like "Features:", "Dilution Ratios:", "Directions for use:"
  v_heading_re   constant text := '^[A-Za-z][A-Za-z0-9 /&()_-]*:$';
  v_title        text    := coalesce(nullif(trim(p_title), ''), 'Unknown product');

  -- Phase 1: line iteration
  v_lines        text[];
  v_n            integer;
  v_i            integer;
  v_line         text;

  v_cur_heading  text    := NULL;
  v_cur_body     text    := '';

  v_sec_headings text[]  := '{}';
  v_sec_bodies   text[]  := '{}';
  v_sec_n        integer := 0;

  -- Phase 2: greedy packing
  v_chunk_idx    integer := 0;
  v_sec_heading  text;
  v_sec_slug     text;
  v_body         text;
  v_sec_formatted text;   -- this section formatted for inclusion in a pack

  -- Pack accumulator
  v_pack_text    text    := '';
  v_pack_head    text    := NULL;   -- heading of first section (NULL = overview)
  v_pack_slug    text    := 'overview';

  -- Sub-split helpers (oversized sections)
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
  -- ── Phase 1: line-by-line section detection (unchanged) ───────────────────

  v_lines := string_to_array(p_body_text, E'\n');
  v_n     := coalesce(array_length(v_lines, 1), 0);

  FOR v_i IN 1 .. v_n LOOP
    v_line := v_lines[v_i];
    IF trim(v_line) ~ v_heading_re THEN
      v_sec_n        := v_sec_n + 1;
      v_sec_headings := v_sec_headings || ARRAY[v_cur_heading];
      v_sec_bodies   := v_sec_bodies   || ARRAY[v_cur_body];
      v_cur_heading  := trim(trailing ':' from trim(v_line));
      v_cur_body     := '';
    ELSE
      v_cur_body := CASE
        WHEN v_cur_body = '' THEN v_line
        ELSE v_cur_body || E'\n' || v_line
      END;
    END IF;
  END LOOP;

  v_sec_n        := v_sec_n + 1;
  v_sec_headings := v_sec_headings || ARRAY[v_cur_heading];
  v_sec_bodies   := v_sec_bodies   || ARRAY[v_cur_body];

  -- ── Phase 2: greedy section packing ───────────────────────────────────────
  --
  -- For each section we decide whether to add it to the current pack or
  -- flush and start a new one. Oversized sections (> p_max_chars alone)
  -- are sub-split by paragraph with overlap after the pack is flushed.

  v_pack_text := '';
  v_pack_head := NULL;
  v_pack_slug := 'overview';

  FOR v_i IN 1 .. v_sec_n LOOP
    v_sec_heading := v_sec_headings[v_i];
    v_body        := trim(v_sec_bodies[v_i]);
    CONTINUE WHEN v_body IS NULL OR length(v_body) < 30;

    v_sec_slug := CASE
      WHEN v_sec_heading IS NULL
        THEN 'overview'
      ELSE trim(both '_' from lower(regexp_replace(v_sec_heading, '[^a-z0-9]+', '_', 'gi')))
    END;

    -- Format for packing:
    --   Overview section: plain body (already contains "Product line: …" lines)
    --   Named section: embed heading as label "Heading:\n{body}" for self-contained context
    v_sec_formatted := CASE
      WHEN v_sec_heading IS NULL THEN v_body
      ELSE v_sec_heading || ':' || E'\n' || v_body
    END;

    -- ── Oversized section: flush pack then sub-split ─────────────────────────
    IF length(v_sec_formatted) > p_max_chars THEN

      -- Flush any pending pack first
      IF length(v_pack_text) > 0 THEN
        v_final_text := CASE
          WHEN v_pack_head IS NULL THEN v_pack_text
          ELSE 'Product: ' || v_title || E'\n' || v_pack_text
        END;
        IF length(v_final_text) >= 120 THEN
          chunk_index  := v_chunk_idx;
          heading      := coalesce(v_pack_head, 'Overview');
          section_path := ARRAY['product_line_profile', v_pack_slug];
          chunk_text   := v_final_text;
          token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
          RETURN NEXT;
          v_chunk_idx := v_chunk_idx + 1;
        END IF;
        v_pack_text := '';
        v_pack_head := NULL;
        v_pack_slug := 'overview';
      END IF;

      -- Sub-split the oversized section by paragraphs with overlap
      v_paragraphs := regexp_split_to_array(v_body, E'\\n\\s*\\n+');
      v_para_n     := coalesce(array_length(v_paragraphs, 1), 0);
      v_sub_parts  := '{}';
      v_sub_chars  := 0;
      v_prev_text  := '';

      FOR v_j IN 1 .. v_para_n LOOP
        v_para := trim(v_paragraphs[v_j]);
        CONTINUE WHEN v_para = '';

        IF v_sub_chars + length(v_para) > p_max_chars AND v_sub_parts <> '{}' THEN
          v_sub_body   := array_to_string(v_sub_parts, E'\n\n');
          v_overlap    := CASE
            WHEN v_prev_text <> '' AND p_overlap_chars > 0
              THEN '[...] ' || right(v_prev_text, p_overlap_chars) || E'\n\n'
            ELSE ''
          END;
          v_final_text := CASE
            WHEN v_sec_heading IS NULL
              THEN v_overlap || v_sub_body
            ELSE 'Product: ' || v_title || E'\n' || v_sec_heading || ':' || E'\n' || v_overlap || v_sub_body
          END;

          IF length(v_final_text) >= 120 THEN
            chunk_index  := v_chunk_idx;
            heading      := coalesce(v_sec_heading, 'Overview');
            section_path := ARRAY['product_line_profile', v_sec_slug];
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
        v_sub_body   := array_to_string(v_sub_parts, E'\n\n');
        v_overlap    := CASE
          WHEN v_prev_text <> '' AND p_overlap_chars > 0
            THEN '[...] ' || right(v_prev_text, p_overlap_chars) || E'\n\n'
          ELSE ''
        END;
        v_final_text := CASE
          WHEN v_sec_heading IS NULL
            THEN v_overlap || v_sub_body
          ELSE 'Product: ' || v_title || E'\n' || v_sec_heading || ':' || E'\n' || v_overlap || v_sub_body
        END;

        IF length(v_final_text) >= 120 THEN
          chunk_index  := v_chunk_idx;
          heading      := coalesce(v_sec_heading, 'Overview');
          section_path := ARRAY['product_line_profile', v_sec_slug];
          chunk_text   := v_final_text;
          token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
          RETURN NEXT;
          v_chunk_idx := v_chunk_idx + 1;
        END IF;
      END IF;

    -- ── Normal section: add to pack or flush ─────────────────────────────────
    ELSE

      IF v_pack_text = '' THEN
        -- Start a new pack with this section
        v_pack_text := v_sec_formatted;
        v_pack_head := v_sec_heading;
        v_pack_slug := v_sec_slug;

      ELSIF length(v_pack_text) + length(v_sec_formatted) + 2 <= p_max_chars THEN
        -- Fits: append with blank-line separator
        v_pack_text := v_pack_text || E'\n\n' || v_sec_formatted;

      ELSE
        -- Overflow: flush current pack, start new one with this section
        v_final_text := CASE
          WHEN v_pack_head IS NULL THEN v_pack_text
          ELSE 'Product: ' || v_title || E'\n' || v_pack_text
        END;
        IF length(v_final_text) >= 120 THEN
          chunk_index  := v_chunk_idx;
          heading      := coalesce(v_pack_head, 'Overview');
          section_path := ARRAY['product_line_profile', v_pack_slug];
          chunk_text   := v_final_text;
          token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
          RETURN NEXT;
          v_chunk_idx := v_chunk_idx + 1;
        END IF;
        v_pack_text := v_sec_formatted;
        v_pack_head := v_sec_heading;
        v_pack_slug := v_sec_slug;
      END IF;

    END IF;
  END LOOP;

  -- ── Flush final pack ───────────────────────────────────────────────────────
  IF length(v_pack_text) > 0 THEN
    v_final_text := CASE
      WHEN v_pack_head IS NULL THEN v_pack_text
      ELSE 'Product: ' || v_title || E'\n' || v_pack_text
    END;
    IF length(v_final_text) >= 120 THEN
      chunk_index  := v_chunk_idx;
      heading      := coalesce(v_pack_head, 'Overview');
      section_path := ARRAY['product_line_profile', v_pack_slug];
      chunk_text   := v_final_text;
      token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
      RETURN NEXT;
    END IF;
  END IF;
END;
$$;

COMMENT ON FUNCTION rag.chunk_document_text(text, text, integer, integer) IS
  'Splits a product_line_profile document into retrieval-ready chunks using heading-aware primary splitting with greedy section packing. Small adjacent sections are merged into a single chunk targeting 300-600 tokens. Oversized sections are sub-split by paragraph with overlap. Named sections embed their heading as a label in the chunk text.';

GRANT EXECUTE ON FUNCTION rag.chunk_document_text(text, text, integer, integer) TO service_role;


-- Touch all PLP documents so the sync function sees them as stale and
-- re-chunks them progressively on the next pipeline run.
UPDATE rag.document
SET updated_at = now()
WHERE document_kind = 'product_line_profile';
