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
  v_chunk_count integer := 0;
  v_stale_chunk_count integer := 0;
  v_inactive_chunk_count integer := 0;
begin
  with target_documents as (
    select
      d.id as document_id,
      d.document_key,
      d.language_code,
      d.body_text,
      coalesce(d.metadata, '{}'::jsonb) as metadata
    from rag.document d
    join rag.source_record sr
      on sr.id = d.source_record_id
    where d.document_kind = 'product_profile'
      and upper(d.language_code) = v_language_code
      and sr.is_active = true
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
        when ss.chunk_index = 0 then array['product_profile', 'overview']::text[]
        when split_part(ss.raw_chunk_text, E'\n', 1) ~ '^[A-Za-z][A-Za-z0-9 /&()_-]*:$'
          then array[
            'product_profile',
            trim(both '_' from lower(
              regexp_replace(
                trim(trailing ':' from split_part(ss.raw_chunk_text, E'\n', 1)),
                '[^a-z0-9]+',
                '_',
                'gi'
              )
            ))
          ]::text[]
        else array['product_profile', concat('section_', ss.chunk_index::text)]::text[]
      end as section_path,
      ss.metadata || jsonb_strip_nulls(
        jsonb_build_object(
          'document_kind', 'product_profile',
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
          metadata = excluded.metadata
    returning 1
  )
  select count(*) into v_chunk_count
  from upserted;

  with target_documents as (
    select
      d.id as document_id,
      d.document_key,
      d.body_text
    from rag.document d
    join rag.source_record sr
      on sr.id = d.source_record_id
    where d.document_kind = 'product_profile'
      and upper(d.language_code) = v_language_code
      and sr.is_active = true
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
      from target_documents td
      where td.document_id = dc.document_id
    )
    and not exists (
      select 1
      from expected_chunks ec
      where ec.document_id = dc.document_id
        and ec.chunk_key = dc.chunk_key
    );

  get diagnostics v_stale_chunk_count = row_count;

  delete from rag.document_chunk dc
  using rag.document d, rag.source_record sr
  where dc.document_id = d.id
    and sr.id = d.source_record_id
    and d.document_kind = 'product_profile'
    and upper(d.language_code) = v_language_code
    and sr.is_active = false;

  get diagnostics v_inactive_chunk_count = row_count;

  return jsonb_build_object(
    'language_code', v_language_code,
    'chunks_upserted', v_chunk_count,
    'stale_chunks_deleted', v_stale_chunk_count,
    'inactive_chunks_deleted', v_inactive_chunk_count
  );
end;
$$;

grant execute on function rag.sync_legacy_product_profile_chunks(text) to service_role;

comment on function rag.sync_legacy_product_profile_chunks(text) is
  'Splits active legacy-derived product profile documents into deterministic retrieval chunks and clears stale embeddings when chunk text changes.';
