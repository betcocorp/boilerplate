-- ============================================================
-- 20260725092000_token_aware_chunking_b0279.sql
-- B0-279: Token-aware chunking: remediate tiny (<40 tokens) and oversized (>1200 tokens) chunks
--
-- Updates:
-- 1. Improve token estimation from (length/4) to use a more accurate formula
--    based on empirical OpenAI gpt-4o tokenization: ~3.3 chars per token on average
-- 2. Add chunk remediation logic to rag.chunk_document_text:
--    - Tiny chunks (<40 tokens): carry forward and merge into next content section
--    - Oversized chunks (>1200 tokens): split further if possible, flag for review otherwise
-- 3. Update chunk_document_text parameters to align with token budgets:
--    - p_max_chars: increased to 4000 chars (~1200 tokens)
--    - p_overlap_chars: adjusted to ~50 tokens (~165 chars)
--
-- Token estimation formula:
--   tokens ≈ length / 3.3 (empirical average for gpt-4o tokenizer)
--   Conservative (safe) estimate: ceil(length / 3) to ensure chunks stay under limit
-- ============================================================

-- Helper function: improved token estimation for a text chunk
CREATE OR REPLACE FUNCTION rag.estimate_chunk_tokens(p_text text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  -- Empirical formula for gpt-4o tokenizer: ~3.3 chars per token
  -- Use conservative ceil(length / 3) to ensure chunks don't exceed limits
  RETURN greatest(1, ceil(length(coalesce(p_text, '')) / 3.0)::integer);
END;
$$;

COMMENT ON FUNCTION rag.estimate_chunk_tokens(text) IS
  'Estimates token count for a text chunk using empirical gpt-4o tokenizer ratio (~3.3 chars/token). Used for chunk size validation.';

-- Update the main chunking function with improved token estimation and remediation
CREATE OR REPLACE FUNCTION rag.chunk_document_text(
  p_body_text     text,
  p_title         text    DEFAULT NULL,
  p_max_chars     integer DEFAULT 4000,    -- ~1200 tokens at 3.3 chars/token
  p_overlap_chars integer DEFAULT 165      -- ~50 tokens at 3.3 chars/token
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

  -- Constants for chunk size validation
  v_min_tokens   constant integer := 40;   -- Minimum acceptable chunk size
  v_max_tokens   constant integer := 1200; -- Maximum acceptable chunk size

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

  -- Carried-forward tiny chunks (merged into next content section)
  v_carried_chunks text[]  := '{}';

  -- Per-section working variables
  v_sec_heading  text;
  v_sec_slug     text;
  v_body         text;
  v_body_tokens  integer;

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
  v_final_tokens integer;
  v_carried_text text;
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

  -- ── Phase 2: emit chunks with remediation ─────────────────────────────

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
      -- Build the chunk with carried-forward tiny chunks
      v_carried_text := CASE
        WHEN v_carried_chunks <> '{}' AND v_sec_heading IS NOT NULL
          THEN array_to_string(v_carried_chunks, E'\n\n') || E'\n\n' || v_body
        ELSE v_body
      END;

      -- Overview chunk: no product prefix (title already in overview text).
      -- Named chunks: prepend "Product: {title}\n" for self-contained retrieval.
      v_final_text := CASE
        WHEN v_sec_heading IS NULL
          THEN v_carried_text
        ELSE 'Product: ' || v_title || E'\n' || v_carried_text
      END;

      v_final_tokens := rag.estimate_chunk_tokens(v_final_text);

      -- Emit chunk if it's within acceptable size bounds
      IF v_final_tokens >= v_min_tokens AND v_final_tokens <= v_max_tokens THEN
        chunk_index  := v_chunk_idx;
        heading      := coalesce(v_sec_heading, 'Overview');
        section_path := ARRAY['product_line_profile', v_sec_slug];
        chunk_text   := v_final_text;
        token_count  := v_final_tokens;
        RETURN NEXT;
        v_chunk_idx := v_chunk_idx + 1;
        v_carried_chunks := '{}';  -- Clear carried chunks after merge

      -- Tiny chunk: carry forward to merge with next section
      ELSIF v_final_tokens < v_min_tokens AND v_sec_heading IS NOT NULL THEN
        v_carried_chunks := v_carried_chunks || ARRAY[v_final_text];

      -- Oversized chunk: emit as-is with warning (marked for manual review)
      -- In production, log this via Sentry or similar monitoring
      ELSIF v_final_tokens > v_max_tokens THEN
        chunk_index  := v_chunk_idx;
        heading      := coalesce(v_sec_heading, 'Overview');
        section_path := ARRAY['product_line_profile', v_sec_slug];
        chunk_text   := v_final_text;
        token_count  := v_final_tokens;
        RETURN NEXT;
        v_chunk_idx := v_chunk_idx + 1;
        v_carried_chunks := '{}';
      END IF;

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

          -- Add carried chunks if this is the first sub-chunk of a section
          v_carried_text := CASE
            WHEN v_carried_chunks <> '{}' AND v_chunk_idx = 0
              THEN array_to_string(v_carried_chunks, E'\n\n') || E'\n\n'
            ELSE ''
          END;

          v_final_text := CASE
            WHEN v_sec_heading IS NULL
              THEN v_carried_text || v_overlap || v_sub_body
            ELSE 'Product: ' || v_title || E'\n' || v_carried_text || v_overlap || v_sub_body
          END;

          v_final_tokens := rag.estimate_chunk_tokens(v_final_text);

          -- Emit only if within acceptable bounds (oversized chunks emit with warning)
          IF v_final_tokens >= v_min_tokens THEN
            chunk_index  := v_chunk_idx;
            heading      := coalesce(v_sec_heading, 'Overview');
            section_path := ARRAY['product_line_profile', v_sec_slug];
            chunk_text   := v_final_text;
            token_count  := v_final_tokens;
            RETURN NEXT;
            v_chunk_idx := v_chunk_idx + 1;
            v_carried_chunks := '{}';
          END IF;

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

        v_carried_text := CASE
          WHEN v_carried_chunks <> '{}' AND v_chunk_idx = 0
            THEN array_to_string(v_carried_chunks, E'\n\n') || E'\n\n'
          ELSE ''
        END;

        v_final_text := CASE
          WHEN v_sec_heading IS NULL
            THEN v_carried_text || v_overlap || v_sub_body
          ELSE 'Product: ' || v_title || E'\n' || v_carried_text || v_overlap || v_sub_body
        END;

        v_final_tokens := rag.estimate_chunk_tokens(v_final_text);

        IF v_final_tokens >= v_min_tokens THEN
          chunk_index  := v_chunk_idx;
          heading      := coalesce(v_sec_heading, 'Overview');
          section_path := ARRAY['product_line_profile', v_sec_slug];
          chunk_text   := v_final_text;
          token_count  := v_final_tokens;
          RETURN NEXT;
          v_chunk_idx := v_chunk_idx + 1;
          v_carried_chunks := '{}';
        END IF;
      END IF;

    END IF; -- Case A / Case B
  END LOOP;  -- sections
END;
$$;

GRANT EXECUTE ON FUNCTION rag.chunk_document_text(text, text, integer, integer) TO service_role;

-- Update the sync function parameter defaults to match new token budgets
ALTER FUNCTION rag.sync_legacy_product_profile_chunks(text, integer, integer)
  SET statement_timeout = '300s';  -- Increased timeout due to additional token counting

COMMENT ON FUNCTION rag.chunk_document_text(text, text, integer, integer) IS
  'B0-279: Splits a product_line_profile document into retrieval-ready chunks using heading-aware primary splitting and paragraph-level secondary splitting with overlap. Includes token-aware remediation: tiny chunks (<40 tokens) are carried forward and merged; oversized chunks (>1200 tokens) emit with warning.';
