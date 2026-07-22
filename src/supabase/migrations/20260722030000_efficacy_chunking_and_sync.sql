-- B0-228 — Table/section-aware chunker for efficacy lab-report markdown, plus the
-- sync_efficacy_chunks RPC that drives it. Mirrors the batched, drain-to-empty
-- contract of rag.sync_sds_chunks (same return shape: documents_processed,
-- chunks_upserted, remaining_documents, has_more) so runRagPipeline's existing
-- loop (src/lib/rag/pipeline.ts) works against it unchanged.
--
-- Unlike SDS (chunked from body_text, PDF-extracted prose), efficacy documents are
-- chunked from body_markdown (B0-224/227: prepared markdown with claim data as
-- markdown tables) so a table's row structure is preserved verbatim in chunk_text.
--
-- Chunking contract expected of upstream markdown (B0-224 producer):
--   - Sections are delimited by markdown headings (# .. ######).
--   - Each organism/contact-time/log-reduction claim table is a single markdown
--     table with no blank line inside it, so it is never split — see below, a
--     table is one indivisible "paragraph" to the fallback splitter.
create or replace function rag.chunk_efficacy_document_text(
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
security definer
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
  'B0-228: heading-breadcrumb + table-aware chunker for efficacy lab-report markdown (body_markdown). Classifies section_type from the full ancestor-heading breadcrumb (not just the immediate heading) so organism-class context nested above an assay-method sub-heading is not lost. Never splits a markdown claim table mid-table.';

grant execute on function rag.chunk_efficacy_document_text(text, integer, integer, text) to service_role;

-- sync_efficacy_chunks — batched drain-to-empty sync, same contract as sync_sds_chunks.
create or replace function rag.sync_efficacy_chunks(p_language_code text default 'EN'::text, p_max_chars integer default 2200, p_overlap_chars integer default 150)
returns jsonb
language plpgsql
security definer
set search_path to 'rag', 'public'
as $function$
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
  DROP TABLE IF EXISTS pg_temp.rag_efficacy_sync_candidates;
  CREATE TEMPORARY TABLE rag_efficacy_sync_candidates ON COMMIT DROP AS
  WITH document_state AS (
    SELECT d.id AS document_id, d.document_key, d.title, d.language_code, d.body_markdown,
      d.is_current, d.lifecycle_status,
      coalesce(d.metadata, '{}'::jsonb) AS metadata, sr.is_active, d.updated_at AS document_updated_at,
      count(dc.id)::integer AS existing_chunk_count,
      nullif(trim(d.body_markdown), '') IS NOT NULL AS has_chunkable_text
    FROM rag.document d
    JOIN rag.source_record sr ON sr.id = d.source_record_id
    LEFT JOIN rag.document_chunk dc ON dc.document_id = d.id
    WHERE d.document_kind = 'efficacy' AND upper(d.language_code) = v_language_code
    GROUP BY d.id, d.document_key, d.title, d.language_code, d.body_markdown, d.is_current,
      d.lifecycle_status, d.metadata, sr.is_active, d.updated_at
  )
  SELECT * FROM document_state ds
  WHERE (ds.is_active AND ds.has_chunkable_text AND ds.existing_chunk_count = 0)
     OR (NOT ds.is_active AND ds.existing_chunk_count > 0)
  ORDER BY ds.document_updated_at, ds.document_id
  LIMIT v_document_limit;

  SELECT count(*), count(*) FILTER (WHERE is_active), count(*) FILTER (WHERE NOT is_active)
  INTO v_documents_processed, v_active_documents_processed, v_inactive_documents_processed
  FROM rag_efficacy_sync_candidates;

  DROP TABLE IF EXISTS pg_temp.rag_efficacy_new_chunks;
  CREATE TEMPORARY TABLE rag_efficacy_new_chunks ON COMMIT DROP AS
  SELECT c.document_id, concat(c.document_key, ':chunk:', ch.chunk_index) AS chunk_key,
    ch.chunk_index, ch.heading, ch.section_path, ch.chunk_text, ch.token_count, ch.section_type,
    c.metadata || jsonb_strip_nulls(jsonb_build_object(
      'document_kind', 'efficacy', 'language_code', c.language_code, 'chunk_index', ch.chunk_index,
      'section_heading', ch.heading, 'is_current', c.is_current, 'lifecycle_status', c.lifecycle_status
    )) AS chunk_metadata
  FROM rag_efficacy_sync_candidates c
  CROSS JOIN LATERAL rag.chunk_efficacy_document_text(c.body_markdown, p_max_chars, p_overlap_chars, c.title) ch
  WHERE c.is_active = true AND c.has_chunkable_text = true;

  WITH upserted AS (
    INSERT INTO rag.document_chunk (chunk_key, document_id, chunk_index, section_path, heading, chunk_text, token_count, section_type, metadata)
    SELECT nc.chunk_key, nc.document_id, nc.chunk_index, nc.section_path, nc.heading, nc.chunk_text, nc.token_count, nc.section_type, nc.chunk_metadata
    FROM rag_efficacy_new_chunks nc
    ON CONFLICT (chunk_key) DO UPDATE SET
      document_id = excluded.document_id, chunk_index = excluded.chunk_index, section_path = excluded.section_path,
      heading = excluded.heading, chunk_text = excluded.chunk_text, token_count = excluded.token_count,
      section_type = excluded.section_type,
      embedding_model_large = CASE WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
        OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text THEN NULL ELSE rag.document_chunk.embedding_model_large END,
      embedding_large = CASE WHEN rag.document_chunk.heading IS DISTINCT FROM excluded.heading
        OR rag.document_chunk.chunk_text IS DISTINCT FROM excluded.chunk_text THEN NULL ELSE rag.document_chunk.embedding_large END,
      metadata = excluded.metadata
    RETURNING 1
  )
  SELECT count(*) INTO v_chunk_count FROM upserted;

  DELETE FROM rag.document_chunk dc USING rag_efficacy_sync_candidates c
  WHERE c.document_id = dc.document_id AND c.is_active = false;
  GET DIAGNOSTICS v_inactive_chunk_count = ROW_COUNT;

  SELECT count(*) INTO v_remaining_docs
  FROM rag.document d JOIN rag.source_record sr ON sr.id = d.source_record_id
  WHERE d.document_kind = 'efficacy' AND upper(d.language_code) = v_language_code AND sr.is_active = true
    AND nullif(trim(d.body_markdown), '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM rag.document_chunk dc WHERE dc.document_id = d.id);

  RETURN jsonb_build_object(
    'language_code', v_language_code, 'batch_limit', v_document_limit,
    'documents_processed', v_documents_processed, 'active_documents_processed', v_active_documents_processed,
    'inactive_documents_processed', v_inactive_documents_processed, 'chunks_upserted', v_chunk_count,
    'inactive_chunks_deleted', v_inactive_chunk_count, 'remaining_documents', v_remaining_docs,
    'has_more', v_remaining_docs > 0,
    'chunking_config', jsonb_build_object('strategy', 'efficacy-table-aware', 'max_chars', p_max_chars, 'overlap_chars', p_overlap_chars)
  );
END;
$function$;

comment on function rag.sync_efficacy_chunks(text, integer, integer) is
  'B0-228: batched drain-to-empty chunk sync for document_kind=efficacy, same return contract as rag.sync_sds_chunks.';

grant execute on function rag.sync_efficacy_chunks(text, integer, integer) to service_role;
