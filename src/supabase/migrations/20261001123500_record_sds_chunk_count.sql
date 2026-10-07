-- Keep source_record ingestion metadata synchronized with the atomic SDS chunk replacement.
-- The function signature is unchanged so existing server actions continue to call the same RPC.

CREATE OR REPLACE FUNCTION rag.replace_sds_markdown_chunks(
  p_document_id uuid,
  p_chunks jsonb,
  p_strategy text,
  p_chunk_size integer,
  p_chunk_overlap integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rag, public
AS $$
DECLARE
  v_document_key text;
  v_document_kind text;
  v_language_code text;
  v_body_markdown text;
  v_document_metadata jsonb;
  v_source_record_id uuid;
  v_is_active boolean;
  v_chunk_count integer;
BEGIN
  IF jsonb_typeof(p_chunks) <> 'array' OR jsonb_array_length(p_chunks) = 0 THEN
    RAISE EXCEPTION 'SDS markdown chunk payload must be a non-empty JSON array.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT
    d.document_key,
    d.document_kind,
    d.language_code,
    d.body_markdown,
    d.metadata,
    d.source_record_id,
    sr.is_active
  INTO
    v_document_key,
    v_document_kind,
    v_language_code,
    v_body_markdown,
    v_document_metadata,
    v_source_record_id,
    v_is_active
  FROM rag.document d
  JOIN rag.source_record sr ON sr.id = d.source_record_id
  WHERE d.id = p_document_id
  FOR UPDATE OF d, sr;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SDS document % does not exist.', p_document_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_document_kind <> 'sds' THEN
    RAISE EXCEPTION 'Document % is %, expected sds.', p_document_id, v_document_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF upper(v_language_code) <> 'EN' OR NOT v_is_active THEN
    RAISE EXCEPTION 'Document % is not an active English SDS.', p_document_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF nullif(trim(v_body_markdown), '') IS NULL THEN
    RAISE EXCEPTION 'Document % has no markdown body.', p_document_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.sds_markdown_chunks (
    chunk_index integer PRIMARY KEY,
    heading text,
    section_path text[] NOT NULL,
    section_type text NOT NULL,
    chunk_text text NOT NULL,
    token_count integer NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.sds_markdown_chunks;

  INSERT INTO pg_temp.sds_markdown_chunks (
    chunk_index, heading, section_path, section_type, chunk_text, token_count
  )
  SELECT
    (item->>'chunkIndex')::integer,
    nullif(trim(item->>'heading'), ''),
    ARRAY(SELECT jsonb_array_elements_text(item->'sectionPath')),
    coalesce(nullif(trim(item->>'sectionType'), ''), 'sds'),
    item->>'chunkText',
    (item->>'tokenCount')::integer
  FROM jsonb_array_elements(p_chunks) item;

  IF EXISTS (
    SELECT 1 FROM pg_temp.sds_markdown_chunks
    WHERE chunk_index < 0 OR nullif(trim(chunk_text), '') IS NULL OR token_count < 1
  ) THEN
    RAISE EXCEPTION 'SDS markdown chunk payload contains an invalid chunk.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM rag.document_chunk WHERE document_id = p_document_id;

  INSERT INTO rag.document_chunk (
    chunk_key,
    document_id,
    chunk_index,
    section_path,
    section_type,
    heading,
    chunk_text,
    token_count,
    metadata
  )
  SELECT
    v_document_key || ':chunk:' || c.chunk_index,
    p_document_id,
    c.chunk_index,
    c.section_path,
    c.section_type,
    c.heading,
    c.chunk_text,
    c.token_count,
    coalesce(v_document_metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'document_kind', 'sds',
      'language_code', v_language_code,
      'chunk_index', c.chunk_index,
      'section_heading', c.heading,
      'chunking_strategy', p_strategy
    ))
  FROM pg_temp.sds_markdown_chunks c
  ORDER BY c.chunk_index;

  GET DIAGNOSTICS v_chunk_count = ROW_COUNT;

  UPDATE rag.document
  SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'chunking_strategy', p_strategy,
    'chunk_size', p_chunk_size,
    'chunk_overlap', p_chunk_overlap,
    'chunked_at', timezone('utc', now())
  )
  WHERE id = p_document_id;

  UPDATE rag.source_record
  SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'ingestion',
      coalesce(metadata->'ingestion', '{}'::jsonb) || jsonb_build_object(
        'chunk_count', v_chunk_count
      )
    ),
    updated_at = timezone('utc', now())
  WHERE id = v_source_record_id;

  RETURN jsonb_build_object(
    'document_id', p_document_id,
    'source_record_id', v_source_record_id,
    'chunks_upserted', v_chunk_count,
    'chunking_strategy', p_strategy
  );
END;
$$;

REVOKE ALL ON FUNCTION rag.replace_sds_markdown_chunks(uuid, jsonb, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rag.replace_sds_markdown_chunks(uuid, jsonb, text, integer, integer) TO service_role;

COMMENT ON FUNCTION rag.replace_sds_markdown_chunks(uuid, jsonb, text, integer, integer) IS
  'Atomically replaces chunks for one active English SDS document using LangChain-generated chunks, preserves rag.document.id, and records the resulting source chunk count.';
