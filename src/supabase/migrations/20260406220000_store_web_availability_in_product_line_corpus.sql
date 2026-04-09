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
    ) as variant_product_keys,
    count(*) filter (
      where upper(coalesce(pbl."OnWeb", '')) in ('Y', 'YES', 'TRUE', '1')
    ) as web_available_variant_count,
    count(*) filter (
      where upper(coalesce(pbl."OnWeb", '')) in ('N', 'NO', 'FALSE', '0')
    ) as non_web_variant_count,
    count(*) filter (
      where nullif(trim(coalesce(pbl."OnWeb", '')), '') is null
         or upper(coalesce(pbl."OnWeb", '')) not in ('Y', 'YES', 'TRUE', '1', 'N', 'NO', 'FALSE', '0')
    ) as unknown_web_variant_count
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
      'has_web_available_variant', coalesce(vr.web_available_variant_count, 0) > 0,
      'has_non_web_available_variant', coalesce(vr.non_web_variant_count, 0) > 0,
      'web_available_variant_count', coalesce(vr.web_available_variant_count, 0),
      'non_web_variant_count', coalesce(vr.non_web_variant_count, 0),
      'unknown_web_variant_count', coalesce(vr.unknown_web_variant_count, 0),
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
  'One English row per legacy prod_line: shared line copy plus aggregated size/SKU variants for RAG, including explicit web-availability metadata.';

with source_rows as (
  select
    lplps.source_schema,
    lplps.source_table,
    lplps.source_pk,
    lplps.language_code,
    lplps.entity_type,
    lplps.entity_key,
    lplps.document_key,
    lplps.metadata
  from rag.legacy_product_line_profile_source lplps
  where upper(lplps.language_code) = 'EN'
)
update rag.source_record sr
set metadata = s.metadata
from source_rows s
where sr.source_schema = s.source_schema
  and sr.source_table = s.source_table
  and sr.source_pk = s.source_pk
  and upper(sr.source_locale) = upper(s.language_code)
  and sr.metadata is distinct from s.metadata;

with source_rows as (
  select
    lplps.entity_type,
    lplps.entity_key,
    lplps.metadata
  from rag.legacy_product_line_profile_source lplps
  where upper(lplps.language_code) = 'EN'
)
update rag.entity e
set metadata = s.metadata
from source_rows s
where e.entity_type = s.entity_type
  and e.canonical_key = s.entity_key
  and e.metadata is distinct from s.metadata;

with source_rows as (
  select
    lplps.document_key,
    lplps.metadata
  from rag.legacy_product_line_profile_source lplps
  where upper(lplps.language_code) = 'EN'
)
update rag.document d
set metadata = s.metadata
from source_rows s
where d.document_key = s.document_key
  and d.document_kind = 'product_line_profile'
  and upper(d.language_code) = 'EN'
  and d.metadata is distinct from s.metadata;
