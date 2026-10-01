create or replace view rag.legacy_product_profile_source as
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
product_line_links as (
  select
    pa."ProductsKey" as product_key,
    pa."AttrKey" as prod_line_key,
    row_number() over (
      partition by pa."ProductsKey"
      order by pa."AttrKey"
    ) as row_num
  from legacy.products_attr pa
  where lower(coalesce(pa."AttrTable", '')) = 'prodline'
),
product_line_base as (
  select
    pll.product_key,
    pl."ProdLineKey" as prod_line_key,
    pl."Title" as prod_line_title,
    pl."ProdLineDescr" as prod_line_descr,
    pl."Applications" as applications,
    pld.short_descr as prod_line_short_descr,
    pld.full_descr as prod_line_full_descr
  from product_line_links pll
  left join legacy.prod_line pl
    on pl."ProdLineKey" = pll.prod_line_key
  left join lateral (
    select
      pld1."ShortDescr" as short_descr,
      pld1."FullDescr" as full_descr
    from legacy.prod_line_descr pld1
    where pld1."ProdLineKey" = pll.prod_line_key
      and upper(coalesce(pld1."LanguageCD", 'EN')) = 'EN'
    order by pld1."ProdLineDescrKey" nulls last
    limit 1
  ) pld on true
  where pll.row_num = 1
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
  'products'::text as source_table,
  p."ProductsKey" as source_pk,
  'EN'::text as language_code,
  'product_profile'::text as source_type,
  'product'::text as entity_type,
  p."ProductsKey" as entity_key,
  concat('legacy:product:', p."ProductsKey", ':en') as document_key,
  coalesce(
    epd.short_descr,
    p."Title",
    p."SLDescr",
    p."H1",
    p."H2",
    p."SKU",
    'Untitled product'
  ) as title,
  p."SKU" as sku,
  plb.prod_line_key as product_line_key,
  concat_ws(
    E'\n\n',
    concat_ws(
      E'\n',
      concat('Product: ', coalesce(epd.short_descr, p."Title", p."SLDescr", p."H1", p."H2", p."SKU", 'Untitled product')),
      case when nullif(trim(p."SKU"), '') is not null then concat('SKU: ', trim(p."SKU")) end,
      case when nullif(trim(p."InvtID"), '') is not null then concat('Inventory ID: ', trim(p."InvtID")) end,
      case when nullif(trim(p."Status"), '') is not null then concat('Status: ', trim(p."Status")) end,
      case
        when upper(coalesce(p."OnWeb", '')) in ('Y', 'YES', 'TRUE', '1') then 'Available on web: yes'
        when upper(coalesce(p."OnWeb", '')) in ('N', 'NO', 'FALSE', '0') then 'Available on web: no'
      end,
      case when p."MSRP" is not null then concat('MSRP: ', p."MSRP"::text) end
    ),
    case
      when plb.prod_line_key is not null then concat_ws(
        E'\n',
        concat('Product line: ', coalesce(plb.prod_line_title, plb.prod_line_descr, plb.prod_line_key)),
        case when nullif(trim(plb.prod_line_short_descr), '') is not null then concat('Product line summary: ', trim(plb.prod_line_short_descr)) end,
        case when nullif(trim(plb.prod_line_full_descr), '') is not null then concat('Product line description: ', trim(plb.prod_line_full_descr)) end,
        case when nullif(trim(plb.applications), '') is not null then concat('Applications: ', trim(plb.applications)) end
      )
    end,
    case when nullif(trim(epd.short_descr), '') is not null then concat('Short description: ', trim(epd.short_descr)) end,
    case when nullif(trim(epd.full_descr), '') is not null then concat('Full description: ', trim(epd.full_descr)) end,
    case when nullif(trim(p."MetaDescription"), '') is not null then concat('Marketing description: ', trim(p."MetaDescription")) end,
    case
      when lfr.features_text is not null then concat('Features:', E'\n- ', replace(lfr.features_text, E'\n', E'\n- '))
    end,
    case
      when ldr.directions_text is not null then concat('Directions for use:', E'\n- ', replace(ldr.directions_text, E'\n', E'\n- '))
    end,
    case
      when ltr.tech_specs_text is not null then concat('Technical specifications:', E'\n- ', replace(ltr.tech_specs_text, E'\n', E'\n- '))
    end,
    case
      when ldoc.document_refs_text is not null then concat('Related documents:', E'\n- ', replace(ldoc.document_refs_text, E'\n', E'\n- '))
    end
  ) as body_text,
  jsonb_strip_nulls(
    jsonb_build_object(
      'source_schema', 'legacy',
      'source_table', 'products',
      'product_key', p."ProductsKey",
      'product_line_key', plb.prod_line_key,
      'sku', p."SKU",
      'inventory_id', p."InvtID",
      'status', p."Status",
      'on_web', case
        when upper(coalesce(p."OnWeb", '')) in ('Y', 'YES', 'TRUE', '1') then true
        when upper(coalesce(p."OnWeb", '')) in ('N', 'NO', 'FALSE', '0') then false
        else null
      end,
      'title', p."Title",
      'short_label', p."SLDescr",
      'seo_h1', p."H1",
      'seo_h2', p."H2"
    )
  ) as metadata
from legacy.products p
left join english_product_descriptions epd
  on epd.product_key = p."ProductsKey"
 and epd.row_num = 1
left join product_line_base plb
  on plb.product_key = p."ProductsKey"
left join line_feature_rollup lfr
  on lfr.prod_line_key = plb.prod_line_key
left join line_direction_rollup ldr
  on ldr.prod_line_key = plb.prod_line_key
left join line_tech_spec_rollup ltr
  on ltr.prod_line_key = plb.prod_line_key
left join line_document_rollup ldoc
  on ldoc.prod_line_key = plb.prod_line_key
where p."ProductsKey" is not null;

comment on view rag.legacy_product_profile_source is
  'Derived English product-profile corpus assembled from legacy catalog tables and ready to sync into rag.document.';
