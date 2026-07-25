-- B0-284: Convert SECURITY DEFINER views to SECURITY INVOKER
-- Ensures RLS policies apply to the actual caller's role, not a privileged role
-- All views are recreated explicitly with SECURITY INVOKER
--
-- This improves RLS enforcement by ensuring that policies are evaluated
-- against the actual invoking role rather than the view definer's role.

BEGIN;

-- Recreate legacy_product_line_profile_source with explicit SECURITY INVOKER
DROP VIEW IF EXISTS rag.legacy_product_line_profile_source CASCADE;

CREATE VIEW rag.legacy_product_line_profile_source
WITH (SECURITY_INVOKER)
AS
WITH english_product_descriptions AS (
  SELECT
    pd."ProductsKey" AS product_key,
    pd."ShortDescr" AS short_descr,
    pd."FullDescr" AS full_descr,
    row_number() OVER (PARTITION BY pd."ProductsKey" ORDER BY pd."ProductsDescrKey") AS row_num
  FROM legacy.products_descr pd
  WHERE (upper((COALESCE(pd."LanguageCD", 'EN'::character varying))::text) = 'EN'::text)
),
products_by_line AS (
  SELECT DISTINCT
    pa."AttrKey" AS prod_line_key,
    p."ProductsKey",
    p."Title",
    p."SLDescr",
    p."SKU",
    p."InvtID",
    p."Status",
    p."OnWeb",
    p."MSRP"
  FROM (legacy.products_attr pa
    JOIN legacy.products p ON (((p."ProductsKey")::text = (pa."ProductsKey")::text)))
  WHERE ((lower((COALESCE(pa."AttrTable", ''::character varying))::text) = 'prodline'::text)
    AND (pa."AttrKey" IS NOT NULL)
    AND (p."ProductsKey" IS NOT NULL))
),
variant_rollups AS (
  SELECT
    pbl.prod_line_key,
    string_agg(concat_ws(E'\n'::text, concat('Variant: ', COALESCE(epd.short_descr, pbl."Title", pbl."SLDescr", pbl."SKU", pbl."ProductsKey")),
      concat('  Product key: ', pbl."ProductsKey"),
      CASE
        WHEN (NULLIF(TRIM(BOTH FROM pbl."SKU"), ''::text) IS NOT NULL) THEN concat('  SKU: ', TRIM(BOTH FROM pbl."SKU"))
        ELSE NULL::text
      END,
      CASE
        WHEN (NULLIF(TRIM(BOTH FROM pbl."InvtID"), ''::text) IS NOT NULL) THEN concat('  Inventory ID: ', TRIM(BOTH FROM pbl."InvtID"))
        ELSE NULL::text
      END,
      CASE
        WHEN (NULLIF(TRIM(BOTH FROM pbl."Status"), ''::text) IS NOT NULL) THEN concat('  Status: ', TRIM(BOTH FROM pbl."Status"))
        ELSE NULL::text
      END,
      CASE
        WHEN (upper((COALESCE(pbl."OnWeb", ''::character varying))::text) = ANY (ARRAY['Y'::text, 'YES'::text, 'TRUE'::text, '1'::text])) THEN '  Available on web: yes'::text
        WHEN (upper((COALESCE(pbl."OnWeb", ''::character varying))::text) = ANY (ARRAY['N'::text, 'NO'::text, 'FALSE'::text, '0'::text])) THEN '  Available on web: no'::text
        ELSE NULL::text
      END,
      CASE
        WHEN (pbl."MSRP" IS NOT NULL) THEN concat('  MSRP: ', (pbl."MSRP")::text)
        ELSE NULL::text
      END), E'\n\n'::text ORDER BY pbl."SKU", pbl."ProductsKey") AS variants_text,
    COALESCE(jsonb_agg(to_jsonb(pbl."ProductsKey") ORDER BY pbl."SKU", pbl."ProductsKey") FILTER (WHERE (pbl."ProductsKey" IS NOT NULL)), '[]'::jsonb) AS variant_product_keys
  FROM (products_by_line pbl
    LEFT JOIN english_product_descriptions epd ON ((((epd.product_key)::text = (pbl."ProductsKey")::text) AND (epd.row_num = 1))))
  GROUP BY pbl.prod_line_key
),
line_feature_rollup AS (
  SELECT
    pla."ProdLineKey" AS prod_line_key,
    string_agg(NULLIF(TRIM(BOTH FROM fs."FeatureMstrDescr"), ''::text), E'\n'::text ORDER BY COALESCE(fs."SEQ", (2147483647)::bigint), fs."FeatureSrchKey") AS features_text
  FROM (legacy.prod_line_attr pla
    JOIN legacy.feature_srch fs ON (((fs."FeatureSrchKey")::text = (pla."AttrKey")::text)))
  WHERE (lower((COALESCE(pla."AttrTable", ''::character varying))::text) = 'featuresrch'::text)
  GROUP BY pla."ProdLineKey"
),
line_direction_rollup AS (
  SELECT
    deduped."ProdLineKey" AS prod_line_key,
    string_agg(NULLIF(TRIM(BOTH FROM deduped."Directions"), ''::text), E'\n'::text ORDER BY COALESCE(deduped."Sequence", (2147483647)::bigint), deduped."ProductDirectionOfUseKey") AS directions_text
  FROM ( SELECT
      pla."ProdLineKey",
      pdu."Directions",
      pdu."Sequence",
      pdu."ProductDirectionOfUseKey",
      row_number() OVER (PARTITION BY pla."ProdLineKey", (lower(TRIM(BOTH FROM pdu."Directions"))) ORDER BY COALESCE(pdu."Sequence", (2147483647)::bigint), pdu."ProductDirectionOfUseKey") AS rn
    FROM (legacy.prod_line_attr pla
      JOIN legacy.product_direction_of_use pdu ON (((pdu."ProductDirectionOfUseKey")::text = (pla."AttrKey")::text)))
    WHERE ((lower((COALESCE(pla."AttrTable", ''::character varying))::text) = 'productdirectionofuse'::text)
      AND (NULLIF(TRIM(BOTH FROM pdu."Directions"), ''::text) IS NOT NULL))) deduped
  WHERE (deduped.rn = 1)
  GROUP BY deduped."ProdLineKey"
),
line_tech_spec_rollup AS (
  SELECT
    pla."ProdLineKey" AS prod_line_key,
    string_agg(concat_ws(': '::text, NULLIF(TRIM(BOTH FROM tsd."TechSpecDef"), ''::text), NULLIF(TRIM(BOTH FROM ts."TechValue"), ''::text)), E'\n'::text ORDER BY COALESCE(ts."SortOrder", (2147483647)::bigint), ts."TechSpecKey") AS tech_specs_text
  FROM ((legacy.prod_line_attr pla
    JOIN legacy.tech_spec ts ON (((ts."TechSpecKey")::text = (pla."AttrKey")::text)))
    LEFT JOIN legacy.tech_spec_def tsd ON (((tsd."TechSpecDefKey")::text = (ts."TechSpecDefKey")::text)))
  WHERE (lower((COALESCE(pla."AttrTable", ''::character varying))::text) = 'techspec'::text)
  GROUP BY pla."ProdLineKey"
),
line_document_rollup AS (
  SELECT
    pla."ProdLineKey" AS prod_line_key,
    string_agg(NULLIF(TRIM(BOTH FROM COALESCE(d."LinkName", d."DocDescr", d."FileName")), ''::text), E'\n'::text ORDER BY COALESCE(d."Sequence", (2147483647)::bigint), d."DocumentsKey") AS document_refs_text
  FROM (legacy.prod_line_attr pla
    JOIN legacy.documents d ON (((d."DocumentsKey")::text = (pla."AttrKey")::text)))
  WHERE ((lower((COALESCE(pla."AttrTable", ''::character varying))::text) = 'documents'::text)
    AND (NULLIF(TRIM(BOTH FROM COALESCE(d."LinkName", d."DocDescr", d."FileName")), ''::text) IS NOT NULL)
    AND (TRIM(BOTH FROM COALESCE(d."LinkName", d."DocDescr", d."FileName")) !~ '^https?://'::text)
    AND ((TRIM(BOTH FROM COALESCE(d."LinkName", d."DocDescr", d."FileName")) ~ E'\\s'::text)
      OR (length(TRIM(BOTH FROM COALESCE(d."LinkName", d."DocDescr", d."FileName"))) > 40)))
  GROUP BY pla."ProdLineKey"
)
SELECT
  'legacy'::text AS source_schema,
  'prod_line'::text AS source_table,
  pl."ProdLineKey" AS source_pk,
  'EN'::text AS language_code,
  'product_line_profile'::text AS source_type,
  concat('legacy:product_line:', pl."ProdLineKey", ':en') AS document_key,
  'product_line'::text AS entity_type,
  pl."ProdLineKey" AS entity_key,
  COALESCE(NULLIF(TRIM(BOTH FROM pld.short_descr), ''::text), NULLIF(TRIM(BOTH FROM pl."Title"), ''::text), NULLIF(TRIM(BOTH FROM pl."ProdLineDescr"), ''::text), (pl."ProdLineKey")::text, 'Untitled product line'::text) AS title,
  NULL::text AS sku,
  pl."ProdLineKey" AS product_line_key,
  concat_ws(E'\n\n'::text, concat_ws(E'\n'::text, concat('Product line: ', COALESCE(pl."Title", pl."ProdLineDescr", pl."ProdLineKey")),
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM pl."ProdLineID"), ''::text) IS NOT NULL) THEN concat('Product line ID: ', TRIM(BOTH FROM pl."ProdLineID"))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM pld.short_descr), ''::text) IS NOT NULL) THEN concat('Summary: ', TRIM(BOTH FROM pld.short_descr))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM pld.full_descr), ''::text) IS NOT NULL) THEN concat('Description: ', TRIM(BOTH FROM pld.full_descr))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM pl."Applications"), ''::text) IS NOT NULL) THEN concat('Applications: ', TRIM(BOTH FROM pl."Applications"))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM pl."MetaDescription"), ''::text) IS NOT NULL) THEN concat('Marketing: ', TRIM(BOTH FROM pl."MetaDescription"))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM pl."H1"), ''::text) IS NOT NULL) THEN concat('SEO H1: ', TRIM(BOTH FROM pl."H1"))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM pl."H2"), ''::text) IS NOT NULL) THEN concat('SEO H2: ', TRIM(BOTH FROM pl."H2"))
      ELSE NULL::text
    END),
  CASE
    WHEN (NULLIF(TRIM(BOTH FROM vr.variants_text), ''::text) IS NOT NULL) THEN concat('Size and package variants:', E'\n\n', vr.variants_text)
    ELSE NULL::text
  END,
  CASE
    WHEN (lfr.features_text IS NOT NULL) THEN concat('Features:', E'\n- ', replace(lfr.features_text, E'\n'::text, E'\n- '::text))
    ELSE NULL::text
  END,
  CASE
    WHEN (ldr.directions_text IS NOT NULL) THEN concat('Directions for use:', E'\n- ', replace(ldr.directions_text, E'\n'::text, E'\n- '::text))
    ELSE NULL::text
  END,
  CASE
    WHEN (ltr.tech_specs_text IS NOT NULL) THEN concat('Technical specifications:', E'\n- ', replace(ltr.tech_specs_text, E'\n'::text, E'\n- '::text))
    ELSE NULL::text
  END,
  CASE
    WHEN (ldoc.document_refs_text IS NOT NULL) THEN concat('Related documents:', E'\n- ', replace(ldoc.document_refs_text, E'\n'::text, E'\n- '::text))
    ELSE NULL::text
  END) AS body_text,
  jsonb_strip_nulls(jsonb_build_object('source_schema', 'legacy', 'source_table', 'prod_line', 'product_line_key', pl."ProdLineKey", 'prod_line_id', pl."ProdLineID", 'variant_product_keys', COALESCE(vr.variant_product_keys, '[]'::jsonb), 'variant_count',
    CASE
      WHEN (vr.variant_product_keys IS NULL) THEN 0
      ELSE jsonb_array_length(vr.variant_product_keys)
    END, 'seo_h1', pl."H1", 'seo_h2', pl."H2")) AS metadata,
  NULL::text AS product_key
FROM ((((((( SELECT DISTINCT ON (pl0."ProdLineKey") pl0."ProdLineDescr",
      pl0."ProdLineID",
      pl0."ProdLineKey",
      pl0."User_DTm_00",
      pl0."User_DTm_01",
      pl0."User_Flt_00",
      pl0."User_Flt_01",
      pl0."User_Int_00",
      pl0."User_Int_01",
      pl0."User_Str_00",
      pl0."User_Str_01",
      pl0."User_Str_02",
      pl0."User_Str_03",
      pl0."User_Str_04",
      pl0."User_Str_05",
      pl0."Title",
      pl0."MetaDescription",
      pl0."MetaKeyWords",
      pl0."H1",
      pl0."H2",
      pl0."Applications"
    FROM legacy.prod_line pl0
    WHERE (pl0."ProdLineKey" IS NOT NULL)
    ORDER BY pl0."ProdLineKey", pl0."ProdLineID") pl
  LEFT JOIN LATERAL ( SELECT pld1."ShortDescr" AS short_descr,
      pld1."FullDescr" AS full_descr
    FROM legacy.prod_line_descr pld1
    WHERE (((pld1."ProdLineKey")::text = (pl."ProdLineKey")::text)
      AND (upper((COALESCE(pld1."LanguageCD", 'EN'::character varying))::text) = 'EN'::text))
    ORDER BY pld1."ProdLineDescrKey"
    LIMIT 1) pld ON (true))
  LEFT JOIN variant_rollups vr ON (((vr.prod_line_key)::text = (pl."ProdLineKey")::text)))
  LEFT JOIN line_feature_rollup lfr ON (((lfr.prod_line_key)::text = (pl."ProdLineKey")::text)))
  LEFT JOIN line_direction_rollup ldr ON (((ldr.prod_line_key)::text = (pl."ProdLineKey")::text)))
  LEFT JOIN line_tech_spec_rollup ltr ON (((ltr.prod_line_key)::text = (pl."ProdLineKey")::text)))
  LEFT JOIN line_document_rollup ldoc ON (((ldoc.prod_line_key)::text = (pl."ProdLineKey")::text));

-- Recreate legacy_product_profile_source with explicit SECURITY INVOKER
DROP VIEW IF EXISTS rag.legacy_product_profile_source CASCADE;

CREATE VIEW rag.legacy_product_profile_source
WITH (SECURITY_INVOKER)
AS
WITH english_product_descriptions AS (
  SELECT pd."ProductsKey" AS product_key,
    pd."ShortDescr" AS short_descr,
    pd."FullDescr" AS full_descr,
    row_number() OVER (PARTITION BY pd."ProductsKey" ORDER BY pd."ProductsDescrKey") AS row_num
  FROM legacy.products_descr pd
  WHERE (upper((COALESCE(pd."LanguageCD", 'EN'::character varying))::text) = 'EN'::text)
),
product_line_links AS (
  SELECT pa."ProductsKey" AS product_key,
    pa."AttrKey" AS prod_line_key,
    row_number() OVER (PARTITION BY pa."ProductsKey" ORDER BY pa."AttrKey") AS row_num
  FROM legacy.products_attr pa
  WHERE (lower((COALESCE(pa."AttrTable", ''::character varying))::text) = 'prodline'::text)
),
product_line_base AS (
  SELECT pll.product_key,
    pl."ProdLineKey" AS prod_line_key,
    pl."Title" AS prod_line_title,
    pl."ProdLineDescr" AS prod_line_descr,
    pl."Applications" AS applications,
    pld.short_descr AS prod_line_short_descr,
    pld.full_descr AS prod_line_full_descr
  FROM ((product_line_links pll
    LEFT JOIN legacy.prod_line pl ON (((pl."ProdLineKey")::text = (pll.prod_line_key)::text)))
    LEFT JOIN LATERAL ( SELECT pld1."ShortDescr" AS short_descr,
      pld1."FullDescr" AS full_descr
    FROM legacy.prod_line_descr pld1
    WHERE (((pld1."ProdLineKey")::text = (pll.prod_line_key)::text)
      AND (upper((COALESCE(pld1."LanguageCD", 'EN'::character varying))::text) = 'EN'::text))
    ORDER BY pld1."ProdLineDescrKey"
    LIMIT 1) pld ON (true))
  WHERE (pll.row_num = 1)
),
line_feature_rollup AS (
  SELECT pla."ProdLineKey" AS prod_line_key,
    string_agg(NULLIF(TRIM(BOTH FROM fs."FeatureMstrDescr"), ''::text), E'\n'::text ORDER BY COALESCE(fs."SEQ", (2147483647)::bigint), fs."FeatureSrchKey") AS features_text
  FROM (legacy.prod_line_attr pla
    JOIN legacy.feature_srch fs ON (((fs."FeatureSrchKey")::text = (pla."AttrKey")::text)))
  WHERE (lower((COALESCE(pla."AttrTable", ''::character varying))::text) = 'featuresrch'::text)
  GROUP BY pla."ProdLineKey"
),
line_direction_rollup AS (
  SELECT pla."ProdLineKey" AS prod_line_key,
    string_agg(NULLIF(TRIM(BOTH FROM pdu."Directions"), ''::text), E'\n'::text ORDER BY COALESCE(pdu."Sequence", (2147483647)::bigint), pdu."ProductDirectionOfUseKey") AS directions_text
  FROM (legacy.prod_line_attr pla
    JOIN legacy.product_direction_of_use pdu ON (((pdu."ProductDirectionOfUseKey")::text = (pla."AttrKey")::text)))
  WHERE (lower((COALESCE(pla."AttrTable", ''::character varying))::text) = 'productdirectionofuse'::text)
  GROUP BY pla."ProdLineKey"
),
line_tech_spec_rollup AS (
  SELECT pla."ProdLineKey" AS prod_line_key,
    string_agg(concat_ws(': '::text, NULLIF(TRIM(BOTH FROM tsd."TechSpecDef"), ''::text), NULLIF(TRIM(BOTH FROM ts."TechValue"), ''::text)), E'\n'::text ORDER BY COALESCE(ts."SortOrder", (2147483647)::bigint), ts."TechSpecKey") AS tech_specs_text
  FROM ((legacy.prod_line_attr pla
    JOIN legacy.tech_spec ts ON (((ts."TechSpecKey")::text = (pla."AttrKey")::text)))
    LEFT JOIN legacy.tech_spec_def tsd ON (((tsd."TechSpecDefKey")::text = (ts."TechSpecDefKey")::text)))
  WHERE (lower((COALESCE(pla."AttrTable", ''::character varying))::text) = 'techspec'::text)
  GROUP BY pla."ProdLineKey"
),
line_document_rollup AS (
  SELECT pla."ProdLineKey" AS prod_line_key,
    string_agg(NULLIF(TRIM(BOTH FROM COALESCE(d."LinkName", d."DocDescr", d."FileName")), ''::text), E'\n'::text ORDER BY COALESCE(d."Sequence", (2147483647)::bigint), d."DocumentsKey") AS document_refs_text
  FROM (legacy.prod_line_attr pla
    JOIN legacy.documents d ON (((d."DocumentsKey")::text = (pla."AttrKey")::text)))
  WHERE (lower((COALESCE(pla."AttrTable", ''::character varying))::text) = 'documents'::text)
  GROUP BY pla."ProdLineKey"
)
SELECT
  'legacy'::text AS source_schema,
  'products'::text AS source_table,
  p."ProductsKey" AS source_pk,
  'EN'::text AS language_code,
  'product_profile'::text AS source_type,
  'product'::text AS entity_type,
  p."ProductsKey" AS entity_key,
  concat('legacy:product:', p."ProductsKey", ':en') AS document_key,
  COALESCE(epd.short_descr, p."Title", p."SLDescr", p."H1", p."H2", p."SKU", 'Untitled product'::character varying) AS title,
  p."SKU" AS sku,
  plb.prod_line_key AS product_line_key,
  concat_ws(E'\n\n'::text, concat_ws(E'\n'::text, concat('Product: ', COALESCE(epd.short_descr, p."Title", p."SLDescr", p."H1", p."H2", p."SKU", 'Untitled product'::character varying)),
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM p."SKU"), ''::text) IS NOT NULL) THEN concat('SKU: ', TRIM(BOTH FROM p."SKU"))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM p."InvtID"), ''::text) IS NOT NULL) THEN concat('Inventory ID: ', TRIM(BOTH FROM p."InvtID"))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM p."Status"), ''::text) IS NOT NULL) THEN concat('Status: ', TRIM(BOTH FROM p."Status"))
      ELSE NULL::text
    END,
    CASE
      WHEN (upper((COALESCE(p."OnWeb", ''::character varying))::text) = ANY (ARRAY['Y'::text, 'YES'::text, 'TRUE'::text, '1'::text])) THEN 'Available on web: yes'::text
      WHEN (upper((COALESCE(p."OnWeb", ''::character varying))::text) = ANY (ARRAY['N'::text, 'NO'::text, 'FALSE'::text, '0'::text])) THEN 'Available on web: no'::text
      ELSE NULL::text
    END,
    CASE
      WHEN (p."MSRP" IS NOT NULL) THEN concat('MSRP: ', (p."MSRP")::text)
      ELSE NULL::text
    END),
  CASE
    WHEN (plb.prod_line_key IS NOT NULL) THEN concat_ws(E'\n'::text, concat('Product line: ', COALESCE(plb.prod_line_title, plb.prod_line_descr, plb.prod_line_key)),
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM plb.prod_line_short_descr), ''::text) IS NOT NULL) THEN concat('Product line summary: ', TRIM(BOTH FROM plb.prod_line_short_descr))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM plb.prod_line_full_descr), ''::text) IS NOT NULL) THEN concat('Product line description: ', TRIM(BOTH FROM plb.prod_line_full_descr))
      ELSE NULL::text
    END,
    CASE
      WHEN (NULLIF(TRIM(BOTH FROM plb.applications), ''::text) IS NOT NULL) THEN concat('Applications: ', TRIM(BOTH FROM plb.applications))
      ELSE NULL::text
    END)
    ELSE NULL::text
  END,
  CASE
    WHEN (NULLIF(TRIM(BOTH FROM epd.short_descr), ''::text) IS NOT NULL) THEN concat('Short description: ', TRIM(BOTH FROM epd.short_descr))
    ELSE NULL::text
  END,
  CASE
    WHEN (NULLIF(TRIM(BOTH FROM epd.full_descr), ''::text) IS NOT NULL) THEN concat('Full description: ', TRIM(BOTH FROM epd.full_descr))
    ELSE NULL::text
  END,
  CASE
    WHEN (NULLIF(TRIM(BOTH FROM p."MetaDescription"), ''::text) IS NOT NULL) THEN concat('Marketing description: ', TRIM(BOTH FROM p."MetaDescription"))
    ELSE NULL::text
  END,
  CASE
    WHEN (lfr.features_text IS NOT NULL) THEN concat('Features:', E'\n- ', replace(lfr.features_text, E'\n'::text, E'\n- '::text))
    ELSE NULL::text
  END,
  CASE
    WHEN (ldr.directions_text IS NOT NULL) THEN concat('Directions for use:', E'\n- ', replace(ldr.directions_text, E'\n'::text, E'\n- '::text))
    ELSE NULL::text
  END,
  CASE
    WHEN (ltr.tech_specs_text IS NOT NULL) THEN concat('Technical specifications:', E'\n- ', replace(ltr.tech_specs_text, E'\n'::text, E'\n- '::text))
    ELSE NULL::text
  END,
  CASE
    WHEN (ldoc.document_refs_text IS NOT NULL) THEN concat('Related documents:', E'\n- ', replace(ldoc.document_refs_text, E'\n'::text, E'\n- '::text))
    ELSE NULL::text
  END) AS body_text,
  jsonb_strip_nulls(jsonb_build_object('source_schema', 'legacy', 'source_table', 'products', 'product_key', p."ProductsKey", 'product_line_key', plb.prod_line_key, 'sku', p."SKU", 'inventory_id', p."InvtID", 'status', p."Status", 'on_web',
    CASE
      WHEN (upper((COALESCE(p."OnWeb", ''::character varying))::text) = ANY (ARRAY['Y'::text, 'YES'::text, 'TRUE'::text, '1'::text])) THEN true
      WHEN (upper((COALESCE(p."OnWeb", ''::character varying))::text) = ANY (ARRAY['N'::text, 'NO'::text, 'FALSE'::text, '0'::text])) THEN false
      ELSE NULL::boolean
    END, 'title', p."Title", 'short_label', p."SLDescr", 'seo_h1', p."H1", 'seo_h2', p."H2")) AS metadata
FROM ((((((legacy.products p
  LEFT JOIN english_product_descriptions epd ON ((((epd.product_key)::text = (p."ProductsKey")::text) AND (epd.row_num = 1))))
  LEFT JOIN product_line_base plb ON (((plb.product_key)::text = (p."ProductsKey")::text)))
  LEFT JOIN line_feature_rollup lfr ON (((lfr.prod_line_key)::text = (plb.prod_line_key)::text)))
  LEFT JOIN line_direction_rollup ldr ON (((ldr.prod_line_key)::text = (plb.prod_line_key)::text)))
  LEFT JOIN line_tech_spec_rollup ltr ON (((ltr.prod_line_key)::text = (plb.prod_line_key)::text)))
  LEFT JOIN line_document_rollup ldoc ON (((ldoc.prod_line_key)::text = (plb.prod_line_key)::text)))
WHERE (p."ProductsKey" IS NOT NULL);

-- Recreate suspect_sds_documents with explicit SECURITY INVOKER
DROP VIEW IF EXISTS rag.suspect_sds_documents CASCADE;

CREATE VIEW rag.suspect_sds_documents
WITH (SECURITY_INVOKER)
AS
SELECT
  d.id,
  d.document_key,
  d.title,
  d.language_code,
  sr.source_pk,
  length(d.body_text) AS body_text_length,
  COALESCE((d.metadata ->> 'product_line_key'::text), ''::text) AS product_line_key,
  "left"(d.body_text, 500) AS body_text_preview
FROM (rag.document d
  JOIN rag.source_record sr ON ((sr.id = d.source_record_id)))
WHERE ((d.document_kind = 'sds'::text)
  AND (sr.is_active = true)
  AND (d.body_text IS NOT NULL)
  AND (length(TRIM(BOTH FROM d.body_text)) > 0)
  AND (d.body_text !~~* '%Section%1%'::text)
  AND (d.body_text !~~* '%Identification%'::text)
  AND (d.body_text !~~* '%Hazard%'::text)
  AND (d.body_text !~~* '%SECCI%'::text))
ORDER BY (length(d.body_text)) DESC;

COMMIT;
