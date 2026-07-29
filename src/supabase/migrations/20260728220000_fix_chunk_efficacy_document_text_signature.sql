-- B0-284 hotfix: Restore chunk_efficacy_document_text TABLE signature
--
-- Migration 20260725091000 (convert_security_definer_to_invoker) blanket-replaced
-- rag.chunk_efficacy_document_text with a generic 3-arg (p_document_key, p_raw_text,
-- p_metadata) jsonb-returning paragraph splitter, the same collision-bug pattern that
-- migration 20260725093000 already fixed for rag.chunk_sds_document_text — but no
-- equivalent fix was ever applied for the efficacy chunker. rag.sync_efficacy_chunks
-- (from 20260722030000_efficacy_chunking_and_sync.sql) still calls it as a
-- TABLE-returning function (`CROSS JOIN LATERAL ... ch` then `ch.chunk_index`, etc.),
-- so every sync attempt fails with "column ch.chunk_index does not exist".
--
-- This restores the original B0-228 heading/breadcrumb/table-aware chunking body and
-- 4-arg (p_body_markdown, p_max_chars, p_overlap_chars, p_title) TABLE signature
-- verbatim, only changing SECURITY DEFINER to SECURITY INVOKER (per B0-284 intent —
-- this function does no privileged table access, it only processes the text argument
-- passed in, so INVOKER is safe here exactly as it was for chunk_sds_document_text).

DROP FUNCTION IF EXISTS rag.chunk_efficacy_document_text CASCADE;

CREATE FUNCTION rag.chunk_efficacy_document_text(
  p_body_markdown text,
  p_max_chars integer default 2200,
  p_overlap_chars integer default 150,
  p_title text default null
)
returns table(
  chunk_index integer,
  heading text,
  section_path text[],
  chunk_text text,
  token_count integer,
  section_type text
)
language plpgsql
security invoker
set search_path to 'rag', 'public'
as $function$
DECLARE
  v_title            text := nullif(trim(p_title), '');

  v_lines            text[];
  v_n                integer;
  v_i                integer;
  v_line             text;
  v_level            integer;
  v_text             text;

  v_stack_level      integer[] := '{}';
  v_stack_text       text[]    := '{}';

  v_cur_heading      text := NULL;
  v_cur_breadcrumb   text := NULL;
  v_cur_body         text := '';

  v_sec_headings     text[] := '{}';
  v_sec_breadcrumbs  text[] := '{}';
  v_sec_bodies       text[] := '{}';
  v_sec_n            integer;

  v_heading          text;
  v_breadcrumb       text;
  v_body             text;
  v_sec_slug_path    text[];
  v_section_type     text;

  v_paragraphs       text[];
  v_para_n           integer;
  v_j                integer;
  v_para             text;
  v_sub_parts        text[]  := '{}';
  v_sub_chars        integer := 0;
  v_prev_text        text    := '';
  v_sub_body         text;
  v_overlap          text;
  v_final_text       text;

  v_chunk_idx        integer := 0;
BEGIN
  IF p_body_markdown IS NULL OR length(trim(p_body_markdown)) = 0 THEN
    RETURN;
  END IF;

  -- Phase 1: line-by-line heading-stack tracking (breadcrumb = all ancestor
  -- headings, so a table nested under "# Bactericidal Efficacy > ## AOAC Use-
  -- Dilution Method" still classifies as bactericidal even though the immediate
  -- heading alone wouldn't say so). Mirrors src/lib/rag/markdown-chunking.ts.
  v_lines := string_to_array(p_body_markdown, E'\n');
  v_n     := coalesce(array_length(v_lines, 1), 0);

  FOR v_i IN 1 .. v_n LOOP
    v_line := v_lines[v_i];

    IF v_line ~ '^#{1,6}[ \t]+\S' THEN
      v_sec_headings    := v_sec_headings    || v_cur_heading;
      v_sec_breadcrumbs := v_sec_breadcrumbs || v_cur_breadcrumb;
      v_sec_bodies      := v_sec_bodies      || v_cur_body;

      v_level := length((regexp_match(v_line, '^(#{1,6})'))[1]);
      v_text  := trim(regexp_replace(v_line, '^#{1,6}[ \t]+', ''));

      WHILE array_length(v_stack_level, 1) IS NOT NULL
        AND v_stack_level[array_length(v_stack_level, 1)] >= v_level LOOP
        v_stack_level := v_stack_level[1 : array_length(v_stack_level, 1) - 1];
        v_stack_text  := v_stack_text[1 : array_length(v_stack_text, 1) - 1];
      END LOOP;
      v_stack_level := v_stack_level || v_level;
      v_stack_text  := v_stack_text  || v_text;

      v_cur_heading    := v_text;
      v_cur_breadcrumb := array_to_string(v_stack_text, ' > ');
      v_cur_body       := '';
    ELSE
      v_cur_body := CASE WHEN v_cur_body = '' THEN v_line ELSE v_cur_body || E'\n' || v_line END;
    END IF;
  END LOOP;

  v_sec_headings    := v_sec_headings    || v_cur_heading;
  v_sec_breadcrumbs := v_sec_breadcrumbs || v_cur_breadcrumb;
  v_sec_bodies      := v_sec_bodies      || v_cur_body;
  v_sec_n := coalesce(array_length(v_sec_bodies, 1), 0);

  -- Phase 2: emit one chunk per section (or paragraph-split if oversized).
  FOR v_i IN 1 .. v_sec_n LOOP
    v_heading    := v_sec_headings[v_i];
    v_breadcrumb := v_sec_breadcrumbs[v_i];
    v_body       := trim(v_sec_bodies[v_i]);
    CONTINUE WHEN v_body IS NULL OR length(v_body) < 10;

    -- Section-type tagging (B0-228/237): classify from the FULL ancestor breadcrumb
    -- (not just the immediate heading) so organism-class context nested above an
    -- assay-method sub-heading is not lost. A claim table with no organism-class
    -- ancestor falls back to the generic 'organism_contact_time' bucket.
    v_section_type := CASE
      WHEN coalesce(v_breadcrumb, '') ~* '(virus|viral|virucid)' THEN 'virucidal_activity'
      WHEN coalesce(v_breadcrumb, '') ~* '(fungi|fungicid|fungistat|mold|mildew)' THEN 'fungistatic'
      WHEN coalesce(v_breadcrumb, '') ~* '(bacteri|antibacter|germicid|disinfect)' THEN 'bactericidal_efficacy'
      WHEN v_body ~* '\|' AND v_body ~* '(contact time|log reduction|% reduction|organism)'
        THEN 'organism_contact_time'
      ELSE NULL
    END;

    v_sec_slug_path := CASE
      WHEN v_breadcrumb IS NULL THEN ARRAY['efficacy', 'preamble']
      ELSE ARRAY['efficacy'] || (
        SELECT array_agg(trim(both '_' from lower(regexp_replace(part, '[^a-z0-9]+', '_', 'gi'))))
        FROM unnest(string_to_array(v_breadcrumb, ' > ')) AS part
      )
    END;

    IF length(v_body) <= p_max_chars THEN
      v_final_text := CASE
        WHEN v_breadcrumb IS NULL THEN v_body
        WHEN v_title IS NOT NULL THEN 'Product/Formula: ' || v_title || E'\n' || v_breadcrumb || E'\n' || v_body
        ELSE v_breadcrumb || E'\n' || v_body
      END;

      IF length(v_final_text) >= 20 THEN
        chunk_index  := v_chunk_idx;
        heading      := v_heading;
        section_path := v_sec_slug_path;
        chunk_text   := v_final_text;
        token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
        section_type := v_section_type;
        RETURN NEXT;
        v_chunk_idx := v_chunk_idx + 1;
      END IF;

    ELSE
      -- Oversized section: split on blank-line paragraphs only. A markdown claim
      -- table has no blank line inside its own rows, so it is one atomic paragraph
      -- here and is never split mid-table — it may just end up alone in its own chunk.
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
            WHEN v_breadcrumb IS NULL THEN v_overlap || v_sub_body
            WHEN v_title IS NOT NULL
              THEN 'Product/Formula: ' || v_title || E'\n' || v_breadcrumb || E'\n' || v_overlap || v_sub_body
            ELSE v_breadcrumb || E'\n' || v_overlap || v_sub_body
          END;

          IF length(v_final_text) >= 20 THEN
            chunk_index  := v_chunk_idx;
            heading      := v_heading;
            section_path := v_sec_slug_path;
            chunk_text   := v_final_text;
            token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
            section_type := v_section_type;
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
          WHEN v_breadcrumb IS NULL THEN v_overlap || v_sub_body
          WHEN v_title IS NOT NULL
            THEN 'Product/Formula: ' || v_title || E'\n' || v_breadcrumb || E'\n' || v_overlap || v_sub_body
          ELSE v_breadcrumb || E'\n' || v_overlap || v_sub_body
        END;

        IF length(v_final_text) >= 20 THEN
          chunk_index  := v_chunk_idx;
          heading      := v_heading;
          section_path := v_sec_slug_path;
          chunk_text   := v_final_text;
          token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
          section_type := v_section_type;
          RETURN NEXT;
          v_chunk_idx := v_chunk_idx + 1;
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$function$;

comment on function rag.chunk_efficacy_document_text(text, integer, integer, text) is
  'B0-228: heading-breadcrumb + table-aware chunker for efficacy lab-report markdown (body_markdown). Classifies section_type from the full ancestor-heading breadcrumb (not just the immediate heading) so organism-class context nested above an assay-method sub-heading is not lost. Never splits a markdown claim table mid-table. Restored to SECURITY INVOKER after the 20260725091000 collision bug (B0-284 hotfix, mirrors the chunk_sds_document_text fix in 20260725093000).';

grant execute on function rag.chunk_efficacy_document_text(text, integer, integer, text) to service_role;
