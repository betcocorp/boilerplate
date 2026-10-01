-- B0-264 pass 2 — extend dilution coverage from ALREADY-INGESTED documents (labels +
-- product_line_profile), staged through the dormant rag.document.* fact columns and promoted to
-- rag.product_line_fact with source_record_id provenance.
--
-- Pass 1 (20260724120000) mined legacy.product_direction_of_use and wrote 34 rows with
-- source_record_id = NULL. This pass uses a different source (rag.document) and therefore CAN cite
-- a source record, as this ticket's acceptance criteria require.
--
-- ============================================================================================
-- HEADLINE FINDING: the bottleneck is SOURCE-DOCUMENT COVERAGE, not extraction.
-- ============================================================================================
-- Measured live on 2026-08-26, over every rag.document linked (via rag.entity.product_line_key) to
-- a product line with no dilution answer:
--
--   effectively-uncovered product lines .................... 1,485
--   ...that have at least one ingested document ............ 1,485  (all of them)
--   ...whose documents print ANY `N oz/gal` figure .........    21
--   ...whose documents print an explicit RTU statement .....     3
--   SDS documents on uncovered lines ....................... 900 across 146 lines
--   ...of those 900 SDS that print an oz/gal figure ........     0
--
-- Every `1:N` string found in an SDS is chemical-name stoichiometry ("Carbonic acid disodium salt
-- (1:2)") or a diluted-product SDS title ("SenTec Pure Linen (Diluted 1:10)") — never a use
-- dilution. SDS is not a dilution source and is excluded from the extractor's source list.
--
-- So the extractable ceiling from the ingested corpus is roughly 30 lines, not ~1,548. After the
-- skip rules below, 4 lines survive. That is the honest number; the remaining ~98.6% of uncovered
-- lines cannot be covered until the underlying label PDFs are ingested (438 of 789 ingested label
-- documents are also not linked to any entity at all, so they are invisible to this pass).
--
-- ============================================================================================
-- EXTRACTION RULE SET
-- ============================================================================================
-- Implemented and unit-tested in src/lib/label/extract-dilution-from-label.ts (37 Vitest cases,
-- one per rule) and driven by scripts/extract-label-dilution.ts. Reuses pass 1's rule set verbatim
-- and adds six rules that pass-1's legacy-text source never exercised. A value is written ONLY when
-- the directions give ONE clear, unambiguous, general-use figure. Skipped otherwise:
--
--   pass-1 rules, unchanged:
--     ready_to_use ............ used undiluted / DO NOT DILUTE, no ratio
--     conflicting_use_modes ... use-modes give materially different figures, none marked primary
--     multi_tier_range ........ a printed range ("4 - 8 ounces per gallon"), no default tier
--     other_product_ratio ..... the ratio belongs to a DIFFERENT named product in a prep step
--     metric_only ............. metric-only (Canadian) directions; NEVER converted
--     capacity_dosing ......... dosed by trap/drain/pipe/weight capacity, not a water dilution
--
--   new in pass 2 (each one caught a real defect in this pass's own first draft):
--     non_per_gallon_dose ..... "3 fl. oz. per 10 gallons" — dividing to per-gallon is a conversion
--     not_a_water_dilution .... a printed CEILING ("Up to 12 ounces … per gallon of finish")
--     word_form_ratio ......... "Dilute with equal parts of water" — no printed 1:N or oz/gal
--     single_mode_of_many ..... several printed use-modes, only ONE prints a dilution (the others
--                               are direct application) — the inverse of the B0-265 defect
--     unreadable_value ........ garbled/unparseable printed number
--     no_directions_section ... the document has no Directions-for-Use block at all. A dilution in
--                               marketing `Description:` prose is deliberately NOT promoted.
--
-- The ONLY sanctioned derivation remains `128 / N` on a printed `1:N`. Where the manufacturer
-- printed its own oz figure, that printed figure is used verbatim in preference to a computed one.
-- dilution_display carries the verbatim printed text.
--
-- ============================================================================================
-- DEFECTS THIS PASS'S OWN REVIEW CAUGHT (proposals rejected before any write)
-- ============================================================================================
-- Every machine proposal was read back against the full verbatim source before acceptance. Nine
-- were wrong; each produced a new rule above:
--   1. Dry Time Extender ........... proposed 12 oz/gal. Real text: "Up to 12 ounces … can be added
--                                    per gallon of Basic Coatings water based finish" — an additive
--                                    ceiling into finish, not a water dilution. -> not_a_water_dilution
--   2. Liquid Presoak / Flatware ... proposed 2 oz/gal. Real text: "use 1 or 2 ounces per gallon" —
--                                    two printed alternatives. -> multi_tier_range
--   3. Lemon deodorant ............. proposed 5 oz/gal. Full directions print THREE doses: 5 oz/gal
--                                    (disinfect), "12 - 16 oz. of this product per gallon" (clean),
--                                    "2 - 4 oz." (deodorize). -> multi_tier_range
--   4. Neutral Disinfectant Cleaner  proposed 2 oz/gal from "1:64". Directions are metric-only
--      (Canada Only) bf88e096 ......  ("Use 16 mL per litre"; mildewstatic "4 mL per litre"); the
--                                    1:64 appears only inside the HIV-1 contact-time CLAIM
--                                    ("providing 600 ppm of active quaternary"). -> metric_only
--   5. Neutral Disinfectant Cleaner  same class, proposed 0.5 oz/gal from "1:256". -> metric_only
--      (Canada Only) 5b6f9688 ......
--   6. HYDROLINE SEALER ............ proposed 32 oz/gal from "Mixwood finish maintenance cleaner at
--                                    32 oz./gal." — OCR glued the verb to ANOTHER product's name.
--                                    -> other_product_ratio
--   7. HYDROLINEr PLUS ............. same. -> other_product_ratio
--   8. STREETSHOE 275 / 350 ........ same ("Mix wood finish maintenance cleaner at 32 oz./gal.").
--                                    -> other_product_ratio
--   9. Concrete Maintenance Stain &  proposed 0.5 oz/gal from "Saturate stained area with … Betco
--      Etch Remover Kit ............  Densiclean at 0.5 oz. per gallon (1:256)" — a multi-product
--                                    kit citing Densiclean's ratio. -> other_product_ratio
--  10. Ready-To-Use Multi-Purpose .. proposed 2 oz/gal. Real directions: SHOWERS / FLOORS / CARPETS
--      Cleaner (ae33040d) ..........  are all direct application; "GLASS/MIRROR CLEANER: Dilute
--                                    2 oz./gallon." is the ONLY diluted mode. Writing it to the
--                                    line would tell a customer to dilute an RTU product.
--                                    -> single_mode_of_many
--  11. SCORCH PLUS 1021 ............ "may be diluted 1:10 (13 ounces per gallon) with water" appears
--      (99523b5d) ..................  only in marketing `Description:` prose; the profile has no
--                                    Directions-for-Use block. EPA-registered herbicide — not
--                                    promoted. -> no_directions_section
--
-- ============================================================================================
-- FULL DISPOSITION (1,687 candidate documents across 1,525 uncovered lines)
-- ============================================================================================
--   written .......................    5 dispositions -> 4 distinct product lines (below)
--   no_directions_section .........  1,255
--   no_dilution_language ..........    358
--   multi_tier_range ..............     17
--   conflicting_use_modes .........     14
--   metric_only ...................     13
--   other_product_ratio ...........      9
--   non_per_gallon_dose ...........      6
--   ready_to_use (no explicit
--     printed statement) ..........      4
--   word_form_ratio ...............      2
--   capacity_dosing ...............      2
--   not_a_water_dilution ..........      1
--   single_mode_of_many ...........      1
--
-- Reproduce with:  node scripts/extract-label-dilution.ts
--
-- ============================================================================================
-- ROWS WRITTEN (4 lines) — each cited to its rag.source_record
-- ============================================================================================
--  A. OUTDOOR ODOR ELIMINATOR (7921f5f1) -> 6 oz/gal, display "6 oz. per gallon (1:20)"
--     Source: rag.document 4b75a98b (label "Bioda Outdoor Odor Eliminator — Lemon Sage Scent"),
--     source_record f5cb0eb6 = s3://retool-360/labels/1950-brands/2610_bioda-outdoor-odor-eliminator.md
--     Verbatim: "Pump Up Sprayer: Dilute 6 oz of product with 1 gallon of water…" and
--               "Other Hose End Sprayers: … Set sprayer to 6 oz. per gallon (1:20)…"
--     Both printed use-modes agree at 6 oz/gal; the printed oz figure is used, not 128/20 = 6.4.
--  B. One-Step (118c2231) -> "Ready to use". Source_record 7578b4e8 (label "GE Fight Bac RTU").
--     Verbatim: "Product is ready to use. DO NOT DILUTE."
--  C. One-Step (575c92ed) -> "Ready to use". Source_record 947a8e49 (product_line_profile "One-Step").
--     Verbatim: "DIRECTIONS FOR USE: Product is ready to use. DO NOT DILUTE."
--  D. Disinfectant Wipes (fcd81764) -> "Ready to use". Source_record 408704ce
--     (product_line_profile "GE Fight BacT Disinfectant Wipes (Canada)").
--     Verbatim: "DIRECTIONS FOR USE: Product is ready to use."
--
-- The three "Ready to use" rows follow the B0-265 precedent exactly: dilution_display is set and
-- dilution_oz_per_gal is left NULL — no numeric value is invented for an undiluted product. They
-- are only written where the document prints an explicit RTU statement AND contains no dilution
-- figure of any kind anywhere (the B0-265 trap: "Ready-to-Use Deodorizing Liquid" prints a real
-- 13 oz./gal. trigger-sprayer dilution despite its name).
--
-- confidence = 0.75 on every row, the same value pass 1 used for automated-extraction rows, so
-- src/lib/retrieval/product-facts.ts renders each one with its "(confidence 0.75)" caveat.
--
-- SKU-LEVEL OVERRIDES: none written. All 254 label-linked `product`-tier entities have a NULL
-- metadata->>'product_key', so there is no key to hang a product_key override on; and no label in
-- the candidate set prints a genuinely per-variant dilution. (The Bioda label's parenthetical
-- "Ready-to-use 1 QT variant with hose-end sprayer" is an editorial note in the ingested markdown,
-- not a printed per-SKU dilution.) 145 SKU-tier rows already exist from a separate pass and are
-- untouched here; the B0-634 tier merge in product-facts.ts already surfaces them at line level
-- when they agree.
--
-- Idempotent: the promote only touches rows whose dilution columns are still both NULL.

-- --------------------------------------------------------------------------------------------
-- 1) STAGE — write the extracted numeric value into the dormant rag.document fact column
--    (20260713030000_rec_add_product_attribute_columns.sql). Only the one numeric extraction can
--    be staged: rag.document has `dilution_oz_per_gal` but NO `dilution_display` counterpart, so
--    the three "Ready to use" dispositions have nowhere to stage and are promoted directly below.
-- --------------------------------------------------------------------------------------------
update rag.document
set dilution_oz_per_gal = 6,
    updated_at = timezone('utc', now())
where id = '4b75a98b-727d-4806-88ef-2328a9a77650'
  and dilution_oz_per_gal is null;

-- --------------------------------------------------------------------------------------------
-- 2) PROMOTE the staged value -> rag.product_line_fact, reading the number back out of
--    rag.document and carrying that document's source_record_id as provenance.
-- --------------------------------------------------------------------------------------------
insert into rag.product_line_fact (
  entity_id, product_key, dilution_oz_per_gal, dilution_display, confidence, source_record_id
)
select line.id,
       null,
       doc.dilution_oz_per_gal,
       '6 oz. per gallon (1:20)',  -- verbatim printed text from the label
       0.75,
       doc.source_record_id
from rag.document doc
join rag.entity src on src.id = doc.entity_id
join rag.entity line
  on line.product_line_key = src.product_line_key
 and line.entity_type = 'product_line'
where doc.id = '4b75a98b-727d-4806-88ef-2328a9a77650'
  and doc.dilution_oz_per_gal is not null
on conflict (entity_id) where product_key is null
do update set
  dilution_oz_per_gal = excluded.dilution_oz_per_gal,
  dilution_display    = excluded.dilution_display,
  confidence          = excluded.confidence,
  source_record_id    = excluded.source_record_id,
  updated_at          = timezone('utc', now())
where rag.product_line_fact.dilution_oz_per_gal is null
  and rag.product_line_fact.dilution_display is null;

-- --------------------------------------------------------------------------------------------
-- 3) PROMOTE the explicit ready-to-use statements. dilution_oz_per_gal stays NULL by design.
-- --------------------------------------------------------------------------------------------
insert into rag.product_line_fact (
  entity_id, product_key, dilution_oz_per_gal, dilution_display, confidence, source_record_id
)
values
  -- One-Step — label "GE Fight Bac RTU": "Product is ready to use. DO NOT DILUTE."
  ('118c2231-ad11-442f-b8c6-f3031d9a7e02', null, null, 'Ready to use', 0.75,
   '7578b4e8-6027-445c-90c1-835e8e8c6085'),
  -- One-Step — profile "One-Step": "DIRECTIONS FOR USE: Product is ready to use. DO NOT DILUTE."
  ('575c92ed-2b3e-4bc6-821f-8e27ebe4271c', null, null, 'Ready to use', 0.75,
   '947a8e49-eb20-4fa3-96b6-f8f20a0df6ae'),
  -- Disinfectant Wipes — profile "GE Fight BacT Disinfectant Wipes (Canada)":
  -- "DIRECTIONS FOR USE: Product is ready to use."
  ('fcd81764-2fae-45bb-bc6b-f0f0a16b49e7', null, null, 'Ready to use', 0.75,
   '408704ce-939a-45ba-ab7a-edec916eaeb9')
on conflict (entity_id) where product_key is null
do update set
  dilution_display = excluded.dilution_display,
  confidence       = excluded.confidence,
  source_record_id = excluded.source_record_id,
  updated_at       = timezone('utc', now())
where rag.product_line_fact.dilution_oz_per_gal is null
  and rag.product_line_fact.dilution_display is null;
