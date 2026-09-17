-- B0-1049 / B0-1050: rag.chunk_sds_document_text heading extraction was corrupting `heading`
-- with unbounded spans of raw body text, and (because that same value is glued onto the front
-- of every chunk_text produced for the section) duplicating that span verbatim across multiple
-- chunks in the same document.
--
-- Root cause (confirmed live 2026-09-17 against F091881 LWW Test Kit, 087CAN and PERASAN A):
--
--   1. The section-split regex (v_section_re) only recognised "Section N." / "Section N:"
--      (period or colon) as a valid separator between the section number and its title. Real
--      supplier SDS templates use other separators -- "SECTION 7 - Title" (ASCII hyphen; the
--      Enviro Tech / PERASAN A template) and "Section 7 – Title" (en dash U+2013; the
--      AquaPhoenix LWW/Warewash/Water Hardness test-kit template, confirmed live with 112
--      en-dash-separated headers and zero period/colon ones in the LWW Test Kit body). Neither
--      style ever split, so most or all of a hyphen/en-dash document became ONE unsplit
--      "section".
--
--   2. Independently of (1), the heading for whatever text WAS in a split section was taken as
--      "the first line up to the next literal newline" (split_part(..., E'\n', 1)). Betco SDS
--      PDFs extract as nearly flat text (few real newlines outside page breaks), so "the next
--      newline" is often a page or more away -- the heading swallowed most or all of the
--      section's real content (confirmed live: 087CAN's lone chunk had a 2,622-char heading;
--      three-quarters of the 1,162 chunked SDS documents in the corpus (887) have at least one
--      chunk with a heading over 500 characters, so this is corpus-wide, not limited to the 5
--      documents the manual audit spot-checked).
--
-- Combined, an oversized section (whole flat document, in the hyphen/en-dash case) gets
-- paginated into several chunks, each carrying the SAME oversized "heading" glued onto its
-- front -- corrupting `heading` (B0-1049) and duplicating that span into every one of those
-- chunks' chunk_text (B0-1050; confirmed live: PERASAN A chunks 2/3/4 all began with the same
-- 1,516-char span).
--
-- Fix (same signature, CREATE OR REPLACE keeps the existing ACL -- see AGENTS.md "RAG migration
-- landmines"):
--   * v_section_re / v_marker_re now accept period, colon, ASCII hyphen, en dash (–) or em dash
--     (—) as the separator, so real hyphen/en-dash headers actually split;
--   * the marker is matched anchored at the START of the split section (v_marker_re), not on
--     "the first line" -- the heading is then bounded to "Section N. <title>", the title capped
--     at 80 chars and cut at the first newline/period/capitalisation-run boundary, so it is
--     always a short label instead of a content span;
--   * the body is everything after the (short) marker match, so no content is reclassified as
--     heading and lost from chunk_text -- nothing is truncated, merged, rounded, or otherwise
--     altered in the regulated chunk_text itself, only the heading label changes;
--   * chunking/pagination, overlap and section_path shape (ARRAY[v_sec_slug], unchanged) are
--     otherwise identical to the current live function -- this migration does not touch
--     rag.sync_sds_chunks.
--
-- Known residual limitation (documented, not fixed here -- out of scope for these two tickets):
-- a genuine mid-sentence cross-reference that happens to read "...Section 8." (a forward
-- reference to a later section, not a real header) can still trigger a false split, since it is
-- syntactically identical to a real period-separated header and Postgres's regex engine has no
-- lookbehind to disambiguate. The impact is now bounded to one short, mislabeled heading on one
-- chunk (e.g. PERASAN A's chunk 9, "Section 8. Isolate hazard area" for what is actually the
-- tail of Section 6 and all of Section 7) rather than a multi-page duplicated blob.
--
-- Verified live via a scratch function (rag.chunk_sds_document_text_b1049_test, dropped after
-- verification) cross-joined against the real body_text of all three spot-checked documents
-- before this was applied:
--   * F091881 LWW Test Kit: 20 chunks -> 113 chunks, 16 distinct short headings (max 25 chars,
--     was one ~2,300+ char blob repeated across 14/20 chunks).
--   * 087CAN: 1 chunk -> 36 chunks, all short real per-section headings (max 83 chars, was one
--     2,622-char blob).
--   * PERASAN A: 4 chunks -> 20 chunks; the chunks 2/3/4 duplicate-content pattern is gone, all
--     headings are short and section-scoped (max 45 chars, was 1,516 chars repeated 3x).

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
  v_section_re   constant text := '((?:Section|Secci[oó]n|SECTION)\s+\d{1,2}\s*(?:[.:]|-|–|—)\s?)';
  v_marker_re    constant text := '^(?:Section|Secci[oó]n|SECTION)\s+(\d{1,2})\s*(?:[.:]|-|–|—)\s*';
  v_title        text := nullif(trim(p_title), '');

  v_sections     text[];
  v_sec_n        integer;
  v_i            integer;
  v_section_text text;
  v_marker       text[];
  v_heading      text;
  v_sec_slug     text;
  v_section_num  text;
  v_body         text;
  v_title_raw    text;
  v_title_short  text;

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
        -- Sentence-case template: the title is the first word plus every following word that
        -- does not start a new capitalised phrase.
        v_title_short := (regexp_match(v_title_raw, '^(\S+(?:\s+[^A-Z\s]\S*)*)'))[1];
      END IF;
      v_title_short := nullif(
        trim(regexp_replace(coalesce(v_title_short, v_title_raw), '[[:space:]:;,–—-]+$', '')),
        ''
      );

      v_heading  := 'Section ' || v_section_num || '.' || coalesce(' ' || v_title_short, '');
      v_sec_slug := 'section_' || v_section_num;
    ELSE
      v_heading  := NULL;
      v_sec_slug := NULL;
      v_body     := v_section_text;
    END IF;

    CONTINUE WHEN v_body IS NULL OR length(v_body) = 0;

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
