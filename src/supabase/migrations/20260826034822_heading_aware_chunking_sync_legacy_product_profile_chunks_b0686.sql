-- B0-686 — rag.sync_legacy_product_profile_chunks: settings-driven chunking strategy.
--
-- WHAT CHANGED
--   1. The function now reads RAG_CHUNK_STRATEGY / RAG_CHUNK_MIN_TOKENS / RAG_CHUNK_MAX_TOKENS /
--      RAG_CHUNK_OVERLAP_TOKENS from public.settings (it is already SECURITY DEFINER, so RLS is
--      not an obstacle) and branches:
--        * 'naive' (default) — behaviour identical to the previous implementation: split on
--          E'\n\s*\n+', drop sections under 30 chars, one chunk per surviving section keyed
--          {document_key}:chunk:{ordinality-1} (gaps preserved), 'Product: {title}\n' prefixing,
--          'Heading:'-style first-line extraction, ceil(length/4.0) token estimate.
--        * 'heading-aware' — the same section split, then consecutive sections are PACKED toward
--          the token budget: accumulate until the running estimate reaches min_tokens, never
--          exceeding max_tokens, and never merging across a heading boundary (a section whose
--          first line matches ^[A-Za-z][A-Za-z0-9 /&()_-]*:$ always starts a new chunk). A single
--          section larger than max_tokens is split into several chunks, each carrying
--          overlap_tokens worth of trailing text from the previous piece as a prefix. The emitted
--          chunk's heading / section_path / metadata are derived from its FIRST constituent
--          section; chunk 0 stays 'Overview'.
--
--   2. THE LANDMINE: the previous implementation derived the split TWICE — once in the
--      prepared/upsert CTE chain and again in a separate `expected_chunks` CTE inside the
--      stale-delete. Changing the packer without changing the delete would make a single call
--      delete every row it had just inserted. Both now read from ONE materialised temp table,
--      pg_temp.rag_chunk_sync_computed, so the chunking logic exists exactly once.
--
--   3. PRE-EXISTING BUG FIXED (required for the function to run at all): the ON CONFLICT clause
--      still nulled `embedding` and `embedding_model`, two columns that were dropped from
--      rag.document_chunk. Every invocation therefore failed with
--      42703 "column document_chunk.embedding_model does not exist". Only the surviving
--      `embedding_large` / `embedding_model_large` are nulled on heading/chunk_text change.
--
-- UNCHANGED: SECURITY DEFINER, search_path, statement_timeout 300s, the 100-document batch limit,
-- the candidate-selection predicates, inactive-document chunk cleanup, the get diagnostics
-- counters, the remaining_documents/has_more recomputation, and the exact return shape.

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

-- Grants unchanged from 20260722061000_rag_security_lockdown_rpc_grants_search_path. CREATE OR
-- REPLACE preserves the existing ACL, but restate it so a fresh rebuild reproduces the lockdown.
revoke execute on function rag.sync_legacy_product_profile_chunks(text) from public, anon, authenticated;
grant execute on function rag.sync_legacy_product_profile_chunks(text) to service_role;
