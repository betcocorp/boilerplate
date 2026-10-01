-- Product-line-level RAG corpus: one document per legacy prod_line with rolled-up size variants.
-- Replaces per-SKU product_profile sync; deactivates legacy product-level source rows.

create or replace view rag.legacy_product_line_profile_source as
with english_product_descriptions as (
  select
    pd."ProductsKey" as product_key,
    pd."ShortDescr" as short_descr,
    pd."FullDescr" as full_descr,
    row_number() over (
      partition by pd."ProductsKey"
      order by pd."ProductsDescrKey" nulls last
    ) as row_num
  from legacy.products_descr pd
  where upper(coalesce(pd."LanguageCD", 'EN')) = 'EN'
),
products_by_line as (
  select distinct
    pa."AttrKey" as prod_line_key,
    p."ProductsKey",
    p."Title",
    p."SLDescr",
    p."SKU",
    p."InvtID",
    p."Status",
    p."OnWeb",
    p."MSRP"
  from legacy.products_attr pa
  inner join legacy.products p
    on p."ProductsKey" = pa."ProductsKey"
  where lower(coalesce(pa."AttrTable", '')) = 'prodline'
    and pa."AttrKey" is not null
    and p."ProductsKey" is not null
),
variant_rollups as (
  select
    pbl.prod_line_key,
    string_agg(
      concat_ws(
        E'\n',
        concat(
          'Variant: ',
          coalesce(epd.short_descr, pbl."Title", pbl."SLDescr", pbl."SKU", pbl."ProductsKey")
        ),
        concat('  Product key: ', pbl."ProductsKey"),
        case
          when nullif(trim(pbl."SKU"), '') is not null
            then concat('  SKU: ', trim(pbl."SKU"))
        end,
        case
          when nullif(trim(pbl."InvtID"), '') is not null
            then concat('  Inventory ID: ', trim(pbl."InvtID"))
        end,
        case
          when nullif(trim(pbl."Status"), '') is not null
            then concat('  Status: ', trim(pbl."Status"))
        end,
        case
          when upper(coalesce(pbl."OnWeb", '')) in ('Y', 'YES', 'TRUE', '1')
            then '  Available on web: yes'
          when upper(coalesce(pbl."OnWeb", '')) in ('N', 'NO', 'FALSE', '0')
            then '  Available on web: no'
        end,
        case
          when pbl."MSRP" is not null then concat('  MSRP: ', pbl."MSRP"::text)
        end
      ),
      E'\n\n'
      order by pbl."SKU" nulls last, pbl."ProductsKey"
    ) as variants_text,
    coalesce(
      jsonb_agg(
        to_jsonb(pbl."ProductsKey")
        order by pbl."SKU" nulls last, pbl."ProductsKey"
      ) filter (where pbl."ProductsKey" is not null),
      '[]'::jsonb
    ) as variant_product_keys
  from products_by_line pbl
  left join english_product_descriptions epd
    on epd.product_key = pbl."ProductsKey"
   and epd.row_num = 1
  group by pbl.prod_line_key
),
line_feature_rollup as (
  select
    pla."ProdLineKey" as prod_line_key,
    string_agg(
      nullif(trim(fs."FeatureMstrDescr"), ''),
      E'\n'
      order by coalesce(fs."SEQ", 2147483647), fs."FeatureSrchKey"
    ) as features_text
  from legacy.prod_line_attr pla
  join legacy.feature_srch fs
    on fs."FeatureSrchKey" = pla."AttrKey"
  where lower(coalesce(pla."AttrTable", '')) = 'featuresrch'
  group by pla."ProdLineKey"
),
line_direction_rollup as (
  select
    pla."ProdLineKey" as prod_line_key,
    string_agg(
      nullif(trim(pdu."Directions"), ''),
      E'\n'
      order by coalesce(pdu."Sequence", 2147483647), pdu."ProductDirectionOfUseKey"
    ) as directions_text
  from legacy.prod_line_attr pla
  join legacy.product_direction_of_use pdu
    on pdu."ProductDirectionOfUseKey" = pla."AttrKey"
  where lower(coalesce(pla."AttrTable", '')) = 'productdirectionofuse'
  group by pla."ProdLineKey"
),
line_tech_spec_rollup as (
  select
    pla."ProdLineKey" as prod_line_key,
    string_agg(
      concat_ws(
        ': ',
        nullif(trim(tsd."TechSpecDef"), ''),
        nullif(trim(ts."TechValue"), '')
      ),
      E'\n'
      order by coalesce(ts."SortOrder", 2147483647), ts."TechSpecKey"
    ) as tech_specs_text
  from legacy.prod_line_attr pla
  join legacy.tech_spec ts
    on ts."TechSpecKey" = pla."AttrKey"
  left join legacy.tech_spec_def tsd
    on tsd."TechSpecDefKey" = ts."TechSpecDefKey"
  where lower(coalesce(pla."AttrTable", '')) = 'techspec'
  group by pla."ProdLineKey"
),
line_document_rollup as (
  select
    pla."ProdLineKey" as prod_line_key,
    string_agg(
      nullif(trim(coalesce(d."LinkName", d."DocDescr", d."FileName")), ''),
      E'\n'
      order by coalesce(d."Sequence", 2147483647), d."DocumentsKey"
    ) as document_refs_text
  from legacy.prod_line_attr pla
  join legacy.documents d
    on d."DocumentsKey" = pla."AttrKey"
  where lower(coalesce(pla."AttrTable", '')) = 'documents'
  group by pla."ProdLineKey"
)
select
  'legacy'::text as source_schema,
  'prod_line'::text as source_table,
  pl."ProdLineKey" as source_pk,
  'EN'::text as language_code,
  'product_line_profile'::text as source_type,
  concat('legacy:product_line:', pl."ProdLineKey", ':en') as document_key,
  'product_line'::text as entity_type,
  pl."ProdLineKey" as entity_key,
  coalesce(
    nullif(trim(pld.short_descr), ''),
    nullif(trim(pl."Title"), ''),
    nullif(trim(pl."ProdLineDescr"), ''),
    pl."ProdLineKey",
    'Untitled product line'
  ) as title,
  null::text as sku,
  pl."ProdLineKey" as product_line_key,
  concat_ws(
    E'\n\n',
    concat_ws(
      E'\n',
      concat(
        'Product line: ',
        coalesce(pl."Title", pl."ProdLineDescr", pl."ProdLineKey")
      ),
      case
        when nullif(trim(pl."ProdLineID"), '') is not null
          then concat('Product line ID: ', trim(pl."ProdLineID"))
      end,
      case
        when nullif(trim(pld.short_descr), '') is not null
          then concat('Summary: ', trim(pld.short_descr))
      end,
      case
        when nullif(trim(pld.full_descr), '') is not null
          then concat('Description: ', trim(pld.full_descr))
      end,
      case
        when nullif(trim(pl."Applications"), '') is not null
          then concat('Applications: ', trim(pl."Applications"))
      end,
      case
        when nullif(trim(pl."MetaDescription"), '') is not null
          then concat('Marketing: ', trim(pl."MetaDescription"))
      end,
      case
        when nullif(trim(pl."H1"), '') is not null then concat('SEO H1: ', trim(pl."H1"))
      end,
      case
        when nullif(trim(pl."H2"), '') is not null then concat('SEO H2: ', trim(pl."H2"))
      end
    ),
    case
      when nullif(trim(vr.variants_text), '') is not null
        then concat('Size and package variants:', E'\n\n', vr.variants_text)
    end,
    case
      when lfr.features_text is not null
        then concat('Features:', E'\n- ', replace(lfr.features_text, E'\n', E'\n- '))
    end,
    case
      when ldr.directions_text is not null
        then concat('Directions for use:', E'\n- ', replace(ldr.directions_text, E'\n', E'\n- '))
    end,
    case
      when ltr.tech_specs_text is not null
        then concat(
          'Technical specifications:',
          E'\n- ',
          replace(ltr.tech_specs_text, E'\n', E'\n- ')
        )
    end,
    case
      when ldoc.document_refs_text is not null
        then concat(
          'Related documents:',
          E'\n- ',
          replace(ldoc.document_refs_text, E'\n', E'\n- ')
        )
    end
  ) as body_text,
  jsonb_strip_nulls(
    jsonb_build_object(
      'source_schema', 'legacy',
      'source_table', 'prod_line',
      'product_line_key', pl."ProdLineKey",
      'prod_line_id', pl."ProdLineID",
      'variant_product_keys', coalesce(vr.variant_product_keys, '[]'::jsonb),
      'variant_count',
        case
          when vr.variant_product_keys is null then 0
          else jsonb_array_length(vr.variant_product_keys)
        end,
      'seo_h1', pl."H1",
      'seo_h2', pl."H2"
    )
  ) as metadata,
  null::text as product_key
from (
  select distinct on (pl0."ProdLineKey")
    pl0.*
  from legacy.prod_line pl0
  where pl0."ProdLineKey" is not null
  order by pl0."ProdLineKey", pl0."ProdLineID" nulls last
) pl
left join lateral (
  select
    pld1."ShortDescr" as short_descr,
    pld1."FullDescr" as full_descr
  from legacy.prod_line_descr pld1
  where pld1."ProdLineKey" = pl."ProdLineKey"
    and upper(coalesce(pld1."LanguageCD", 'EN')) = 'EN'
  order by pld1."ProdLineDescrKey" nulls last
  limit 1
) pld on true
left join variant_rollups vr
  on vr.prod_line_key = pl."ProdLineKey"
left join line_feature_rollup lfr
  on lfr.prod_line_key = pl."ProdLineKey"
left join line_direction_rollup ldr
  on ldr.prod_line_key = pl."ProdLineKey"
left join line_tech_spec_rollup ltr
  on ltr.prod_line_key = pl."ProdLineKey"
left join line_document_rollup ldoc
  on ldoc.prod_line_key = pl."ProdLineKey";

comment on view rag.legacy_product_line_profile_source is
  'One English row per legacy prod_line: shared line copy plus aggregated size/SKU variants for RAG.';

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
  v_batch_limit integer := 25;
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
  with pending_rows as (
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
      lpps.product_key,
      md5(coalesce(lpps.body_text, '')) as checksum,
      lpps.metadata,
      existing_source_record.updated_at as source_record_updated_at,
      existing_entity.updated_at as entity_updated_at,
      existing_document.updated_at as document_updated_at
    from rag.legacy_product_line_profile_source lpps
    left join rag.source_record existing_source_record
      on existing_source_record.source_schema = lpps.source_schema
     and existing_source_record.source_table = lpps.source_table
     and existing_source_record.source_pk = lpps.source_pk
     and upper(existing_source_record.source_locale) = upper(lpps.language_code)
    left join rag.entity existing_entity
      on existing_entity.entity_type = lpps.entity_type
     and existing_entity.canonical_key = lpps.entity_key
    left join rag.document existing_document
      on existing_document.document_key = lpps.document_key
    where upper(lpps.language_code) = v_language_code
      and (
        existing_source_record.id is null
        or existing_source_record.source_type is distinct from lpps.source_type
        or existing_source_record.checksum is distinct from md5(coalesce(lpps.body_text, ''))
        or existing_source_record.is_active is distinct from true
        or existing_source_record.metadata is distinct from lpps.metadata
        or existing_entity.id is null
        or existing_entity.title is distinct from lpps.title
        or existing_entity.sku is distinct from lpps.sku
        or existing_entity.product_key is distinct from lpps.product_key
        or existing_entity.product_line_key is distinct from lpps.product_line_key
        or existing_entity.metadata is distinct from lpps.metadata
        or existing_document.id is null
        or existing_document.title is distinct from lpps.title
        or upper(coalesce(existing_document.language_code, '')) is distinct from upper(lpps.language_code)
        or existing_document.body_text is distinct from lpps.body_text
        or existing_document.metadata is distinct from lpps.metadata
        or existing_document.document_kind is distinct from 'product_line_profile'
      )
  )
  select
    d.source_schema,
    d.source_table,
    d.source_pk,
    d.language_code,
    d.source_type,
    d.document_key,
    d.entity_type,
    d.entity_key,
    d.title,
    d.body_text,
    d.sku,
    d.product_line_key,
    d.product_key,
    d.checksum,
    d.metadata
  from (
    select distinct on (pr.document_key)
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
      pr.product_key,
      pr.checksum,
      pr.metadata,
      coalesce(
        least(
          coalesce(pr.source_record_updated_at, 'infinity'::timestamptz),
          coalesce(pr.entity_updated_at, 'infinity'::timestamptz),
          coalesce(pr.document_updated_at, 'infinity'::timestamptz)
        ),
        '-infinity'::timestamptz
      ) as sync_priority
    from pending_rows pr
    order by
      pr.document_key,
      coalesce(
        least(
          coalesce(pr.source_record_updated_at, 'infinity'::timestamptz),
          coalesce(pr.entity_updated_at, 'infinity'::timestamptz),
          coalesce(pr.document_updated_at, 'infinity'::timestamptz)
        ),
        '-infinity'::timestamptz
      )
  ) d
  order by d.sync_priority, d.document_key
  limit v_batch_limit;

  select count(*) into v_source_rows_processed
  from rag_profile_sync_candidates;

  with upserted as (
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
      c.source_schema,
      c.source_table,
      c.source_pk,
      c.language_code,
      c.source_type,
      c.checksum,
      true,
      timezone('utc', now()),
      c.metadata
    from rag_profile_sync_candidates c
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

  with upserted as (
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
      c.entity_type,
      c.entity_key,
      c.title,
      c.sku,
      c.product_key,
      c.product_line_key,
      c.metadata
    from rag_profile_sync_candidates c
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

  with resolved as (
    select
      c.document_key,
      sr.id as source_record_id,
      e.id as entity_id,
      c.title,
      c.language_code,
      c.body_text,
      c.metadata
    from rag_profile_sync_candidates c
    join rag.source_record sr
      on sr.source_schema = c.source_schema
     and sr.source_table = c.source_table
     and sr.source_pk = c.source_pk
     and upper(sr.source_locale) = c.language_code
    left join rag.entity e
      on e.entity_type = c.entity_type
     and e.canonical_key = c.entity_key
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
      'product_line_profile',
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
    sr.id
  from rag.source_record sr
  where sr.source_schema = 'legacy'
    and sr.source_table = 'prod_line'
    and sr.source_type = 'product_line_profile'
    and upper(sr.source_locale) = v_language_code
    and sr.is_active = true
    and not exists (
      select 1
      from rag.legacy_product_line_profile_source lplps
      where upper(lplps.language_code) = v_language_code
        and lplps.source_pk = sr.source_pk
    )
  order by sr.updated_at, sr.id
  limit v_batch_limit;

  update rag.source_record sr
     set is_active = false,
         last_seen_at = timezone('utc', now())
    from rag_profile_deactivate_candidates dc
   where dc.id = sr.id;

  get diagnostics v_deactivated_count = row_count;

  v_remaining_source_rows := case when v_source_rows_processed = v_batch_limit then 1 else 0 end;
  v_remaining_deactivations := case when v_deactivated_count = v_batch_limit then 1 else 0 end;

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

comment on function rag.sync_legacy_product_profiles(text) is
  'Syncs legacy prod_line rows (product_line_profile) into rag; one document per line with variants in body/metadata.';

update rag.source_record sr
set
  is_active = false,
  last_seen_at = timezone('utc', now())
where sr.source_schema = 'legacy'
  and sr.source_table = 'products'
  and sr.source_type = 'product_profile'
  and sr.is_active = true;

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
  'Chunks product_line_profile documents (one prod_line per document, variants in body).';

create or replace function rag.match_product_chunks(
  query_embedding extensions.vector(1536),
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
    where dc_ann.embedding is not null
    order by dc_ann.embedding <=> query_embedding
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
    1 - (dc.embedding <=> query_embedding) as similarity
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
  order by dc.embedding <=> query_embedding
  limit greatest(coalesce(match_count, 10), 1);
$$;

comment on function rag.match_product_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
) is
  'ANN-first search over product_line_profile chunks; optional filters by line or variant product key (metadata).';

grant execute on function rag.sync_legacy_product_profiles(text) to service_role;
grant execute on function rag.sync_legacy_product_profile_chunks(text) to service_role;
grant execute on function rag.match_product_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
) to service_role;
