-- Improve legacy_product_line_profile_source view:
--   1. Batch variants into groups of 10 (each group becomes one chunk instead of one chunk per variant).
--   2. Merge "Size and package variants:" header with first variant batch (single \n instead of \n\n
--      so the chunker doesn't split the header from its content).
--   3. Deduplicate direction text (duplicate rows in product_direction_of_use produced verbatim repeats).
--   4. Deduplicate feature text for the same reason.

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
-- Number each variant within its product line for stable batch assignment.
numbered_variants as (
  select
    pbl.prod_line_key,
    pbl."ProductsKey",
    pbl."SKU",
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
    ) as variant_text,
    row_number() over (
      partition by pbl.prod_line_key
      order by pbl."SKU" nulls last, pbl."ProductsKey"
    ) as rn
  from products_by_line pbl
  left join english_product_descriptions epd
    on epd.product_key = pbl."ProductsKey"
   and epd.row_num = 1
),
-- Aggregate variants within each batch of 10 using single newlines (no double-newline,
-- so the chunker keeps each batch as one chunk).
variant_batches as (
  select
    prod_line_key,
    ceil(rn / 10.0)::integer as batch_num,
    string_agg(variant_text, E'\n' order by rn) as batch_text
  from numbered_variants
  group by prod_line_key, ceil(rn / 10.0)::integer
),
-- Roll up batches for the body_text (double-newline between batches = separate chunks).
variant_text_rollup as (
  select
    prod_line_key,
    string_agg(batch_text, E'\n\n' order by batch_num) as variants_text
  from variant_batches
  group by prod_line_key
),
-- Separate rollup for the product_keys metadata array.
variant_key_rollup as (
  select
    prod_line_key,
    coalesce(
      jsonb_agg(
        to_jsonb("ProductsKey")
        order by "SKU" nulls last, "ProductsKey"
      ) filter (where "ProductsKey" is not null),
      '[]'::jsonb
    ) as variant_product_keys
  from numbered_variants
  group by prod_line_key
),
variant_rollups as (
  select
    tr.prod_line_key,
    tr.variants_text,
    kr.variant_product_keys
  from variant_text_rollup tr
  join variant_key_rollup kr on kr.prod_line_key = tr.prod_line_key
),
-- Deduplicate features: partition by (prod_line_key, trimmed text) so identical rows
-- contributed by duplicate legacy.prod_line_attr links are counted only once.
line_feature_rollup as (
  with deduped as (
    select
      pla."ProdLineKey" as prod_line_key,
      fs."FeatureMstrDescr",
      coalesce(fs."SEQ", 2147483647) as seq,
      fs."FeatureSrchKey",
      row_number() over (
        partition by pla."ProdLineKey", trim(fs."FeatureMstrDescr")
        order by coalesce(fs."SEQ", 2147483647), fs."FeatureSrchKey"
      ) as rn
    from legacy.prod_line_attr pla
    join legacy.feature_srch fs
      on fs."FeatureSrchKey" = pla."AttrKey"
    where lower(coalesce(pla."AttrTable", '')) = 'featuresrch'
      and nullif(trim(fs."FeatureMstrDescr"), '') is not null
  )
  select
    prod_line_key,
    string_agg(
      "FeatureMstrDescr",
      E'\n'
      order by seq, "FeatureSrchKey"
    ) as features_text
  from deduped
  where rn = 1
  group by prod_line_key
),
-- Deduplicate directions: same partition strategy on trimmed direction text.
line_direction_rollup as (
  with deduped as (
    select
      pla."ProdLineKey" as prod_line_key,
      pdu."Directions",
      coalesce(pdu."Sequence", 2147483647) as seq,
      pdu."ProductDirectionOfUseKey",
      row_number() over (
        partition by pla."ProdLineKey", trim(pdu."Directions")
        order by coalesce(pdu."Sequence", 2147483647), pdu."ProductDirectionOfUseKey"
      ) as rn
    from legacy.prod_line_attr pla
    join legacy.product_direction_of_use pdu
      on pdu."ProductDirectionOfUseKey" = pla."AttrKey"
    where lower(coalesce(pla."AttrTable", '')) = 'productdirectionofuse'
      and nullif(trim(pdu."Directions"), '') is not null
  )
  select
    prod_line_key,
    string_agg(
      "Directions",
      E'\n'
      order by seq, "ProductDirectionOfUseKey"
    ) as directions_text
  from deduped
  where rn = 1
  group by prod_line_key
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
    -- Single \n between header and first variant batch so the chunker (splits on \n\n)
    -- keeps the "Size and package variants:" label in the same chunk as the first batch.
    case
      when nullif(trim(vr.variants_text), '') is not null
        then concat('Size and package variants:', E'\n', vr.variants_text)
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
  'One English row per legacy prod_line: shared line copy plus aggregated size/SKU variants (batched 10 per chunk) for RAG. Directions and features are deduplicated.';
