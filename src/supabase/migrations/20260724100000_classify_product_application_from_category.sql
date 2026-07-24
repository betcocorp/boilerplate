-- B0-263: populate rag.product_line_fact.product_application from Betco's existing
-- public.product_category / product_category_link taxonomy (an already-curated,
-- already-confidence-scored classification -- not a guess from title keywords).
--
-- This is an inference pass, not a stamped fact (per the ticket): product_application
-- must NOT be silently treated as authoritative as dilution/EPA-reg values are. The
-- shared rag.product_line_fact.confidence column already means "trust for this whole
-- row" (e.g. 1.0 for a B0-194 dilution backfill) -- overwriting it here would wrongly
-- downgrade trust in unrelated, already-verified fields on the same row. So this adds
-- two new columns scoped to this one field instead of reusing the shared column.
alter table rag.product_line_fact
  add column if not exists product_application_confidence numeric,
  add column if not exists product_application_source text;

comment on column rag.product_line_fact.product_application_confidence is
  'Confidence for product_application specifically (independent of the row-level confidence column, which reflects other fields such as dilution). Always < 1.0 for classifier-derived values -- never silently authoritative.';
comment on column rag.product_line_fact.product_application_source is
  'Provenance for product_application, e.g. product_category_taxonomy (B0-263). Null when product_application was set some other way.';

-- Mapping from Betco's existing category names (public.product_category.name) to the
-- product_application vocabulary. Deliberately conservative: only unambiguous surface/
-- application categories are mapped; packaging/format descriptors (Concentrate, RTU,
-- Aerosol, Bulk, Solids, Sprays, Water Based), industry/vertical segments (Healthcare,
-- Hospitality, Industrial, University Athletic Depts.), and vague/ambiguous names
-- (Specialties, Break, Dilution Control, Probiotic Solutions, Gen'l Chemical Mgt,
-- Mild Acid Cleaner) are intentionally excluded rather than guessed at.
with category_application_map (category_name, application) as (
  values
    ('Disinfectants', 'disinfectant'),
    ('Disinfectant Wipes', 'disinfectant'),
    ('Sanitizers', 'sanitizer'),
    ('Santitizers', 'sanitizer'), -- source data typo, kept verbatim for the join
    ('Degreasers', 'degreaser'),
    ('Aqueous Based Dgr', 'degreaser'),
    ('Solvent Dgrsr', 'degreaser'),
    ('Butyl Based Dgrsr', 'degreaser'),
    ('NonButyl Dgrsr', 'degreaser'),
    ('RTU Degreaser', 'degreaser'),
    ('Glass', 'glass'),
    ('Bowl Cleaners', 'bathroom'),
    ('Restroom Speciality', 'bathroom'),
    ('Restrooms', 'bathroom'),
    ('Carpet', 'carpet'),
    ('Spot & Reclaim', 'carpet'),
    ('Spotters', 'carpet'),
    ('Stain and Reclaim', 'carpet'),
    ('Strippers', 'floor-finish'),
    ('Sealers', 'floor-finish'),
    ('WB Sealers', 'floor-finish'),
    ('Wood', 'floor-finish'),
    ('Concrete & Terrazzo', 'floor-finish'),
    ('Floor Care', 'floor-finish'),
    ('Polishes', 'floor-finish'),
    ('Maintainer', 'floor-finish'),
    ('Maintainers', 'floor-finish'),
    ('Oil Modified Maint', 'floor-finish'),
    ('WB Maintenance', 'floor-finish'),
    ('Frequent Maintenance', 'floor-finish'),
    ('Low Maintenance', 'floor-finish'),
    ('Resilient', 'floor-finish'),
    ('Countertop', 'countertop'),
    ('Hand Soaps', 'hand-soap'),
    ('Shampoo/Body Wash', 'hand-soap'),
    ('Vehicle Washes', 'vehicle-wash'),
    ('Dish Machine', 'warewash'),
    ('Manual Pot & Pan Detergents', 'warewash'),
    ('High Temp Detergents', 'warewash'),
    ('High Temp Rinse Aids', 'warewash'),
    ('Delimers', 'warewash'),
    ('Laundry Specialites', 'laundry'),
    ('Sour & Softener', 'laundry'),
    ('Top Load', 'laundry'),
    ('Presoak Products', 'laundry'),
    ('All Purpose', 'general-cleaner'),
    ('All-Purpose', 'general-cleaner'),
    ('General Cleaning', 'general-cleaner'),
    ('Cleaners', 'general-cleaner'),
    ('General Cleaning Drain Maint.', 'drain-maintenance'),
    ('Defoamers', 'defoamer')
),
line_applications as (
  select
    e.id as entity_id,
    string_agg(distinct m.application, ', ' order by m.application) as product_application,
    -- Conservative fixed confidence for a taxonomy-derived classification (never 1.0).
    -- Lines matching more than one distinct application get a slightly lower confidence
    -- to reflect the added ambiguity of a multi-value result.
    case when count(distinct m.application) > 1 then 0.7 else 0.8 end as confidence
  from public.product_category_link pcl
  join public.product_category pc on pc.key = pcl.category_key
  join category_application_map m on lower(trim(pc.name)) = lower(trim(m.category_name))
  join rag.entity e
    on e.entity_type = 'product_line'
   and e.product_line_key = pcl.prod_line_key
  group by e.id
)
insert into rag.product_line_fact (entity_id, product_application, product_application_confidence, product_application_source, confidence)
select
  la.entity_id,
  la.product_application,
  la.confidence,
  'product_category_taxonomy',
  la.confidence
from line_applications la
on conflict (entity_id) where product_key is null
do update
  set product_application = excluded.product_application,
      product_application_confidence = excluded.product_application_confidence,
      product_application_source = excluded.product_application_source;
      -- Deliberately NOT touching `confidence`, `dilution_*`, `coverage_sq_ft`, etc. on
      -- conflict -- this must not disturb trust in fields populated by a different,
      -- unrelated process (e.g. the B0-194 dilution backfill).
