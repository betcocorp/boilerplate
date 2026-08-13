-- ============================================================
-- 20260520170029_plp_view_and_chunker_fixes.sql
--
-- 1. line_direction_rollup: deduplicate identical direction text
--    per product line (avoids repeated directives when multiple
--    SKUs share the same text).
-- 2. line_document_rollup: filter out bare URL fragments that
--    add noise without semantic value.
-- 3. chunk_document_text: add 120-char minimum length guard so
--    degenerate micro-chunks are never emitted.
-- 4. Delete existing degenerate PLP chunks (< 120 chars) to
--    force clean regeneration on the next chunk sync run.
-- ============================================================


-- ── Part 1: Updated view ─────────────────────────────────────────────────────

CREATE OR REPLACE VIEW rag.legacy_product_line_profile_source AS
WITH english_product_descriptions AS (
  SELECT
    pd."ProductsKey" AS product_key,
    pd."ShortDescr"  AS short_descr,
    pd."FullDescr"   AS full_descr,
    row_number() OVER (
      PARTITION BY pd."ProductsKey"
      ORDER BY pd."ProductsDescrKey" NULLS LAST
    ) AS row_num
  FROM legacy.products_descr pd
  WHERE upper(coalesce(pd."LanguageCD", 'EN')) = 'EN'
),
products_by_line AS (
  SELECT DISTINCT
    pa."AttrKey"   AS prod_line_key,
    p."ProductsKey",
    p."Title",
    p."SLDescr",
    p."SKU",
    p."InvtID",
    p."Status",
    p."OnWeb",
    p."MSRP"
  FROM legacy.products_attr pa
  INNER JOIN legacy.products p
    ON p."ProductsKey" = pa."ProductsKey"
  WHERE lower(coalesce(pa."AttrTable", '')) = 'prodline'
    AND pa."AttrKey"    IS NOT NULL
    AND p."ProductsKey" IS NOT NULL
),
variant_rollups AS (
  SELECT
    pbl.prod_line_key,
    string_agg(
      concat_ws(
        E'\n',
        concat(
          'Variant: ',
          coalesce(epd.short_descr, pbl."Title", pbl."SLDescr", pbl."SKU", pbl."ProductsKey")
        ),
        concat('  Product key: ', pbl."ProductsKey"),
        CASE WHEN nullif(trim(pbl."SKU"),    '') IS NOT NULL THEN concat('  SKU: ',         trim(pbl."SKU"))    END,
        CASE WHEN nullif(trim(pbl."InvtID"), '') IS NOT NULL THEN concat('  Inventory ID: ', trim(pbl."InvtID")) END,
        CASE WHEN nullif(trim(pbl."Status"), '') IS NOT NULL THEN concat('  Status: ',       trim(pbl."Status")) END,
        CASE
          WHEN upper(coalesce(pbl."OnWeb", '')) IN ('Y','YES','TRUE','1') THEN '  Available on web: yes'
          WHEN upper(coalesce(pbl."OnWeb", '')) IN ('N','NO','FALSE','0') THEN '  Available on web: no'
        END,
        CASE WHEN pbl."MSRP" IS NOT NULL THEN concat('  MSRP: ', pbl."MSRP"::text) END
      ),
      E'\n\n'
      ORDER BY pbl."SKU" NULLS LAST, pbl."ProductsKey"
    ) AS variants_text,
    coalesce(
      jsonb_agg(
        to_jsonb(pbl."ProductsKey")
        ORDER BY pbl."SKU" NULLS LAST, pbl."ProductsKey"
      ) FILTER (WHERE pbl."ProductsKey" IS NOT NULL),
      '[]'::jsonb
    ) AS variant_product_keys
  FROM products_by_line pbl
  LEFT JOIN english_product_descriptions epd
    ON epd.product_key = pbl."ProductsKey"
   AND epd.row_num = 1
  GROUP BY pbl.prod_line_key
),
line_feature_rollup AS (
  SELECT
    pla."ProdLineKey" AS prod_line_key,
    string_agg(
      nullif(trim(fs."FeatureMstrDescr"), ''),
      E'\n'
      ORDER BY coalesce(fs."SEQ", 2147483647), fs."FeatureSrchKey"
    ) AS features_text
  FROM legacy.prod_line_attr pla
  JOIN legacy.feature_srch fs
    ON fs."FeatureSrchKey" = pla."AttrKey"
  WHERE lower(coalesce(pla."AttrTable", '')) = 'featuresrch'
  GROUP BY pla."ProdLineKey"
),
-- Dedup: keep only the first occurrence of each distinct direction
-- text within a product line (case-insensitive trim).
line_direction_rollup AS (
  SELECT
    "ProdLineKey" AS prod_line_key,
    string_agg(
      nullif(trim("Directions"), ''),
      E'\n'
      ORDER BY coalesce("Sequence", 2147483647), "ProductDirectionOfUseKey"
    ) AS directions_text
  FROM (
    SELECT
      pla."ProdLineKey",
      pdu."Directions",
      pdu."Sequence",
      pdu."ProductDirectionOfUseKey",
      row_number() OVER (
        PARTITION BY pla."ProdLineKey", lower(trim(pdu."Directions"))
        ORDER BY coalesce(pdu."Sequence", 2147483647), pdu."ProductDirectionOfUseKey"
      ) AS rn
    FROM legacy.prod_line_attr pla
    JOIN legacy.product_direction_of_use pdu
      ON pdu."ProductDirectionOfUseKey" = pla."AttrKey"
    WHERE lower(coalesce(pla."AttrTable", '')) = 'productdirectionofuse'
      AND nullif(trim(pdu."Directions"), '') IS NOT NULL
  ) deduped
  WHERE rn = 1
  GROUP BY "ProdLineKey"
),
line_tech_spec_rollup AS (
  SELECT
    pla."ProdLineKey" AS prod_line_key,
    string_agg(
      concat_ws(
        ': ',
        nullif(trim(tsd."TechSpecDef"), ''),
        nullif(trim(ts."TechValue"), '')
      ),
      E'\n'
      ORDER BY coalesce(ts."SortOrder", 2147483647), ts."TechSpecKey"
    ) AS tech_specs_text
  FROM legacy.prod_line_attr pla
  JOIN legacy.tech_spec ts
    ON ts."TechSpecKey" = pla."AttrKey"
  LEFT JOIN legacy.tech_spec_def tsd
    ON tsd."TechSpecDefKey" = ts."TechSpecDefKey"
  WHERE lower(coalesce(pla."AttrTable", '')) = 'techspec'
  GROUP BY pla."ProdLineKey"
),
-- Filter out bare URL fragments (raw http links, path-only strings
-- with no spaces and <= 40 chars) that add no semantic value.
line_document_rollup AS (
  SELECT
    pla."ProdLineKey" AS prod_line_key,
    string_agg(
      nullif(trim(coalesce(d."LinkName", d."DocDescr", d."FileName")), ''),
      E'\n'
      ORDER BY coalesce(d."Sequence", 2147483647), d."DocumentsKey"
    ) AS document_refs_text
  FROM legacy.prod_line_attr pla
  JOIN legacy.documents d
    ON d."DocumentsKey" = pla."AttrKey"
  WHERE lower(coalesce(pla."AttrTable", '')) = 'documents'
    AND nullif(trim(coalesce(d."LinkName", d."DocDescr", d."FileName")), '') IS NOT NULL
    -- Exclude raw URLs (no human-readable label)
    AND trim(coalesce(d."LinkName", d."DocDescr", d."FileName")) !~ '^https?://'
    -- Exclude bare path fragments: no whitespace AND short (<= 40 chars)
    AND (
      trim(coalesce(d."LinkName", d."DocDescr", d."FileName")) ~ '\s'
      OR length(trim(coalesce(d."LinkName", d."DocDescr", d."FileName"))) > 40
    )
  GROUP BY pla."ProdLineKey"
)
SELECT
  'legacy'::text               AS source_schema,
  'prod_line'::text            AS source_table,
  pl."ProdLineKey"             AS source_pk,
  'EN'::text                   AS language_code,
  'product_line_profile'::text AS source_type,
  concat('legacy:product_line:', pl."ProdLineKey", ':en') AS document_key,
  'product_line'::text         AS entity_type,
  pl."ProdLineKey"             AS entity_key,
  coalesce(
    nullif(trim(pld.short_descr), ''),
    nullif(trim(pl."Title"), ''),
    nullif(trim(pl."ProdLineDescr"), ''),
    pl."ProdLineKey",
    'Untitled product line'
  )                            AS title,
  NULL::text                   AS sku,
  pl."ProdLineKey"             AS product_line_key,
  concat_ws(
    E'\n\n',
    concat_ws(
      E'\n',
      concat('Product line: ', coalesce(pl."Title", pl."ProdLineDescr", pl."ProdLineKey")),
      CASE WHEN nullif(trim(pl."ProdLineID"),      '') IS NOT NULL THEN concat('Product line ID: ', trim(pl."ProdLineID"))      END,
      CASE WHEN nullif(trim(pld.short_descr),      '') IS NOT NULL THEN concat('Summary: ',         trim(pld.short_descr))      END,
      CASE WHEN nullif(trim(pld.full_descr),        '') IS NOT NULL THEN concat('Description: ',     trim(pld.full_descr))       END,
      CASE WHEN nullif(trim(pl."Applications"),    '') IS NOT NULL THEN concat('Applications: ',    trim(pl."Applications"))    END,
      CASE WHEN nullif(trim(pl."MetaDescription"), '') IS NOT NULL THEN concat('Marketing: ',       trim(pl."MetaDescription")) END,
      CASE WHEN nullif(trim(pl."H1"),              '') IS NOT NULL THEN concat('SEO H1: ',          trim(pl."H1"))              END,
      CASE WHEN nullif(trim(pl."H2"),              '') IS NOT NULL THEN concat('SEO H2: ',          trim(pl."H2"))              END
    ),
    CASE WHEN nullif(trim(vr.variants_text), '') IS NOT NULL
         THEN concat('Size and package variants:', E'\n\n', vr.variants_text)
    END,
    CASE WHEN lfr.features_text IS NOT NULL
         THEN concat('Features:', E'\n- ', replace(lfr.features_text, E'\n', E'\n- '))
    END,
    CASE WHEN ldr.directions_text IS NOT NULL
         THEN concat('Directions for use:', E'\n- ', replace(ldr.directions_text, E'\n', E'\n- '))
    END,
    CASE WHEN ltr.tech_specs_text IS NOT NULL
         THEN concat('Technical specifications:', E'\n- ', replace(ltr.tech_specs_text, E'\n', E'\n- '))
    END,
    CASE WHEN ldoc.document_refs_text IS NOT NULL
         THEN concat('Related documents:', E'\n- ', replace(ldoc.document_refs_text, E'\n', E'\n- '))
    END
  )                            AS body_text,
  jsonb_strip_nulls(
    jsonb_build_object(
      'source_schema',        'legacy',
      'source_table',         'prod_line',
      'product_line_key',     pl."ProdLineKey",
      'prod_line_id',         pl."ProdLineID",
      'variant_product_keys', coalesce(vr.variant_product_keys, '[]'::jsonb),
      'variant_count', CASE
        WHEN vr.variant_product_keys IS NULL THEN 0
        ELSE jsonb_array_length(vr.variant_product_keys)
      END,
      'seo_h1', pl."H1",
      'seo_h2', pl."H2"
    )
  )                            AS metadata,
  NULL::text                   AS product_key
FROM (
  SELECT DISTINCT ON (pl0."ProdLineKey")
    pl0.*
  FROM legacy.prod_line pl0
  WHERE pl0."ProdLineKey" IS NOT NULL
  ORDER BY pl0."ProdLineKey", pl0."ProdLineID" NULLS LAST
) pl
LEFT JOIN LATERAL (
  SELECT
    pld1."ShortDescr" AS short_descr,
    pld1."FullDescr"  AS full_descr
  FROM legacy.prod_line_descr pld1
  WHERE pld1."ProdLineKey" = pl."ProdLineKey"
    AND upper(coalesce(pld1."LanguageCD", 'EN')) = 'EN'
  ORDER BY pld1."ProdLineDescrKey" NULLS LAST
  LIMIT 1
) pld ON true
LEFT JOIN variant_rollups       vr   ON vr.prod_line_key   = pl."ProdLineKey"
LEFT JOIN line_feature_rollup   lfr  ON lfr.prod_line_key  = pl."ProdLineKey"
LEFT JOIN line_direction_rollup ldr  ON ldr.prod_line_key  = pl."ProdLineKey"
LEFT JOIN line_tech_spec_rollup ltr  ON ltr.prod_line_key  = pl."ProdLineKey"
LEFT JOIN line_document_rollup  ldoc ON ldoc.prod_line_key = pl."ProdLineKey";

COMMENT ON VIEW rag.legacy_product_line_profile_source IS
  'One English row per legacy prod_line: shared line copy plus aggregated size/SKU variants for RAG. Direction text is deduplicated per line; bare URL document refs are excluded.';


-- ── Part 2: chunk_document_text with 120-char minimum guard ──────────────────

CREATE OR REPLACE FUNCTION rag.chunk_document_text(
  p_body_text     text,
  p_title         text    DEFAULT NULL,
  p_max_chars     integer DEFAULT 2400,
  p_overlap_chars integer DEFAULT 200
)
RETURNS TABLE (
  chunk_index  integer,
  heading      text,
  section_path text[],
  chunk_text   text,
  token_count  integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rag, public
AS $$
DECLARE
  v_heading_re   constant text := '^[A-Za-z][A-Za-z0-9 /&()_-]*:$';
  v_title        text    := coalesce(nullif(trim(p_title), ''), 'Unknown product');

  v_lines        text[];
  v_n            integer;
  v_i            integer;
  v_line         text;

  v_cur_heading  text    := NULL;
  v_cur_body     text    := '';

  v_sec_headings text[]  := '{}';
  v_sec_bodies   text[]  := '{}';
  v_sec_n        integer := 0;

  v_chunk_idx    integer := 0;

  v_sec_heading  text;
  v_sec_slug     text;
  v_body         text;

  v_paragraphs   text[];
  v_para_n       integer;
  v_j            integer;
  v_para         text;
  v_sub_parts    text[]  := '{}';
  v_sub_chars    integer := 0;
  v_prev_text    text    := '';
  v_sub_body     text;
  v_overlap      text;
  v_final_text   text;
BEGIN
  -- Phase 1: line-by-line section detection
  v_lines := string_to_array(p_body_text, E'\n');
  v_n     := coalesce(array_length(v_lines, 1), 0);

  FOR v_i IN 1 .. v_n LOOP
    v_line := v_lines[v_i];

    IF trim(v_line) ~ v_heading_re THEN
      v_sec_n        := v_sec_n + 1;
      v_sec_headings := v_sec_headings || ARRAY[v_cur_heading];
      v_sec_bodies   := v_sec_bodies   || ARRAY[v_cur_body];
      v_cur_heading  := trim(trailing ':' from trim(v_line));
      v_cur_body     := '';
    ELSE
      v_cur_body := CASE
        WHEN v_cur_body = '' THEN v_line
        ELSE v_cur_body || E'\n' || v_line
      END;
    END IF;
  END LOOP;

  v_sec_n        := v_sec_n + 1;
  v_sec_headings := v_sec_headings || ARRAY[v_cur_heading];
  v_sec_bodies   := v_sec_bodies   || ARRAY[v_cur_body];

  -- Phase 2: emit chunks
  FOR v_i IN 1 .. v_sec_n LOOP
    v_sec_heading := v_sec_headings[v_i];
    v_body        := trim(v_sec_bodies[v_i]);

    CONTINUE WHEN v_body IS NULL OR length(v_body) < 30;

    v_sec_slug := CASE
      WHEN v_sec_heading IS NULL
        THEN 'overview'
      ELSE trim(both '_' from lower(regexp_replace(v_sec_heading, '[^a-z0-9]+', '_', 'gi')))
    END;

    -- Case A: section fits within the token budget
    IF length(v_body) <= p_max_chars THEN
      v_final_text := CASE
        WHEN v_sec_heading IS NULL
          THEN v_body
        ELSE 'Product: ' || v_title || E'\n' || v_body
      END;

      -- 120-char minimum guard: skip degenerate chunks
      IF length(v_final_text) >= 120 THEN
        chunk_index  := v_chunk_idx;
        heading      := coalesce(v_sec_heading, 'Overview');
        section_path := ARRAY['product_line_profile', v_sec_slug];
        chunk_text   := v_final_text;
        token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
        RETURN NEXT;
        v_chunk_idx := v_chunk_idx + 1;
      END IF;

    -- Case B: section exceeds budget -> sub-split with overlap
    ELSE
      v_paragraphs := regexp_split_to_array(v_body, E'\\n\\s*\\n+');
      v_para_n     := coalesce(array_length(v_paragraphs, 1), 0);
      v_sub_parts  := '{}';
      v_sub_chars  := 0;
      v_prev_text  := '';

      FOR v_j IN 1 .. v_para_n LOOP
        v_para := trim(v_paragraphs[v_j]);
        CONTINUE WHEN v_para = '';

        IF v_sub_chars + length(v_para) > p_max_chars AND v_sub_parts <> '{}' THEN
          v_sub_body := array_to_string(v_sub_parts, E'\n\n');
          v_overlap  := CASE
            WHEN v_prev_text <> '' AND p_overlap_chars > 0
              THEN '[...] ' || right(v_prev_text, p_overlap_chars) || E'\n\n'
            ELSE ''
          END;
          v_final_text := CASE
            WHEN v_sec_heading IS NULL
              THEN v_overlap || v_sub_body
            ELSE 'Product: ' || v_title || E'\n' || v_overlap || v_sub_body
          END;

          -- 120-char guard for sub-chunks
          IF length(v_final_text) >= 120 THEN
            chunk_index  := v_chunk_idx;
            heading      := coalesce(v_sec_heading, 'Overview');
            section_path := ARRAY['product_line_profile', v_sec_slug];
            chunk_text   := v_final_text;
            token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
            RETURN NEXT;
            v_chunk_idx := v_chunk_idx + 1;
          END IF;

          -- State machine updates happen outside the guard
          v_prev_text := v_sub_body;
          v_sub_parts := ARRAY[v_para];
          v_sub_chars := length(v_para);

        ELSE
          v_sub_parts := v_sub_parts || ARRAY[v_para];
          v_sub_chars := v_sub_chars + length(v_para);
        END IF;
      END LOOP;

      IF v_sub_parts <> '{}' THEN
        v_sub_body := array_to_string(v_sub_parts, E'\n\n');
        v_overlap  := CASE
          WHEN v_prev_text <> '' AND p_overlap_chars > 0
            THEN '[...] ' || right(v_prev_text, p_overlap_chars) || E'\n\n'
          ELSE ''
        END;
        v_final_text := CASE
          WHEN v_sec_heading IS NULL
            THEN v_overlap || v_sub_body
          ELSE 'Product: ' || v_title || E'\n' || v_overlap || v_sub_body
        END;

        -- 120-char guard for trailing sub-chunk
        IF length(v_final_text) >= 120 THEN
          chunk_index  := v_chunk_idx;
          heading      := coalesce(v_sec_heading, 'Overview');
          section_path := ARRAY['product_line_profile', v_sec_slug];
          chunk_text   := v_final_text;
          token_count  := ceil(length(v_final_text)::float / 4.0)::integer;
          RETURN NEXT;
          v_chunk_idx := v_chunk_idx + 1;
        END IF;
      END IF;

    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION rag.chunk_document_text(text, text, integer, integer) IS
  'Splits a product_line_profile document body into retrieval-ready chunks using heading-aware primary splitting and paragraph-level secondary splitting with overlap. Chunks shorter than 120 chars are suppressed.';

GRANT EXECUTE ON FUNCTION rag.chunk_document_text(text, text, integer, integer) TO service_role;


-- ── Part 3: Delete existing degenerate PLP chunks ────────────────────────────

DELETE FROM rag.document_chunk dc
USING rag.document d
WHERE d.id = dc.document_id
  AND d.document_kind = 'product_line_profile'
  AND length(dc.chunk_text) < 120;
