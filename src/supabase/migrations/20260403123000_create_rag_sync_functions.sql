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
  v_source_count integer := 0;
  v_entity_count integer := 0;
  v_document_count integer := 0;
  v_deactivated_count integer := 0;
begin
  with base_rows as (
    select
      lpps.source_schema,
      lpps.source_table,
      lpps.source_pk,
      lpps.language_code,
      lpps.source_type,
      lpps.document_key,
      lpps.entity_type,
      lpps.entity_key,
      lpps.title,
      lpps.body_text,
      lpps.sku,
      lpps.product_line_key,
      md5(lpps.body_text) as checksum,
      lpps.metadata,
      row_number() over (
        partition by lpps.source_schema, lpps.source_table, lpps.source_pk, lpps.language_code
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
  source_rows as (
    select
      br.source_schema,
      br.source_table,
      br.source_pk,
      br.language_code,
      br.source_type,
      br.checksum,
      br.metadata
    from base_rows br
    where br.source_row_num = 1
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

  with base_rows as (
    select
      lpps.document_key,
      lpps.entity_type,
      lpps.entity_key,
      lpps.title,
      lpps.sku,
      lpps.source_pk as product_key,
      lpps.product_line_key,
      lpps.body_text,
      lpps.metadata,
      row_number() over (
        partition by lpps.entity_type, lpps.entity_key
        order by length(coalesce(lpps.body_text, '')) desc,
                 length(coalesce(lpps.title, '')) desc,
                 lpps.document_key
      ) as entity_row_num
    from rag.legacy_product_profile_source lpps
    where upper(lpps.language_code) = v_language_code
  ),
  source_rows as (
    select
      br.entity_type,
      br.entity_key,
      br.title,
      br.sku,
      br.product_key,
      br.product_line_key,
      br.metadata
    from base_rows br
    where br.entity_row_num = 1
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
      sr.entity_type,
      sr.entity_key,
      sr.title,
      sr.sku,
      sr.product_key,
      sr.product_line_key,
      sr.metadata
    from source_rows sr
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

  with base_rows as (
    select
      lpps.document_key,
      lpps.source_schema,
      lpps.source_table,
      lpps.source_pk,
      lpps.language_code,
      lpps.entity_type,
      lpps.entity_key,
      lpps.title,
      lpps.body_text,
      lpps.metadata,
      row_number() over (
        partition by lpps.document_key
        order by length(coalesce(lpps.body_text, '')) desc,
                 length(coalesce(lpps.title, '')) desc
      ) as document_row_num
    from rag.legacy_product_profile_source lpps
    where upper(lpps.language_code) = v_language_code
  ),
  source_rows as (
    select
      br.document_key,
      br.source_schema,
      br.source_table,
      br.source_pk,
      br.language_code,
      br.entity_type,
      br.entity_key,
      br.title,
      br.body_text,
      br.metadata
    from base_rows br
    where br.document_row_num = 1
  ),
  resolved as (
    select
      sr.document_key,
      s.id as source_record_id,
      e.id as entity_id,
      sr.title,
      sr.language_code,
      sr.body_text,
      sr.metadata
    from source_rows sr
    join rag.source_record s
      on s.source_schema = sr.source_schema
     and s.source_table = sr.source_table
     and s.source_pk = sr.source_pk
     and s.source_locale = sr.language_code
    left join rag.entity e
      on e.entity_type = sr.entity_type
     and e.canonical_key = sr.entity_key
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

  update rag.source_record sr
     set is_active = false,
         last_seen_at = timezone('utc', now())
   where sr.source_schema = 'legacy'
     and sr.source_table = 'products'
     and sr.source_type = 'product_profile'
     and sr.source_locale = v_language_code
     and not exists (
       select 1
       from rag.legacy_product_profile_source lpps
       where upper(lpps.language_code) = v_language_code
         and lpps.source_pk = sr.source_pk
     );

  get diagnostics v_deactivated_count = row_count;

  return jsonb_build_object(
    'language_code', v_language_code,
    'source_records_upserted', v_source_count,
    'entities_upserted', v_entity_count,
    'documents_upserted', v_document_count,
    'source_records_deactivated', v_deactivated_count
  );
end;
$$;

grant execute on function rag.sync_legacy_product_profiles(text) to service_role;

comment on function rag.sync_legacy_product_profiles(text) is
  'Upserts derived product-profile source records, entities, and documents from legacy into the isolated rag schema.';
