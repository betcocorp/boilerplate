-- B0-194 — Backfill product_line_fact from rag.entity.metadata (unblocked immediate win).
-- Source: legacy-derived entity metadata. dilution_code is the 1:N ratio denominator
-- (0 = ready-to-use / not diluted); coverage_sq_ft is sq ft per gallon.
-- Validated read-only against live data (2026-07-15): 155 dilution rows (81 computable, 74 RTU),
-- 145 coverage rows, 0 non-numeric parse failures.
-- Idempotent: re-running refreshes the line-level row per entity.

insert into rag.product_line_fact (
  entity_id, product_key, dilution_oz_per_gal, dilution_display, coverage_sq_ft, confidence, updated_at
)
select
  e.id,
  null::text as product_key,
  case when e.dc ~ '^[0-9]+$' and e.dc::numeric > 0
       then round(128.0 / e.dc::numeric, 3) end                     as dilution_oz_per_gal,
  case when e.dc = '0'            then 'RTU / not diluted'
       when e.dc ~ '^[0-9]+$'     then '1:' || e.dc
       else e.dc end                                                as dilution_display,
  case when e.cov ~ '^[0-9.]+$'   then e.cov::numeric end           as coverage_sq_ft,
  1.0,
  timezone('utc', now())
from (
  select id,
         nullif(metadata->>'dilution_code', 'NULL') as dc,
         nullif(metadata->>'coverage_sq_ft', '')    as cov
  from rag.entity
  where entity_type = 'product_line'
) e
where e.dc is not null or e.cov is not null
on conflict (entity_id) where (product_key is null)
do update set
  dilution_oz_per_gal = excluded.dilution_oz_per_gal,
  dilution_display    = excluded.dilution_display,
  coverage_sq_ft      = excluded.coverage_sq_ft,
  confidence          = excluded.confidence,
  updated_at          = excluded.updated_at;

-- Expected result: ~155 line-level rows (dilution and/or coverage populated).
-- NOTE (SME): the 1:N → oz/gal conversion is an interpretation of dilution_code per
-- rag-specification.md §2.3. dilution_display preserves the source value verbatim; spot-check
-- unusual denominators (e.g. 370, 416, 427, 665, 832) before exposing computed oz/gal to users.
