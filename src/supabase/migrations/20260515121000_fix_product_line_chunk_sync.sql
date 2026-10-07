-- Improve sync_legacy_product_profile_chunks:
--   1. Inject "Product: {title}\n" prefix into every non-overview chunk so retrieved
--      chunks are self-identifying when the LLM sees them without their parent document.
--   2. Filter degenerate chunks whose raw text is < 30 chars (eliminates standalone
--      section headers, bare URL stubs like "- betcodocs/", and test artefacts).
--      Applied identically to the upsert and the expected_chunks stale-deletion set
--      so previously-inserted degenerate chunks are cleaned up on the next sync run.
--   3. Derive token_count from the actual emitted chunk_text (post-prefix) instead of
--      the raw section text, giving accurate estimates for context budgeting.

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
  ),
  prepared as (
    select
      pr.document_id,
      pr.chunk_key,
      pr.chunk_index,
      pr.heading,
      pr.chunk_text,
      -- Token count derived from the actual emitted chunk_text (including product prefix).
      ceil(greatest(length(pr.chunk_text), 1) / 4.0)::integer as token_count,
      pr.section_path,
      pr.chunk_metadata as metadata
    from prepared_raw pr
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

  -- Stale deletion: remove chunks whose keys no longer appear in the expected set.
  -- Apply the same >= 30 char filter so previously-inserted degenerate chunks are removed.
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
      and length(trim(section.section_text)) >= 30
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
  'Chunks product_line_profile documents into retrieval-ready sections. Non-overview chunks carry a "Product: {title}" prefix for self-contained retrieval. Degenerate chunks (< 30 chars) are filtered out.';

grant execute on function rag.sync_legacy_product_profile_chunks(text) to service_role;
