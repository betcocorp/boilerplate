-- Adds halfvec(3072) columns for text-embedding-3-large dual-write cutover.
-- Step 1: add columns + HNSW index + v2 match RPC.
-- Step 2 (swap search callers + drop old column) happens after recall validation.

-- ── document_chunk: add large embedding columns ─────────────────────────────

alter table rag.document_chunk
  add column if not exists embedding_large extensions.halfvec(3072),
  add column if not exists embedding_model_large text;

-- ── HNSW index on embedding_large ────────────────────────────────────────────

create index if not exists document_chunk_embedding_large_hnsw_idx
  on rag.document_chunk
  using hnsw (embedding_large extensions.halfvec_cosine_ops)
  where embedding_large is not null;

-- ── search_embedding cache: add large embedding column ───────────────────────

alter table rag.search_embedding
  add column if not exists embeddings_large extensions.halfvec(3072);

-- ── Update chunk sync to null large embedding on content change ───────────────
-- Replaces sync_legacy_product_profile_chunks from 20260406150000 with the
-- same body plus embedding_large / embedding_model_large in the on-conflict clause.

create or replace function rag.sync_legacy_product_profile_chunks(
  p_language_code text default 'EN'
)
returns jsonb
language plpgsql
security definer
set search_path = rag, public
as $$
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
begin
  drop table if exists pg_temp.rag_chunk_sync_candidates;

  create temporary table rag_chunk_sync_candidates
  on commit drop
  as
  with document_state as (
    select
      d.id as document_id,
      d.document_key,
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
      d.language_code,
      d.body_text,
      d.metadata,
      sr.is_active,
      d.updated_at
  )
  select
    ds.document_id,
    ds.document_key,
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

  with target_documents as (
    select
      c.document_id,
      c.document_key,
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
      td.language_code,
      td.metadata,
      section.ordinality - 1 as chunk_index,
      trim(section.section_text) as raw_chunk_text
    from target_documents td
    cross join lateral unnest(regexp_split_to_array(td.body_text, E'\\n\\s*\\n+'))
      with ordinality as section(section_text, ordinality)
    where nullif(trim(section.section_text), '') is not null
  ),
  prepared as (
    select
      ss.document_id,
      concat(ss.document_key, ':chunk:', ss.chunk_index) as chunk_key,
      ss.chunk_index,
      case
        when ss.chunk_index = 0 then 'Overview'
        when split_part(ss.raw_chunk_text, E'\n', 1) ~ '^[A-Za-z][A-Za-z0-9 /&()_-]*:$'
          then trim(trailing ':' from split_part(ss.raw_chunk_text, E'\n', 1))
        else null
      end as heading,
      case
        when ss.chunk_index > 0
          and split_part(ss.raw_chunk_text, E'\n', 1) ~ '^[A-Za-z][A-Za-z0-9 /&()_-]*:$'
          and strpos(ss.raw_chunk_text, E'\n') > 0
          then coalesce(
            nullif(trim(substring(ss.raw_chunk_text from strpos(ss.raw_chunk_text, E'\n') + 1)), ''),
            ss.raw_chunk_text
          )
        else ss.raw_chunk_text
      end as chunk_text,
      ceil(greatest(length(ss.raw_chunk_text), 1) / 4.0)::integer as token_count,
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
      ) as metadata
    from split_sections ss
  ),
  upserted as (
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
    from prepared p
    on conflict (chunk_key)
    do update
      set document_id = excluded.document_id,
          chunk_index = excluded.chunk_index,
          section_path = excluded.section_path,
          heading = excluded.heading,
          chunk_text = excluded.chunk_text,
          token_count = excluded.token_count,
          embedding_model = case
            when rag.document_chunk.heading is distinct from excluded.heading
              or rag.document_chunk.chunk_text is distinct from excluded.chunk_text
              then null
            else rag.document_chunk.embedding_model
          end,
          embedding = case
            when rag.document_chunk.heading is distinct from excluded.heading
              or rag.document_chunk.chunk_text is distinct from excluded.chunk_text
              then null
            else rag.document_chunk.embedding
          end,
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

  with target_documents as (
    select
      c.document_id,
      c.document_key,
      c.body_text
    from rag_chunk_sync_candidates c
    where c.is_active = true
  ),
  expected_chunks as (
    select
      td.document_id,
      concat(td.document_key, ':chunk:', section.ordinality - 1) as chunk_key
    from target_documents td
    cross join lateral unnest(regexp_split_to_array(td.body_text, E'\\n\\s*\\n+'))
      with ordinality as section(section_text, ordinality)
    where nullif(trim(section.section_text), '') is not null
  )
  delete from rag.document_chunk dc
  where exists (
      select 1
      from rag_chunk_sync_candidates c
      where c.document_id = dc.document_id
        and c.is_active = true
    )
    and not exists (
      select 1
      from expected_chunks ec
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
$$;

comment on function rag.sync_legacy_product_profile_chunks(text) is
  'Chunks product_line_profile documents; nulls embedding_large/embedding_model_large on content change alongside embedding/embedding_model.';

-- ── match_product_chunks_v2: halfvec(3072) ANN search ────────────────────────

create or replace function rag.match_product_chunks_v2(
  query_embedding extensions.halfvec(3072),
  match_count integer default 10,
  filter_product_key text default null,
  filter_product_line_key text default null
)
returns table (
  chunk_id uuid,
  chunk_key text,
  chunk_index integer,
  heading text,
  chunk_text text,
  section_path text[],
  token_count integer,
  document_id uuid,
  document_key text,
  document_title text,
  entity_id uuid,
  product_key text,
  sku text,
  product_line_key text,
  source_pk text,
  similarity double precision
)
language sql
stable
set search_path = rag, extensions, public
set statement_timeout = '120s'
as $$
  with ann_candidates as materialized (
    select dc_ann.id as chunk_id
    from rag.document_chunk dc_ann
    where dc_ann.embedding_large is not null
    order by dc_ann.embedding_large <=> query_embedding
    limit least(
      20000,
      greatest(
        400,
        greatest(coalesce(match_count, 10), 1) * 120
      )
    )
  )
  select
    dc.id as chunk_id,
    dc.chunk_key,
    dc.chunk_index,
    dc.heading,
    dc.chunk_text,
    dc.section_path,
    dc.token_count,
    d.id as document_id,
    d.document_key,
    d.title as document_title,
    e.id as entity_id,
    e.product_key,
    e.sku,
    e.product_line_key,
    sr.source_pk,
    1 - (dc.embedding_large <=> query_embedding) as similarity
  from ann_candidates ac
  join rag.document_chunk dc
    on dc.id = ac.chunk_id
  join rag.document d
    on d.id = dc.document_id
  join rag.source_record sr
    on sr.id = d.source_record_id
  left join rag.entity e
    on e.id = d.entity_id
  where d.document_kind = 'product_line_profile'
    and d.language_code = 'EN'
    and sr.is_active = true
    and (
      nullif(trim(filter_product_key), '') is null
      or e.product_key = nullif(trim(filter_product_key), '')
      or coalesce(d.metadata->'variant_product_keys', '[]'::jsonb)
        @> to_jsonb(nullif(trim(filter_product_key), ''))
    )
    and (
      nullif(trim(filter_product_line_key), '') is null
      or e.product_line_key = nullif(trim(filter_product_line_key), '')
      or sr.source_pk = nullif(trim(filter_product_line_key), '')
    )
  order by dc.embedding_large <=> query_embedding
  limit greatest(coalesce(match_count, 10), 1);
$$;

comment on function rag.match_product_chunks_v2(
  extensions.halfvec(3072),
  integer,
  text,
  text
) is
  'ANN-first search over product_line_profile chunks using halfvec(3072) / text-embedding-3-large. Drop-in replacement for match_product_chunks after recall validation.';

grant execute on function rag.match_product_chunks_v2(
  extensions.halfvec(3072),
  integer,
  text,
  text
) to service_role;
