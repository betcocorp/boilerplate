-- B0-804: refuse to chunk a non-English corpus, at the database level.
--
-- WHAT THIS FIXES
-- ---------------
-- `rag.document.language_code` currently holds EN 5140, ES 637, FR 158, IT 1. All 796
-- non-English rows are `document_kind = 'sds'` and none of them has a single
-- `rag.document_chunk` row, so today they are unreachable. Three gates keep them out:
--   1. no chunks exist for them;
--   2. all four retrieval RPCs -- rag.match_corpus_chunks, match_corpus_chunks_hybrid,
--      match_product_chunks and match_product_chunks_hybrid -- require
--      `upper(d.language_code) = 'EN'` AND `sr.is_active = true`;
--   3. rag.sync_sds_chunks / sync_efficacy_chunks / sync_legacy_product_profile_chunks
--      only chunk documents whose `upper(d.language_code)` equals the requested code.
--
-- Gate 3's language code is caller-supplied and, until now, unvalidated. Posting
-- `languageCode=FR` to the SDS sync admin action (or calling the RPC directly) would
-- chunk and embed all 158 French SDS. Gate 2 would still refuse to RETURN them, but
-- their vectors would enter the ANN candidate pool: match_corpus_chunks and the fast
-- branch of match_corpus_chunks_hybrid draw their top-N nearest neighbours BEFORE
-- applying the language / is_active filters, so foreign-language chunks silently consume
-- candidate slots and dilute English recall even while never being returned. That is
-- precisely the recall dilution 20260902150000_deactivate_foreign_language_sds_b0794.sql
-- had to clean up.
--
-- WHAT CHANGES
-- ------------
-- A few lines at the top of each function's BEGIN block that RAISE EXCEPTION when
-- p_language_code normalizes to anything other than 'EN'. Blank/NULL still means 'EN'
-- (each function already coalesces to it in its DECLARE section, and that line is
-- untouched), so normal operation is unchanged -- this is hardening, not a behaviour
-- change. Every other statement in every body is left exactly as it was: each function
-- below was rebuilt from its live `pg_get_functiondef` output, not retyped from an
-- earlier migration.
--
-- Additionally, `rag.get_current_efficacy_for_product` gains an
-- `upper(d.language_code) = 'EN'` predicate. It returns SETOF rag.document -- every
-- column, body_text included -- and its one caller
-- (src/lib/retrieval/efficacy-lab-report.ts) falls back to `summary ?? body_text` for
-- the citation excerpt precisely when a document has no chunks, which is exactly the
-- non-English condition. That excerpt becomes `sources[].documentBody`, reaching both
-- the regulated-claim guardrail and the model. This is LATENT, not live: there are
-- currently 0 non-EN `document_kind = 'efficacy'` documents (verified 2026-09-02;
-- B0-794's cleanup was scoped to SDS only), so nothing protects the efficacy corpus if a
-- French or Spanish lab report is ever ingested.
--
-- SIGNATURES / SECURITY / CONFIG: unchanged. Same argument names, types and DEFAULTs,
-- same return types, same SECURITY DEFINER (SECURITY INVOKER for
-- get_current_efficacy_for_product), same `SET search_path` and `SET statement_timeout`.
-- CREATE OR REPLACE preserves the existing ACL, so GRANTs are untouched -- note the two
-- families deliberately differ (sync_efficacy_chunks and get_current_efficacy_for_product
-- carry a PUBLIC EXECUTE grant; sync_sds_chunks and sync_legacy_product_profile_chunks
-- do not), and this migration must not level that.
--
-- The TypeScript half of this same invariant is `src/lib/rag/retrieval-language.ts`.
-- Widening the allowed set means re-deciding the match_* RPC language filters too.
--
-- IDEMPOTENT: CREATE OR REPLACE, re-running produces the same definitions.

-- ---------------------------------------------------------------------------
-- 1. rag.sync_sds_chunks(text, integer, integer)
-- ---------------------------------------------------------------------------
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
      chunk_key, document_id, chunk_index, section_path,
      heading, chunk_text, token_count, metadata
    )
    SELECT
      nc.chunk_key, nc.document_id, nc.chunk_index, nc.section_path,
      nc.heading, nc.chunk_text, nc.token_count, nc.chunk_metadata
    FROM rag_sds_new_chunks nc
    ON CONFLICT (chunk_key) DO UPDATE
      SET
        document_id   = excluded.document_id,
        chunk_index   = excluded.chunk_index,
        section_path  = excluded.section_path,
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
      'strategy',      'sds-section-aware',
      'max_chars',     p_max_chars,
      'overlap_chars', p_overlap_chars
    )
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. rag.sync_efficacy_chunks(text, integer, integer)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rag.sync_efficacy_chunks(p_language_code text DEFAULT 'EN'::text, p_max_chars integer DEFAULT 2200, p_overlap_chars integer DEFAULT 150)
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
      'B0-804: rag.sync_efficacy_chunks refuses language code %. The retrievable corpus is English-only -- chunking another language would put untranslated regulated text into the retrieval candidate pool. See src/lib/rag/retrieval-language.ts.',
      v_language_code
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

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

-- ---------------------------------------------------------------------------
-- 3. rag.sync_legacy_product_profile_chunks(text)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rag.sync_legacy_product_profile_chunks(p_language_code text DEFAULT 'EN'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'rag', 'public'
 SET statement_timeout TO '300s'
AS $function$
declare
  v_language_code text := upper(coalesce(nullif(trim(p_language_code), ''), 'EN'));
  v_document_limit integer := 100;
  v_documents_processed integer := 0;
  v_active_documents_processed integer := 0;
  v_inactive_documents_processed integer := 0;
  v_chunk_count integer := 0;
  v_stale_chunk_count integer := 0;
  v_inactive_chunk_count integer := 0;
  v_remaining_document_count integer := 0;

  -- Chunking settings (resolved once, totally: any failure falls back to the documented default).
  v_strategy text;
  v_min_tokens integer;
  v_max_tokens integer;
  v_overlap_tokens integer;
  v_max_chars integer;
  v_overlap_chars integer;

  -- heading-aware packer scratch
  v_doc record;
  v_sec record;
  v_unit_text text[];
  v_unit_tokens integer[];
  v_unit_break boolean[];
  v_unit_atomic boolean[];
  v_unit_sec_index integer[];
  v_unit_count integer;
  v_sec_tokens integer;
  v_is_heading boolean;
  v_pos integer;
  v_step integer;
  v_piece integer;
  v_piece_text text;
  v_i integer;
  v_j integer;
  v_out_index integer;
  v_buf_text text;
  v_buf_tokens integer;
  v_buf_first_raw text;
  v_buf_first_index integer;
  v_buf_is_heading boolean;
  v_heading_label text;
  v_chunk_text text;
  v_section_path text[];
begin
  -- B0-804 GUARD: the retrievable corpus is English-only. Blank/NULL already coalesced
  -- to 'EN' above; anything else is refused before a single row is chunked or embedded.
  if v_language_code <> 'EN' then
    raise exception
      'B0-804: rag.sync_legacy_product_profile_chunks refuses language code %. The retrievable corpus is English-only -- chunking another language would put untranslated regulated text into the retrieval candidate pool. See src/lib/rag/retrieval-language.ts.',
      v_language_code
      using errcode = 'invalid_parameter_value';
  end if;

  ---------------------------------------------------------------------------
  -- Resolve chunking settings. Never throws; a missing/invalid row uses the default.
  ---------------------------------------------------------------------------
  begin
    select lower(trim(s.value)) into v_strategy
    from public.settings s where s.key = 'RAG_CHUNK_STRATEGY';
  exception when others then v_strategy := null; end;
  if v_strategy is null or v_strategy not in ('naive', 'heading-aware') then
    v_strategy := 'naive';
  end if;

  begin
    select nullif(trim(s.value), '')::numeric::integer into v_min_tokens
    from public.settings s where s.key = 'RAG_CHUNK_MIN_TOKENS';
  exception when others then v_min_tokens := null; end;
  v_min_tokens := greatest(coalesce(v_min_tokens, 300), 1);

  begin
    select nullif(trim(s.value), '')::numeric::integer into v_max_tokens
    from public.settings s where s.key = 'RAG_CHUNK_MAX_TOKENS';
  exception when others then v_max_tokens := null; end;
  v_max_tokens := greatest(coalesce(v_max_tokens, 600), 1);
  if v_max_tokens < v_min_tokens then
    v_max_tokens := v_min_tokens;
  end if;

  begin
    select nullif(trim(s.value), '')::numeric::integer into v_overlap_tokens
    from public.settings s where s.key = 'RAG_CHUNK_OVERLAP_TOKENS';
  exception when others then v_overlap_tokens := null; end;
  v_overlap_tokens := greatest(coalesce(v_overlap_tokens, 50), 0);

  -- Token estimate is ceil(chars / 4), so the char budgets are the token budgets * 4.
  v_max_chars := v_max_tokens * 4;
  v_overlap_chars := least(v_overlap_tokens * 4, greatest(v_max_chars - 1, 0));

  ---------------------------------------------------------------------------
  -- Candidate documents for this batch (unchanged).
  ---------------------------------------------------------------------------
  drop table if exists pg_temp.rag_chunk_sync_candidates;

  create temporary table rag_chunk_sync_candidates
  on commit drop
  as
  with document_state as (
    select
      d.id as document_id,
      d.document_key,
      d.title,
      d.language_code,
      d.body_text,
      coalesce(d.metadata, '{}'::jsonb) as metadata,
      sr.is_active,
      d.updated_at as document_updated_at,
      count(dc.id)::integer as existing_chunk_count,
      max(dc.updated_at) as latest_chunk_updated_at,
      nullif(trim(d.body_text), '') is not null as has_chunkable_text
    from rag.document d
    join rag.source_record sr
      on sr.id = d.source_record_id
    left join rag.document_chunk dc
      on dc.document_id = d.id
    where d.document_kind = 'product_line_profile'
      and upper(d.language_code) = v_language_code
    group by
      d.id,
      d.document_key,
      d.title,
      d.language_code,
      d.body_text,
      d.metadata,
      sr.is_active,
      d.updated_at
  )
  select
    ds.document_id,
    ds.document_key,
    ds.title,
    ds.language_code,
    ds.body_text,
    ds.metadata,
    ds.is_active,
    ds.document_updated_at,
    ds.existing_chunk_count,
    ds.latest_chunk_updated_at,
    ds.has_chunkable_text
  from document_state ds
  where (
      ds.is_active
      and (
        (
          ds.has_chunkable_text
          and (
            ds.existing_chunk_count = 0
            or ds.latest_chunk_updated_at is null
            or ds.latest_chunk_updated_at < ds.document_updated_at
          )
        )
        or (
          not ds.has_chunkable_text
          and ds.existing_chunk_count > 0
        )
      )
    )
    or (
      not ds.is_active
      and ds.existing_chunk_count > 0
    )
  order by
    coalesce(ds.latest_chunk_updated_at, '-infinity'::timestamptz),
    ds.document_updated_at,
    ds.document_id
  limit v_document_limit;

  select
    count(*),
    count(*) filter (where is_active),
    count(*) filter (where not is_active)
  into
    v_documents_processed,
    v_active_documents_processed,
    v_inactive_documents_processed
  from rag_chunk_sync_candidates;

  ---------------------------------------------------------------------------
  -- SINGLE source of truth for the computed chunk set. Both the upsert below and the
  -- stale-delete read from this table, so the split is derived exactly once.
  ---------------------------------------------------------------------------
  drop table if exists pg_temp.rag_chunk_sync_computed;

  create temporary table rag_chunk_sync_computed (
    document_id uuid not null,
    chunk_key text not null,
    chunk_index integer not null,
    heading text,
    chunk_text text not null,
    token_count integer not null,
    section_path text[] not null,
    metadata jsonb not null
  ) on commit drop;

  if v_strategy = 'naive' then
    ---------------------------------------------------------------------------
    -- NAIVE: byte-identical to the pre-B0-686 implementation.
    ---------------------------------------------------------------------------
    with target_documents as (
      select
        c.document_id,
        c.document_key,
        c.title as document_title,
        c.language_code,
        c.body_text,
        c.metadata
      from rag_chunk_sync_candidates c
      where c.is_active = true
        and c.has_chunkable_text = true
    ),
    split_sections as (
      select
        td.document_id,
        td.document_key,
        td.document_title,
        td.language_code,
        td.metadata,
        section.ordinality - 1 as chunk_index,
        trim(section.section_text) as raw_chunk_text
      from target_documents td
      cross join lateral unnest(regexp_split_to_array(td.body_text, E'\\n\\s*\\n+'))
        with ordinality as section(section_text, ordinality)
      -- Skip empty sections and degenerate stubs (< 30 chars of raw content).
      where nullif(trim(section.section_text), '') is not null
        and length(trim(section.section_text)) >= 30
    ),
    -- Compute the final chunk_text before deriving token_count from it.
    prepared_raw as (
      select
        ss.document_id,
        concat(ss.document_key, ':chunk:', ss.chunk_index) as chunk_key,
        ss.chunk_index,
        ss.document_title,
        ss.language_code,
        ss.metadata,
        ss.raw_chunk_text,
        -- Heading: first chunk is always Overview; subsequent chunks whose first line
        -- matches the "Heading:" pattern get that line extracted as the heading.
        case
          when ss.chunk_index = 0 then 'Overview'
          when split_part(ss.raw_chunk_text, E'\n', 1) ~ '^[A-Za-z][A-Za-z0-9 /&()_-]*:$'
            then trim(trailing ':' from split_part(ss.raw_chunk_text, E'\n', 1))
          else null
        end as heading,
        -- chunk_text: overview keeps its text as-is (product name already present).
        -- Named sections: strip the heading line, then prepend "Product: {title}\n".
        -- Unnamed sections (variants, etc.): prepend "Product: {title}\n" directly.
        case
          when ss.chunk_index = 0
            then ss.raw_chunk_text
          when split_part(ss.raw_chunk_text, E'\n', 1) ~ '^[A-Za-z][A-Za-z0-9 /&()_-]*:$'
            and strpos(ss.raw_chunk_text, E'\n') > 0
            then concat(
              'Product: ', coalesce(ss.document_title, 'Unknown product'), E'\n',
              coalesce(
                nullif(trim(substring(ss.raw_chunk_text from strpos(ss.raw_chunk_text, E'\n') + 1)), ''),
                ss.raw_chunk_text
              )
            )
          else
            concat('Product: ', coalesce(ss.document_title, 'Unknown product'), E'\n', ss.raw_chunk_text)
        end as chunk_text,
        case
          when ss.chunk_index = 0 then array['product_line_profile', 'overview']::text[]
          when split_part(ss.raw_chunk_text, E'\n', 1) ~ '^[A-Za-z][A-Za-z0-9 /&()_-]*:$'
            then array[
              'product_line_profile',
              trim(both '_' from lower(
                regexp_replace(
                  trim(trailing ':' from split_part(ss.raw_chunk_text, E'\n', 1)),
                  '[^a-z0-9]+',
                  '_',
                  'gi'
                )
              ))
            ]::text[]
          else array['product_line_profile', concat('section_', ss.chunk_index::text)]::text[]
        end as section_path,
        ss.metadata || jsonb_strip_nulls(
          jsonb_build_object(
            'document_kind', 'product_line_profile',
            'language_code', ss.language_code,
            'chunk_index', ss.chunk_index,
            'section_heading',
              case
                when ss.chunk_index = 0 then 'Overview'
                when split_part(ss.raw_chunk_text, E'\n', 1) ~ '^[A-Za-z][A-Za-z0-9 /&()_-]*:$'
                  then trim(trailing ':' from split_part(ss.raw_chunk_text, E'\n', 1))
                else null
              end
          )
        ) as chunk_metadata
      from split_sections ss
    )
    insert into rag_chunk_sync_computed (
      document_id, chunk_key, chunk_index, heading, chunk_text, token_count, section_path, metadata
    )
    select
      pr.document_id,
      pr.chunk_key,
      pr.chunk_index,
      pr.heading,
      pr.chunk_text,
      -- Token count derived from the actual emitted chunk_text (including product prefix).
      ceil(greatest(length(pr.chunk_text), 1) / 4.0)::integer,
      pr.section_path,
      pr.chunk_metadata
    from prepared_raw pr;

  else
    ---------------------------------------------------------------------------
    -- HEADING-AWARE: same section split, then pack toward the token budget.
    ---------------------------------------------------------------------------
    for v_doc in
      select c.document_id, c.document_key, c.title, c.language_code, c.body_text, c.metadata
      from rag_chunk_sync_candidates c
      where c.is_active = true
        and c.has_chunkable_text = true
      order by c.document_id
    loop
      -- Phase A: expand sections into packable units. An oversized section becomes several
      -- atomic units (each already ~max_tokens), every other section is one mergeable unit.
      v_unit_text := array[]::text[];
      v_unit_tokens := array[]::integer[];
      v_unit_break := array[]::boolean[];
      v_unit_atomic := array[]::boolean[];
      v_unit_sec_index := array[]::integer[];

      for v_sec in
        select (section.ordinality - 1)::integer as sec_index,
               trim(section.section_text) as raw_chunk_text
        from unnest(regexp_split_to_array(v_doc.body_text, E'\\n\\s*\\n+'))
          with ordinality as section(section_text, ordinality)
        where nullif(trim(section.section_text), '') is not null
          and length(trim(section.section_text)) >= 30
        order by section.ordinality
      loop
        v_sec_tokens := ceil(greatest(length(v_sec.raw_chunk_text), 1) / 4.0)::integer;
        v_is_heading := split_part(v_sec.raw_chunk_text, E'\n', 1) ~ '^[A-Za-z][A-Za-z0-9 /&()_-]*:$';

        if v_sec_tokens > v_max_tokens then
          v_pos := 1;
          v_piece := 0;
          while v_pos <= length(v_sec.raw_chunk_text) loop
            if v_piece = 0 then
              v_step := v_max_chars;
              v_piece_text := substr(v_sec.raw_chunk_text, v_pos, v_step);
            else
              v_step := greatest(v_max_chars - v_overlap_chars, 1);
              v_piece_text := case
                when v_overlap_chars > 0
                  then substr(v_sec.raw_chunk_text, greatest(v_pos - v_overlap_chars, 1), v_overlap_chars)
                       || substr(v_sec.raw_chunk_text, v_pos, v_step)
                else substr(v_sec.raw_chunk_text, v_pos, v_step)
              end;
            end if;

            v_unit_text := v_unit_text || v_piece_text;
            v_unit_tokens := v_unit_tokens || ceil(greatest(length(v_piece_text), 1) / 4.0)::integer;
            v_unit_break := v_unit_break || true;
            v_unit_atomic := v_unit_atomic || true;
            v_unit_sec_index := v_unit_sec_index || v_sec.sec_index;

            v_pos := v_pos + v_step;
            v_piece := v_piece + 1;
          end loop;
        else
          v_unit_text := v_unit_text || v_sec.raw_chunk_text;
          v_unit_tokens := v_unit_tokens || v_sec_tokens;
          -- A heading section always starts a new chunk: never merge across a heading boundary.
          v_unit_break := v_unit_break || v_is_heading;
          v_unit_atomic := v_unit_atomic || false;
          v_unit_sec_index := v_unit_sec_index || v_sec.sec_index;
        end if;
      end loop;

      -- Phase B: pack units into chunks.
      v_unit_count := coalesce(array_length(v_unit_text, 1), 0);
      v_i := 1;
      v_out_index := 0;

      while v_i <= v_unit_count loop
        v_buf_text := v_unit_text[v_i];
        v_buf_tokens := v_unit_tokens[v_i];
        v_buf_first_raw := v_unit_text[v_i];
        v_buf_first_index := v_unit_sec_index[v_i];
        v_j := v_i + 1;

        if not v_unit_atomic[v_i] then
          -- Accumulate until the running estimate reaches min_tokens, never crossing max_tokens
          -- and never merging across a heading boundary or into an oversized-section piece.
          while v_j <= v_unit_count
            and not v_unit_break[v_j]
            and not v_unit_atomic[v_j]
            and v_buf_tokens < v_min_tokens
            and (v_buf_tokens + v_unit_tokens[v_j]) <= v_max_tokens
          loop
            v_buf_text := v_buf_text || E'\n\n' || v_unit_text[v_j];
            v_buf_tokens := v_buf_tokens + v_unit_tokens[v_j];
            v_j := v_j + 1;
          end loop;
        end if;

        -- heading / section_path / metadata derive from the FIRST constituent section.
        v_buf_is_heading := split_part(v_buf_first_raw, E'\n', 1) ~ '^[A-Za-z][A-Za-z0-9 /&()_-]*:$';

        v_heading_label := case
          when v_out_index = 0 then 'Overview'
          when v_buf_is_heading then trim(trailing ':' from split_part(v_buf_first_raw, E'\n', 1))
          else null
        end;

        v_chunk_text := case
          when v_out_index = 0
            then v_buf_text
          when v_buf_is_heading and strpos(v_buf_text, E'\n') > 0
            then concat(
              'Product: ', coalesce(v_doc.title, 'Unknown product'), E'\n',
              coalesce(
                nullif(trim(substring(v_buf_text from strpos(v_buf_text, E'\n') + 1)), ''),
                v_buf_text
              )
            )
          else
            concat('Product: ', coalesce(v_doc.title, 'Unknown product'), E'\n', v_buf_text)
        end;

        v_section_path := case
          when v_out_index = 0 then array['product_line_profile', 'overview']::text[]
          when v_buf_is_heading then array[
            'product_line_profile',
            trim(both '_' from lower(
              regexp_replace(
                trim(trailing ':' from split_part(v_buf_first_raw, E'\n', 1)),
                '[^a-z0-9]+',
                '_',
                'gi'
              )
            ))
          ]::text[]
          else array['product_line_profile', concat('section_', v_buf_first_index::text)]::text[]
        end;

        insert into rag_chunk_sync_computed (
          document_id, chunk_key, chunk_index, heading, chunk_text, token_count, section_path, metadata
        )
        values (
          v_doc.document_id,
          concat(v_doc.document_key, ':chunk:', v_out_index),
          v_out_index,
          v_heading_label,
          v_chunk_text,
          ceil(greatest(length(v_chunk_text), 1) / 4.0)::integer,
          v_section_path,
          coalesce(v_doc.metadata, '{}'::jsonb) || jsonb_strip_nulls(
            jsonb_build_object(
              'document_kind', 'product_line_profile',
              'language_code', v_doc.language_code,
              'chunk_index', v_out_index,
              'section_heading', v_heading_label
            )
          )
        );

        v_out_index := v_out_index + 1;
        v_i := v_j;
      end loop;
    end loop;
  end if;

  create index on rag_chunk_sync_computed (document_id, chunk_key);
  analyze rag_chunk_sync_computed;

  ---------------------------------------------------------------------------
  -- Upsert from the single computed set.
  ---------------------------------------------------------------------------
  with upserted as (
    insert into rag.document_chunk (
      chunk_key,
      document_id,
      chunk_index,
      section_path,
      heading,
      chunk_text,
      token_count,
      metadata
    )
    select
      p.chunk_key,
      p.document_id,
      p.chunk_index,
      p.section_path,
      p.heading,
      p.chunk_text,
      p.token_count,
      p.metadata
    from rag_chunk_sync_computed p
    on conflict (chunk_key)
    do update
      set document_id = excluded.document_id,
          chunk_index = excluded.chunk_index,
          section_path = excluded.section_path,
          heading = excluded.heading,
          chunk_text = excluded.chunk_text,
          token_count = excluded.token_count,
          embedding_model_large = case
            when rag.document_chunk.heading is distinct from excluded.heading
              or rag.document_chunk.chunk_text is distinct from excluded.chunk_text
              then null
            else rag.document_chunk.embedding_model_large
          end,
          embedding_large = case
            when rag.document_chunk.heading is distinct from excluded.heading
              or rag.document_chunk.chunk_text is distinct from excluded.chunk_text
              then null
            else rag.document_chunk.embedding_large
          end,
          metadata = excluded.metadata
    returning 1
  )
  select count(*) into v_chunk_count
  from upserted;

  -- Stale deletion: remove chunks of active candidate documents whose keys are not in the
  -- computed set. Reads the SAME temp table as the upsert above — there is no second derivation.
  delete from rag.document_chunk dc
  where exists (
      select 1
      from rag_chunk_sync_candidates c
      where c.document_id = dc.document_id
        and c.is_active = true
    )
    and not exists (
      select 1
      from rag_chunk_sync_computed ec
      where ec.document_id = dc.document_id
        and ec.chunk_key = dc.chunk_key
    );

  get diagnostics v_stale_chunk_count = row_count;

  delete from rag.document_chunk dc
  using rag_chunk_sync_candidates c
  where c.document_id = dc.document_id
    and c.is_active = false;

  get diagnostics v_inactive_chunk_count = row_count;

  with document_state as (
    select
      d.id as document_id,
      sr.is_active,
      d.updated_at as document_updated_at,
      count(dc.id)::integer as existing_chunk_count,
      max(dc.updated_at) as latest_chunk_updated_at,
      nullif(trim(d.body_text), '') is not null as has_chunkable_text
    from rag.document d
    join rag.source_record sr
      on sr.id = d.source_record_id
    left join rag.document_chunk dc
      on dc.document_id = d.id
    where d.document_kind = 'product_line_profile'
      and upper(d.language_code) = v_language_code
    group by
      d.id,
      sr.is_active,
      d.updated_at,
      d.body_text
  )
  select count(*) into v_remaining_document_count
  from document_state ds
  where (
      ds.is_active
      and (
        (
          ds.has_chunkable_text
          and (
            ds.existing_chunk_count = 0
            or ds.latest_chunk_updated_at is null
            or ds.latest_chunk_updated_at < ds.document_updated_at
          )
        )
        or (
          not ds.has_chunkable_text
          and ds.existing_chunk_count > 0
        )
      )
    )
    or (
      not ds.is_active
      and ds.existing_chunk_count > 0
    );

  return jsonb_build_object(
    'language_code', v_language_code,
    'batch_limit', v_document_limit,
    'documents_processed', v_documents_processed,
    'active_documents_processed', v_active_documents_processed,
    'inactive_documents_processed', v_inactive_documents_processed,
    'chunks_upserted', v_chunk_count,
    'stale_chunks_deleted', v_stale_chunk_count,
    'inactive_chunks_deleted', v_inactive_chunk_count,
    'remaining_documents', v_remaining_document_count,
    'has_more', v_remaining_document_count > 0
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. rag.get_current_efficacy_for_product(text) -- add the missing language predicate.
--    SECURITY INVOKER (prosecdef = false) and STABLE, exactly as before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rag.get_current_efficacy_for_product(p_product_line_key text)
 RETURNS SETOF rag.document
 LANGUAGE sql
 STABLE
 SET search_path TO 'rag', 'public'
AS $function$
  select d.*
  from rag.document d
  join rag.efficacy_formula_product efp
    on efp.formula_code = coalesce(d.metadata ->> 'formula_code', '')
   and efp.is_active = true
  where d.document_kind = 'efficacy'
    and d.is_current = true
    and d.lifecycle_status = 'active'
    -- B0-804: this function returns SETOF rag.document -- body_text included -- and its
    -- caller falls back to that raw body for a citation excerpt when the document has no
    -- chunks, which is exactly the non-English condition. Latent today (0 non-EN efficacy
    -- documents as of 2026-09-02); this keeps it that way.
    and upper(d.language_code) = 'EN'
    and efp.product_line_key = p_product_line_key;
$function$;
