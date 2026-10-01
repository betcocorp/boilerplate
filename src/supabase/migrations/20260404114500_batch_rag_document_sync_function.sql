create or replace function rag.sync_legacy_product_profiles(
  p_language_code text default 'EN'
)
returns jsonb
language plpgsql
security definer
set search_path = rag, legacy, public
as $$
declare
  v_language_code text := upper(coalesce(nullif(trim(p_language_code), ''), 'EN'));
  v_batch_limit integer := 100;
  v_source_rows_processed integer := 0;
  v_source_count integer := 0;
  v_entity_count integer := 0;
  v_document_count integer := 0;
  v_deactivated_count integer := 0;
  v_remaining_source_rows integer := 0;
  v_remaining_deactivations integer := 0;
begin
  drop table if exists pg_temp.rag_profile_sync_candidates;
  drop table if exists pg_temp.rag_profile_deactivate_candidates;

  create temporary table rag_profile_sync_candidates
  on commit drop
  as
  with source_rows as (
    select
      lpps.source_schema,
      lpps.source_table,
      lpps.source_pk,
      upper(lpps.language_code) as language_code,
      lpps.source_type,
      lpps.document_key,
      lpps.entity_type,
      lpps.entity_key,
      lpps.title,
      lpps.body_text,
      lpps.sku,
      lpps.product_line_key,
      md5(coalesce(lpps.body_text, '')) as checksum,
      lpps.metadata,
      row_number() over (
        partition by lpps.source_schema, lpps.source_table, lpps.source_pk, upper(lpps.language_code)
        order by length(coalesce(lpps.body_text, '')) desc,
                 length(coalesce(lpps.title, '')) desc,
                 lpps.document_key
      ) as source_row_num,
      row_number() over (
        partition by lpps.entity_type, lpps.entity_key
        order by length(coalesce(lpps.body_text, '')) desc,
                 length(coalesce(lpps.title, '')) desc,
                 lpps.document_key
      ) as entity_row_num,
      row_number() over (
        partition by lpps.document_key
        order by length(coalesce(lpps.body_text, '')) desc,
                 length(coalesce(lpps.title, '')) desc
      ) as document_row_num
    from rag.legacy_product_profile_source lpps
    where upper(lpps.language_code) = v_language_code
  ),
  pending_rows as (
    select
      sr.*,
      existing_source_record.updated_at as source_record_updated_at,
      existing_entity.updated_at as entity_updated_at,
      existing_document.updated_at as document_updated_at
    from source_rows sr
    left join rag.source_record existing_source_record
      on existing_source_record.source_schema = sr.source_schema
     and existing_source_record.source_table = sr.source_table
     and existing_source_record.source_pk = sr.source_pk
     and existing_source_record.source_locale = sr.language_code
    left join rag.entity existing_entity
      on existing_entity.entity_type = sr.entity_type
     and existing_entity.canonical_key = sr.entity_key
    left join rag.document existing_document
      on existing_document.document_key = sr.document_key
    where sr.source_row_num = 1
      and (
        existing_source_record.id is null
        or existing_source_record.source_type is distinct from sr.source_type
        or existing_source_record.checksum is distinct from sr.checksum
        or existing_source_record.is_active is distinct from true
        or existing_source_record.metadata is distinct from sr.metadata
        or existing_entity.id is null
        or existing_entity.title is distinct from sr.title
        or existing_entity.sku is distinct from sr.sku
        or existing_entity.product_key is distinct from sr.source_pk
        or existing_entity.product_line_key is distinct from sr.product_line_key
        or existing_entity.metadata is distinct from sr.metadata
        or existing_document.id is null
        or existing_document.title is distinct from sr.title
        or upper(coalesce(existing_document.language_code, '')) is distinct from sr.language_code
        or existing_document.body_text is distinct from sr.body_text
        or existing_document.metadata is distinct from sr.metadata
        or existing_document.document_kind is distinct from 'product_profile'
      )
  )
  select
    pr.source_schema,
    pr.source_table,
    pr.source_pk,
    pr.language_code,
    pr.source_type,
    pr.document_key,
    pr.entity_type,
    pr.entity_key,
    pr.title,
    pr.body_text,
    pr.sku,
    pr.product_line_key,
    pr.checksum,
    pr.metadata,
    pr.source_row_num,
    pr.entity_row_num,
    pr.document_row_num
  from pending_rows pr
  order by
    coalesce(
      least(
        coalesce(pr.source_record_updated_at, 'infinity'::timestamptz),
        coalesce(pr.entity_updated_at, 'infinity'::timestamptz),
        coalesce(pr.document_updated_at, 'infinity'::timestamptz)
      ),
      '-infinity'::timestamptz
    ),
    pr.document_key
  limit v_batch_limit;

  select count(*) into v_source_rows_processed
  from rag_profile_sync_candidates;

  with source_rows as (
    select
      c.source_schema,
      c.source_table,
      c.source_pk,
      c.language_code,
      c.source_type,
      c.checksum,
      c.metadata
    from rag_profile_sync_candidates c
    where c.source_row_num = 1
  ),
  upserted as (
    insert into rag.source_record (
      source_schema,
      source_table,
      source_pk,
      source_locale,
      source_type,
      checksum,
      is_active,
      last_seen_at,
      metadata
    )
    select
      sr.source_schema,
      sr.source_table,
      sr.source_pk,
      sr.language_code,
      sr.source_type,
      sr.checksum,
      true,
      timezone('utc', now()),
      sr.metadata
    from source_rows sr
    on conflict on constraint source_record_identity_key
    do update
      set source_type = excluded.source_type,
          checksum = excluded.checksum,
          is_active = true,
          last_seen_at = excluded.last_seen_at,
          metadata = excluded.metadata
    returning 1
  )
  select count(*) into v_source_count
  from upserted;

  with entity_rows as (
    select
      c.entity_type,
      c.entity_key,
      c.title,
      c.sku,
      c.source_pk as product_key,
      c.product_line_key,
      c.metadata
    from rag_profile_sync_candidates c
    where c.entity_row_num = 1
  ),
  upserted as (
    insert into rag.entity (
      entity_type,
      canonical_key,
      title,
      sku,
      product_key,
      product_line_key,
      metadata
    )
    select
      er.entity_type,
      er.entity_key,
      er.title,
      er.sku,
      er.product_key,
      er.product_line_key,
      er.metadata
    from entity_rows er
    on conflict on constraint entity_identity_key
    do update
      set title = excluded.title,
          sku = excluded.sku,
          product_key = excluded.product_key,
          product_line_key = excluded.product_line_key,
          metadata = excluded.metadata
    returning 1
  )
  select count(*) into v_entity_count
  from upserted;

  with document_rows as (
    select
      c.document_key,
      c.source_schema,
      c.source_table,
      c.source_pk,
      c.language_code,
      c.entity_type,
      c.entity_key,
      c.title,
      c.body_text,
      c.metadata
    from rag_profile_sync_candidates c
    where c.document_row_num = 1
  ),
  resolved as (
    select
      dr.document_key,
      sr.id as source_record_id,
      e.id as entity_id,
      dr.title,
      dr.language_code,
      dr.body_text,
      dr.metadata
    from document_rows dr
    join rag.source_record sr
      on sr.source_schema = dr.source_schema
     and sr.source_table = dr.source_table
     and sr.source_pk = dr.source_pk
     and sr.source_locale = dr.language_code
    left join rag.entity e
      on e.entity_type = dr.entity_type
     and e.canonical_key = dr.entity_key
  ),
  upserted as (
    insert into rag.document (
      document_key,
      source_record_id,
      entity_id,
      document_kind,
      title,
      language_code,
      body_text,
      metadata
    )
    select
      r.document_key,
      r.source_record_id,
      r.entity_id,
      'product_profile',
      r.title,
      r.language_code,
      r.body_text,
      r.metadata
    from resolved r
    on conflict (document_key)
    do update
      set source_record_id = excluded.source_record_id,
          entity_id = excluded.entity_id,
          document_kind = excluded.document_kind,
          title = excluded.title,
          language_code = excluded.language_code,
          body_text = excluded.body_text,
          metadata = excluded.metadata
    returning 1
  )
  select count(*) into v_document_count
  from upserted;

  create temporary table rag_profile_deactivate_candidates
  on commit drop
  as
  select
    sr.id,
    sr.source_pk
  from rag.source_record sr
  where sr.source_schema = 'legacy'
    and sr.source_table = 'products'
    and sr.source_type = 'product_profile'
    and sr.source_locale = v_language_code
    and sr.is_active = true
    and not exists (
      select 1
      from rag.legacy_product_profile_source lpps
      where upper(lpps.language_code) = v_language_code
        and lpps.source_pk = sr.source_pk
    )
  order by sr.updated_at, sr.id
  limit v_batch_limit;

  update rag.source_record sr
     set is_active = false,
         last_seen_at = timezone('utc', now())
    from rag_profile_deactivate_candidates dc
   where dc.id = sr.id;

  get diagnostics v_deactivated_count = row_count;

  with source_rows as (
    select
      lpps.source_schema,
      lpps.source_table,
      lpps.source_pk,
      upper(lpps.language_code) as language_code,
      lpps.source_type,
      lpps.document_key,
      lpps.entity_type,
      lpps.entity_key,
      lpps.title,
      lpps.body_text,
      lpps.sku,
      lpps.product_line_key,
      md5(coalesce(lpps.body_text, '')) as checksum,
      lpps.metadata,
      row_number() over (
        partition by lpps.source_schema, lpps.source_table, lpps.source_pk, upper(lpps.language_code)
        order by length(coalesce(lpps.body_text, '')) desc,
                 length(coalesce(lpps.title, '')) desc,
                 lpps.document_key
      ) as source_row_num
    from rag.legacy_product_profile_source lpps
    where upper(lpps.language_code) = v_language_code
  )
  select count(*) into v_remaining_source_rows
  from source_rows sr
  left join rag.source_record existing_source_record
    on existing_source_record.source_schema = sr.source_schema
   and existing_source_record.source_table = sr.source_table
   and existing_source_record.source_pk = sr.source_pk
   and existing_source_record.source_locale = sr.language_code
  left join rag.entity existing_entity
    on existing_entity.entity_type = sr.entity_type
   and existing_entity.canonical_key = sr.entity_key
  left join rag.document existing_document
    on existing_document.document_key = sr.document_key
  where sr.source_row_num = 1
    and (
      existing_source_record.id is null
      or existing_source_record.source_type is distinct from sr.source_type
      or existing_source_record.checksum is distinct from sr.checksum
      or existing_source_record.is_active is distinct from true
      or existing_source_record.metadata is distinct from sr.metadata
      or existing_entity.id is null
      or existing_entity.title is distinct from sr.title
      or existing_entity.sku is distinct from sr.sku
      or existing_entity.product_key is distinct from sr.source_pk
      or existing_entity.product_line_key is distinct from sr.product_line_key
      or existing_entity.metadata is distinct from sr.metadata
      or existing_document.id is null
      or existing_document.title is distinct from sr.title
      or upper(coalesce(existing_document.language_code, '')) is distinct from sr.language_code
      or existing_document.body_text is distinct from sr.body_text
      or existing_document.metadata is distinct from sr.metadata
      or existing_document.document_kind is distinct from 'product_profile'
    );

  select count(*) into v_remaining_deactivations
  from rag.source_record sr
  where sr.source_schema = 'legacy'
    and sr.source_table = 'products'
    and sr.source_type = 'product_profile'
    and sr.source_locale = v_language_code
    and sr.is_active = true
    and not exists (
      select 1
      from rag.legacy_product_profile_source lpps
      where upper(lpps.language_code) = v_language_code
        and lpps.source_pk = sr.source_pk
    );

  return jsonb_build_object(
    'language_code', v_language_code,
    'batch_limit', v_batch_limit,
    'source_rows_processed', v_source_rows_processed,
    'source_records_upserted', v_source_count,
    'entities_upserted', v_entity_count,
    'documents_upserted', v_document_count,
    'source_records_deactivated', v_deactivated_count,
    'remaining_source_rows', v_remaining_source_rows,
    'remaining_deactivations', v_remaining_deactivations,
    'has_more', (v_remaining_source_rows + v_remaining_deactivations) > 0
  );
end;
$$;

grant execute on function rag.sync_legacy_product_profiles(text) to service_role;

comment on function rag.sync_legacy_product_profiles(text) is
  'Processes the next batch of legacy-derived product-profile source rows into rag.source_record, rag.entity, and rag.document, and deactivates missing source rows incrementally.';
