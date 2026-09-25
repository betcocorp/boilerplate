-- B0-1091: restore the rich rag.legacy_product_line_profile_source and add line lifecycle.
--
-- WHY
--   20260816030000 (B0-555) did CREATE OR REPLACE from the original 20260406150000 stub
--   (body_text = 'Product line: ' || title, metadata = 3 keys) instead of the rich definition
--   that was live. Nobody ran rag.sync_legacy_product_profiles() since, so the 1,703 stored
--   product_line_profile documents still carry the rich body (verified 2026-09-25: 0 of 1,703
--   matched the stub). The next sync would have overwritten every profile with the stub and
--   stripped metadata.has_web_available_variant, which rag.match_product_chunks* require.
--
-- WHAT THE RESTORED DEFINITION IS (reconstructed from the live rows, not from any one file)
--   * body_text: the 20260515120000 layout -- variants batched 10 per group joined by single
--     newlines, "Size and package variants:" + single \n, features and directions deduplicated
--     on trim(). Measured before applying: of 1,703 stored bodies, 1,378 are byte-identical to
--     this definition and 315 differ only by new "  Available on web: no" lines (B0-1089 turned
--     null OnWeb into 0 today). The other 10 (keys 0906D136..0E68A358) were last synced under
--     the 20260520170029 variant (URL-filtered document refs, non-batched variants) and are
--     simply stale; they re-chunk and re-embed like the 315.
--   * metadata: the B0-281 web-availability keys (has_web_available_variant,
--     has_non_web_available_variant, web_available_variant_count, non_web_variant_count,
--     unknown_web_variant_count), prod_line_id, seo_h1/seo_h2, variant_product_keys,
--     variant_count; plus the keys the live rows carried from later enrichment passes so the
--     sync stops wiping them: prod_line_descr / prod_types / sub_prod_types /
--     sub_child_prod_types / prod_classes (read by get_products_in_category,
--     ~/lib/tools/category-lookup.ts) and description / short_description / dilution_code /
--     coverage_sq_ft (read by ~/lib/rag/entity-context.ts). dilution_code and coverage_sq_ft
--     are transcribed verbatim from legacy.products only when every item on the line carries
--     the same value; lines whose items disagree get no value (same honesty rule as B0-555).
--   * product_key: the B0-555 rule, unchanged -- populated only when the line links to exactly
--     one distinct legacy ProductsKey (0 changes against the 1,703 stored entity rows).
--   * "OnWeb" is integer 0/1 NOT NULL since B0-1089; the old text comparisons are gone.
--
-- LINE LIFECYCLE (new, all derived from the same products_attr AttrTable='prodline' item set)
--   metadata.active_variant_count  items with Status = 'AC'
--   metadata.has_active_variant    active_variant_count > 0
--   metadata.line_lifecycle        'web_active'     >= 1 item Status=AC AND OnWeb=1
--                                  'active_offline' >= 1 item AC, none of them OnWeb=1
--                                  'inactive'       items exist, none AC
--                                  'empty'          no items at all
--
-- EXCLUSION MECHANISM (setting RAG_PROFILE_EXCLUDE_INACTIVE_LINES, default true)
--   When the setting resolves true the view omits rows whose line_lifecycle is 'inactive' or
--   'empty'. That is the whole mechanism: rag.sync_legacy_product_profiles() deactivates the
--   rag.source_record rows of lines that no longer appear in the view
--   (rag_profile_deactivate_candidates, 25 per call) and rag.sync_legacy_product_profile_chunks()
--   deletes the chunks of inactive source_records. Setting it to false makes the rows reappear;
--   the next sync reactivates them (`is_active is distinct from true` triggers the re-upsert)
--   and re-chunks them. rag.document and rag.entity rows are never deleted by any of this.
--   The setting is read inside the view with a scalar subquery that coalesces to true when the
--   row is missing, so a missing/unreadable row behaves like the default.
--
-- SECURITY INVOKER matches the B0-284 convention for rag views (rag.product_line_web_url).
-- The sync RPC is SECURITY DEFINER (owner postgres), so it reads public.settings past RLS.

drop view if exists rag.legacy_product_line_profile_source;

create view rag.legacy_product_line_profile_source
with (security_invoker = true)
as
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
-- One row per (line, item) through legacy.products_attr AttrTable='prodline'. Every per-line
-- figure below (variant list, web availability, lifecycle, B0-555 product_key, dilution/coverage)
-- is derived from this single CTE so all counts share one definition of "item on the line".
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
    p."MSRP",
    p."DilutionCode",
    p."Coverage_Usable_Gal_Sq_Ft"
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
      -- B0-1089: "OnWeb" is integer 0/1 (NOT NULL, CHECK). Former nulls/junk are now 0, so every
      -- variant carries one of these two lines.
      case
        when pbl."OnWeb" = 1 then '  Available on web: yes'
        when pbl."OnWeb" = 0 then '  Available on web: no'
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
-- Batches of 10 variants joined by single newlines (one chunk per batch).
variant_batches as (
  select
    prod_line_key,
    ceil(rn / 10.0)::integer as batch_num,
    string_agg(variant_text, E'\n' order by rn) as batch_text
  from numbered_variants
  group by prod_line_key, ceil(rn / 10.0)::integer
),
-- Double newline between batches = separate chunks.
variant_text_rollup as (
  select
    prod_line_key,
    string_agg(batch_text, E'\n\n' order by batch_num) as variants_text
  from variant_batches
  group by prod_line_key
),
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
-- Per-line item statistics: web availability (B0-281), lifecycle (B0-1091), the B0-555
-- product_key rule, and the item-level ERP fields that rag.entity.metadata carried before
-- (dilution_code / coverage_sq_ft, emitted only when every item on the line agrees).
variant_stats as (
  select
    prod_line_key,
    count(*)::integer as variant_count,
    count(*) filter (where "OnWeb" = 1)::integer as web_available_variant_count,
    count(*) filter (where "OnWeb" = 0)::integer as non_web_variant_count,
    count(*) filter (where upper(trim(coalesce("Status", ''))) = 'AC')::integer as active_variant_count,
    count(*) filter (
      where upper(trim(coalesce("Status", ''))) = 'AC' and "OnWeb" = 1
    )::integer as active_web_variant_count,
    count(distinct "ProductsKey")::integer as distinct_product_key_count,
    min("ProductsKey")::text as sole_product_key,
    count(distinct nullif(trim("DilutionCode"), ''))::integer as distinct_dilution_code_count,
    min(nullif(trim("DilutionCode"), ''))::text as sole_dilution_code,
    count(distinct nullif(trim("Coverage_Usable_Gal_Sq_Ft"), ''))::integer as distinct_coverage_count,
    min(nullif(trim("Coverage_Usable_Gal_Sq_Ft"), ''))::text as sole_coverage_sq_ft
  from products_by_line
  group by prod_line_key
),
-- Website category chain, unioned across the line's items (read by get_products_in_category,
-- ~/lib/tools/category-lookup.ts). AttrTable spelling is mixed-case in legacy ("ProdTypes" /
-- "prodtypes", "ProdClass" / "Prodclass"), hence lower().
line_category_rollup as (
  select
    pbl.prod_line_key,
    nullif(to_jsonb(array_remove(array_agg(distinct pt."MstrDescr" order by pt."MstrDescr"), null)), '[]'::jsonb) as prod_types,
    nullif(to_jsonb(array_remove(array_agg(distinct spt."MstrDescr" order by spt."MstrDescr"), null)), '[]'::jsonb) as sub_prod_types,
    nullif(to_jsonb(array_remove(array_agg(distinct scpt."MstrDescr" order by scpt."MstrDescr"), null)), '[]'::jsonb) as sub_child_prod_types,
    nullif(to_jsonb(array_remove(array_agg(distinct pc."DSLProdClassDescr" order by pc."DSLProdClassDescr"), null)), '[]'::jsonb) as prod_classes
  from products_by_line pbl
  join legacy.products_attr pa
    on pa."ProductsKey" = pbl."ProductsKey"
  left join legacy.prod_types pt
    on lower(coalesce(pa."AttrTable", '')) = 'prodtypes'
   and pt."ProdTypesKey" = pa."AttrKey"
  left join legacy.sub_prod_types spt
    on lower(coalesce(pa."AttrTable", '')) = 'subprodtypes'
   and spt."SubProdTypesKey" = pa."AttrKey"
  left join legacy.sub_child_prod_types scpt
    on lower(coalesce(pa."AttrTable", '')) = 'subchildprodtypes'
   and scpt."SubChildProdTypesKey" = pa."AttrKey"
  left join legacy.prod_class pc
    on lower(coalesce(pa."AttrTable", '')) = 'prodclass'
   and pc."ProdClassKey" = pa."AttrKey"
  group by pbl.prod_line_key
),
-- Deduplicate features: identical rows contributed by duplicate prod_line_attr links count once.
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
),
profile as (
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
        'prod_line_descr', pl."ProdLineDescr",
        'short_description', nullif(trim(pld.short_descr), ''),
        'description', nullif(trim(pld.full_descr), ''),
        'variant_product_keys', coalesce(vr.variant_product_keys, '[]'::jsonb),
        'variant_count', coalesce(vs.variant_count, 0),
        'has_web_available_variant', coalesce(vs.web_available_variant_count, 0) > 0,
        'has_non_web_available_variant', coalesce(vs.non_web_variant_count, 0) > 0,
        'web_available_variant_count', coalesce(vs.web_available_variant_count, 0),
        'non_web_variant_count', coalesce(vs.non_web_variant_count, 0),
        -- Always 0 since B0-1089 (OnWeb is a NOT NULL 0/1 integer); kept for key stability.
        'unknown_web_variant_count', 0,
        'active_variant_count', coalesce(vs.active_variant_count, 0),
        'has_active_variant', coalesce(vs.active_variant_count, 0) > 0,
        'line_lifecycle',
          case
            when vs.prod_line_key is null then 'empty'
            when vs.active_web_variant_count > 0 then 'web_active'
            when vs.active_variant_count > 0 then 'active_offline'
            else 'inactive'
          end,
        'prod_types', lcr.prod_types,
        'sub_prod_types', lcr.sub_prod_types,
        'sub_child_prod_types', lcr.sub_child_prod_types,
        'prod_classes', lcr.prod_classes,
        'dilution_code',
          case when vs.distinct_dilution_code_count = 1 then vs.sole_dilution_code end,
        'coverage_sq_ft',
          case when vs.distinct_coverage_count = 1 then vs.sole_coverage_sq_ft end,
        'seo_h1', pl."H1",
        'seo_h2', pl."H2"
      )
    ) as metadata,
    -- B0-555: product_key only when the line resolves to exactly one legacy ProductsKey.
    (case when vs.distinct_product_key_count = 1 then vs.sole_product_key end)::text as product_key,
    case
      when vs.prod_line_key is null then 'empty'
      when vs.active_web_variant_count > 0 then 'web_active'
      when vs.active_variant_count > 0 then 'active_offline'
      else 'inactive'
    end as line_lifecycle
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
  left join variant_stats vs
    on vs.prod_line_key = pl."ProdLineKey"
  left join line_category_rollup lcr
    on lcr.prod_line_key = pl."ProdLineKey"
  left join line_feature_rollup lfr
    on lfr.prod_line_key = pl."ProdLineKey"
  left join line_direction_rollup ldr
    on ldr.prod_line_key = pl."ProdLineKey"
  left join line_tech_spec_rollup ltr
    on ltr.prod_line_key = pl."ProdLineKey"
  left join line_document_rollup ldoc
    on ldoc.prod_line_key = pl."ProdLineKey"
)
select
  p.source_schema,
  p.source_table,
  p.source_pk,
  p.language_code,
  p.source_type,
  p.document_key,
  p.entity_type,
  p.entity_key,
  p.title,
  p.sku,
  p.product_line_key,
  p.body_text,
  p.metadata,
  p.product_key
from profile p
where p.line_lifecycle not in ('inactive', 'empty')
   or not coalesce(
        (
          select lower(trim(coalesce(s.value, s.default_value))) in ('true', 't', '1', 'yes', 'on')
          from public.settings s
          where s.key = 'RAG_PROFILE_EXCLUDE_INACTIVE_LINES'
        ),
        true
      );

comment on view rag.legacy_product_line_profile_source is
  'B0-1091: one English row per legacy prod_line for the product_line_profile RAG corpus -- line copy plus size/SKU variants batched 10 per chunk, deduplicated features/directions, B0-281 web-availability metadata, B0-555 product_key rule, website category chain, and line_lifecycle (web_active | active_offline | inactive | empty). Rows with line_lifecycle inactive/empty are omitted while public.settings RAG_PROFILE_EXCLUDE_INACTIVE_LINES resolves true; the sync RPCs then deactivate their source_records and drop their chunks.';

grant select on rag.legacy_product_line_profile_source to authenticated, service_role;
