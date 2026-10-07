-- Link the resolvable remainder of entity-less label documents to a product LINE entity.
--
-- Follow-on to B0-249 (20260724090000_link_unambiguous_label_docs_to_active_products.sql),
-- which linked 108 label docs at PRODUCT grain via rag.product_alias and left the rest.
-- 535 label documents still had entity_id IS NULL. Investigation of that remainder:
--
--   * The label metadata is already fully parsed at ingestion (sku, brand, sds_number,
--     epa_reg_no, din_no). Re-parsing the markdown bodies adds nothing -- and for the 122
--     docs with extraction_method='ocr' / needs_review=true the bodies are visibly corrupted,
--     so mining identifiers out of them would be fabricating regulated data. This migration
--     therefore joins on metadata only and never reads body text.
--
--   * The blocker is coverage, not extraction: rag.entity was built from ACTIVE rows of
--     legacy.products, and labels outlive that scope. Of the 535, only 100 can reach an
--     existing entity at all. The rest are deliberately out of scope here:
--       - 138 Betco labels whose SKU prefix-matches legacy.products rows that are all
--         Status='IN' with zero corresponding rag.entity row. Linking them means deciding to
--         model discontinued products as entities; their absence currently encodes that
--         status, and the regulated-data rule forbids inferring active/discontinued. Left
--         alone -- that is a modeling decision, not a data fix.
--       - 183 EnviroZyme / Basic Coatings labels whose SKU namespace is essentially absent
--         from the ERP master (of 13,750 legacy.products rows: ARL*=0, GTP*=1, FML*=18).
--         Creating entities for these would mean standing up a product master for two brands
--         out of label OCR, which would collide with the separate product-entity effort that
--         already seeded a different product tier into rag.entity/rag.product_alias.
--       - 13 "1950" labels with no SKU match, no title match and no sds_number.
--
-- Grain: this links to the PRODUCT_LINE-tier entity, not the product tier. That is deliberate.
-- A label SKU routinely covers several package-size product variants -- of the 50 Betco docs
-- with a SKU candidate, only 10 resolve to a single product entity but 48 resolve to a single
-- product_line. The line is the grain the label actually describes (one label, one formulation,
-- many pack sizes), and it is the grain rag.product_alias resolution already works in.
--
-- Two methods, recorded per row for traceability:
--   label_sku_alias_line (confidence 1.0) -- metadata->>'sku' matches a rag.product_alias row
--     exactly or as a '<sku>-%' package-suffix prefix, and every match rolls up to one line.
--   label_title_exact_line (confidence 0.8) -- normalized label title equals a normalized
--     entity title resolving to one line. Weaker, and gated by two guards below.
--
-- Title-match guards. rag.entity carries NO brand field (no metadata->>'brand' on any row), so
-- an exact title match cannot be disambiguated by brand. Verified live: there is exactly one
-- "Garbage Disposal Cleaner" product line, and both a Betco label (sku 2605) and an EnviroZyme
-- label (sku gtp328) title-match it -- at least one of those links would be wrong. Hence:
--   Guard A: skip any label title held by untied labels of more than one brand.
--   Guard B: skip when every product-tier entity on the target line is equipment/parts
--            (InvtID LIKE 'E%'). Catches the Betco chemical label "Insulator" resolving onto
--            the "Structural" spare-parts line.
-- These guards drop 3 docs (2 x garbage disposal cleaner, 1 x insulator). SKU matches are not
-- subject to them -- a SKU is already brand-unique.
--
-- Idempotent: deterministic UPDATE scoped to entity_id IS NULL; re-running is a no-op.
-- Reversible: every row written carries metadata->'product_entity_match' identifying it.

with untied as (
  select d.id,
         d.metadata->>'brand' as brand,
         lower(trim(d.metadata->>'sku')) as sku,
         lower(regexp_replace(trim(d.title), '\s+', ' ', 'g')) as tnorm
  from rag.document d
  where d.document_kind = 'label'
    and d.entity_id is null
),

-- Method 1: SKU alias -> exactly one product line.
sku_line as (
  select u.id, min(e.product_line_key) as plk
  from untied u
  join rag.product_alias pa
    on pa.alias_norm = u.sku
    or pa.alias_norm like u.sku || '-%'
  join rag.entity e
    on e.id = pa.entity_id
   and e.entity_type = 'product'
  where u.sku is not null
  group by u.id
  having count(distinct e.product_line_key) = 1
),

-- Guard A: a label title used by more than one brand cannot be brand-disambiguated.
multi_brand_titles as (
  select tnorm
  from untied
  group by tnorm
  having count(distinct brand) > 1
),

-- Method 2 candidates: exact normalized title -> exactly one product line.
title_line as (
  select u.id, u.tnorm, min(e.product_line_key) as plk
  from untied u
  join rag.entity e
    on lower(regexp_replace(trim(e.title), '\s+', ' ', 'g')) = u.tnorm
   and e.product_line_key is not null
  where u.tnorm not in (select tnorm from multi_brand_titles)
  group by u.id, u.tnorm
  having count(distinct e.product_line_key) = 1
),

-- Guard B: drop title matches whose target line is entirely equipment/parts. A line with no
-- product-tier entities at all is NOT equipment -- that is just line-only modeling, which is
-- the normal shape for EnviroZyme / Basic Coatings -- so it must pass.
title_line_guarded as (
  select t.id, t.plk
  from title_line t
  where not exists (
    select 1
    from rag.entity pe
    where pe.product_line_key = t.plk
      and pe.entity_type = 'product'
  )
  or exists (
    select 1
    from rag.entity pe
    where pe.product_line_key = t.plk
      and pe.entity_type = 'product'
      and coalesce(pe.metadata->>'InvtID', '') not like 'E%'
  )
),

-- SKU wins over title where both resolve.
resolved as (
  select u.id,
         coalesce(s.plk, t.plk) as plk,
         case when s.plk is not null then 'label_sku_alias_line' else 'label_title_exact_line' end as method,
         case when s.plk is not null then 1.0 else 0.8 end as confidence
  from untied u
  left join sku_line s on s.id = u.id
  left join title_line_guarded t on t.id = u.id
  where coalesce(s.plk, t.plk) is not null
),

-- Resolve the line to its product_line-tier entity (one per line; verified live).
targeted as (
  select r.id, r.method, r.confidence, ple.id as entity_id, r.plk
  from resolved r
  join rag.entity ple
    on ple.product_line_key = r.plk
   and ple.entity_type = 'product_line'
)

update rag.document d
set entity_id = tg.entity_id,
    metadata = d.metadata || jsonb_build_object(
      'product_entity_match', jsonb_build_object(
        'method', tg.method,
        'confidence', tg.confidence,
        'grain', 'product_line',
        'product_line_key', tg.plk,
        'ticket', 'B0-249-followup'
      )
    ),
    updated_at = timezone('utc', now())
from targeted tg
where tg.id = d.id
  and d.entity_id is null;
