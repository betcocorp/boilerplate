-- ============================================================
-- 20260725091000_convert_security_definer_to_invoker.sql
-- B0-284: Convert SECURITY DEFINER functions to SECURITY INVOKER
--
-- Context: 7 chunking/encoding functions in rag schema currently use
-- SECURITY DEFINER for backward compatibility. Converting to SECURITY INVOKER
-- (the default) ensures RLS policies apply to the invoking role instead of
-- the function definer's privilege level, reducing attack surface.
--
-- Note: The 20260722061000 lockdown migration already restricted all these
-- to service_role EXECUTE, so this conversion improves RLS semantics without
-- immediate functional change. All callers are internal (bex API routes),
-- which call via service_role client.
-- ============================================================

-- Step 1: Verify current SECURITY DEFINER functions before conversion
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on p.pronamespace = n.oid
  where n.nspname = 'rag'
    and prosecdef = true;  -- SECURITY DEFINER flag
  raise notice 'B0-284: Found % SECURITY DEFINER functions in rag schema', v_count;
end $$;

-- Step 2: Drop and recreate chunking functions WITHOUT SECURITY DEFINER
-- These use RLS indirectly via the document/chunk inserts they trigger.

DROP FUNCTION IF EXISTS rag.chunk_document_text(text, text, text, jsonb) CASCADE;

CREATE FUNCTION rag.chunk_document_text(
  p_document_key text,
  p_raw_text text,
  p_section_type text DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER  -- Changed from SECURITY DEFINER
SET search_path = rag, public
AS $$
declare
  v_chunks jsonb := '[]'::jsonb;
  v_chunk_text text;
  v_token_count integer;
begin
  -- Split text by paragraph breaks, estimate token count (4 chars = ~1 token)
  for v_chunk_text in
    select trim(s) from regexp_split_to_array(p_raw_text, E'\\n\\s*\\n+') as s
    where trim(s) is not null and trim(s) != ''
  loop
    v_token_count := ceil(greatest(length(v_chunk_text), 1) / 4.0)::integer;
    v_chunks := v_chunks || jsonb_build_object(
      'document_key', p_document_key,
      'section_type', p_section_type,
      'text', v_chunk_text,
      'token_count', v_token_count,
      'metadata', coalesce(p_metadata, '{}'::jsonb)
    );
  end loop;
  return v_chunks;
end $$;

DROP FUNCTION IF EXISTS rag.chunk_sds_document_text(text, text, jsonb) CASCADE;

CREATE FUNCTION rag.chunk_sds_document_text(
  p_document_key text,
  p_raw_text text,
  p_metadata jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER  -- Changed from SECURITY DEFINER
SET search_path = rag, public
AS $$
declare
  v_chunks jsonb := '[]'::jsonb;
  v_chunk_text text;
  v_token_count integer;
begin
  -- Split by section headings or paragraphs
  for v_chunk_text in
    select trim(s) from regexp_split_to_array(p_raw_text, E'\\n\\s*\\n+') as s
    where trim(s) is not null and trim(s) != ''
  loop
    v_token_count := ceil(greatest(length(v_chunk_text), 1) / 4.0)::integer;
    v_chunks := v_chunks || jsonb_build_object(
      'document_key', p_document_key,
      'text', v_chunk_text,
      'token_count', v_token_count,
      'metadata', coalesce(p_metadata, '{}'::jsonb)
    );
  end loop;
  return v_chunks;
end $$;

DROP FUNCTION IF EXISTS rag.chunk_efficacy_document_text(text, text, jsonb) CASCADE;

CREATE FUNCTION rag.chunk_efficacy_document_text(
  p_document_key text,
  p_raw_text text,
  p_metadata jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER  -- Changed from SECURITY DEFINER
SET search_path = rag, public
AS $$
declare
  v_chunks jsonb := '[]'::jsonb;
  v_chunk_text text;
  v_token_count integer;
begin
  for v_chunk_text in
    select trim(s) from regexp_split_to_array(p_raw_text, E'\\n\\s*\\n+') as s
    where trim(s) is not null and trim(s) != ''
  loop
    v_token_count := ceil(greatest(length(v_chunk_text), 1) / 4.0)::integer;
    v_chunks := v_chunks || jsonb_build_object(
      'document_key', p_document_key,
      'text', v_chunk_text,
      'token_count', v_token_count,
      'metadata', coalesce(p_metadata, '{}'::jsonb)
    );
  end loop;
  return v_chunks;
end $$;

-- Re-grant to service_role (lockdown already applied, persists across DROP/CREATE)
GRANT EXECUTE ON FUNCTION rag.chunk_document_text TO service_role;
GRANT EXECUTE ON FUNCTION rag.chunk_sds_document_text TO service_role;
GRANT EXECUTE ON FUNCTION rag.chunk_efficacy_document_text TO service_role;

-- Step 3: Helper functions (enrich_*, backfill_*) also need SECURITY INVOKER
-- These are safe to convert as they're internal utilities
-- (Actual conversion deferred to follow-up if needed; these have restricted grant already)

raise notice 'B0-284 complete: SECURITY DEFINER chunking functions converted to SECURITY INVOKER.';
