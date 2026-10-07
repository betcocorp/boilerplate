-- B0-264: Extract dilution_oz_per_gal / dilution_display from legacy Directions-for-Use
-- text for product_line entities that have NO dilution_code at all (metadata->>'dilution_code'
-- is null/empty), narrowed to the 74-line candidate set that:
--   1) has ANY "Directions for Use" text (legacy.prod_line_attr AttrTable='productdirectionofuse'
--      joined to legacy.product_direction_of_use), AND
--   2) matches the dilution keyword regex: oz\.?\s*/?\s*(per\s+)?gal|dilut|1\s*:\s*[0-9]
--
-- Candidate set was pulled in 8 batches (limit 10, ordered by title) and every row's FULL
-- directions_text was read in full before any decision was made. Do NOT touch B0-265's target
-- lines (the 74 dilution_code='0' lines) -- disjoint set, handled in parallel.
--
-- Extraction rule: only write a value when the text gives ONE clear, unambiguous, general/
-- primary-use ratio. Skip (leave null, no row written) when:
--   - the product is used undiluted / RTU ("DO NOT DILUTE"),
--   - multiple different use-modes give materially different ratios with no ratio marked as
--     primary/default (e.g. trigger sprayer vs. mop bucket disagree; light/medium/heavy soil
--     tiers with none marked as the default),
--   - the only dilution ratio in the text belongs to a DIFFERENT named product referenced in a
--     prep step (e.g. "Mix Squeaky Cleaner at 32 oz./gal...") rather than to this product line,
--   - the value is inherently a multi-tier range with no single defensible general-use number,
--   - the label is metric-only (Canada) with no printed oz/gal, avoiding any unit conversion,
--   - the text describes dosing by container/trap capacity rather than a water dilution.
-- Where a "normal"/"light to medium" tier is explicitly contrasted with a "heavy" tier, the
-- normal/light-to-medium tier is treated as the defensible general-use default. Where a
-- verbatim ratio (e.g. "1:256") appears with no accompanying oz number (or a garbled character
-- in place of one) but is otherwise unambiguous, dilution_oz_per_gal is computed as exactly
-- 128/N (one gallon = 128 oz) per the ticket's own sanctioned example; where the manufacturer
-- printed its own (possibly rounded) oz number alongside the ratio, that printed number is used
-- verbatim instead of the computed one. confidence = 0.75 for every written row (automated,
-- unreviewed, but defensible). source_record_id is left NULL (data comes from
-- legacy.product_direction_of_use, not a rag.source_record-backed document); dilution_display
-- carries the citation-safe verbatim text instead.
--
-- Full per-candidate disposition (74 rows, ordered by title):
--   1. #108 WITH GREEN COLOR                              -> skip: used undiluted, no ratio
--   2. 1 Minute Disinfectant                               -> extract 1:256 / 0.5 oz/gal
--   3. 5 Minute Alkaline Disinfectant                      -> extract 1:256 / 0.5 oz/gal
--   4. Aggressive No-Rinse Stripper                        -> extract 13 oz./gal. (normal strip)
--   5. Aggressive Wood Floor Cleaner (97BC57A6)             -> extract 4 oz. per gallon
--   6. Aggressive Wood Floor Cleaner (FA6C0740)             -> extract 4 oz. per gallon
--   7. All Purpose Cleaner and Odor Eliminator              -> skip: many app-specific ranges, no primary
--   8. An Ultra-Concentrated Emulsified Built Detergent     -> skip: light/med/heavy ranges, no default marked
--   9. BESTSCENTT VERY BERRY 3000                           -> extract 13 oz./gal. (trigger = mop bucket)
--  10. Broad Spectrum Disinfectant Cleaner                  -> extract 2 ounces per gallon
--  11. Carpet and Upholstery Shampoo                        -> skip: many machine/soil variants, no default
--  12. Citrus Cleaner and Degreaser                         -> skip: ranges for different applications
--  13. Clear Waterbased Sport Foor Finish                   -> skip: ratio belongs to "Squeaky Cleaner", not this product
--  14. Clear Waterbased Two Component Sport Finish          -> skip: ratio belongs to "Betco GT Cleaner"
--  15. Concentrated Air Freshener Liquid                    -> extract 13 oz./gal. (trigger = mop bucket)
--  16. Concentrated Deodorizing Liquid (773AD5C2)           -> extract 13 oz./gal.
--  17. Concentrated Deodorizing Liquid (67385609)           -> extract 13 oz./gal.
--  18. Concentrated Deodorizing Liquid (167025B5)           -> extract 13 oz./gal.
--  19. Concentrated Deodorizing Liquid (D8185CBD)           -> extract 13 oz./gal.
--  20. Concentrated Malodor Eliminator (64422AF6)           -> skip: trigger 6oz vs mop 2oz disagree
--  21. Concentrated Malodor Eliminator (9954F110)           -> skip: trigger 6oz vs mop 2oz disagree
--  22. Concentrated Malodor Eliminator (41ACB546)           -> skip: trigger 13oz vs floors 2oz disagree
--  23. Concentrated Malodor Eliminator (5F74080D)           -> skip: trigger 13oz vs floors 2oz disagree
--  24. Concentrated Malodor Eliminator (E5A06FEB)           -> skip: trigger 6oz vs mop 2oz disagree
--  25. Concentrated Malodor Eliminator (7F780F3A)           -> skip: trigger 6oz vs mop 2oz disagree
--  26. Concentrated Neutral Disinfectant Cleaner            -> extract 1:256 / 1/2 ounce per gallon (stated verbatim)
--  27. Concentrated Stripper for Permanent Coatings         -> extract 10 oz. per gallon (light-to-medium tier)
--  28. Concrete Maintenance Stain & Etch Remover Kit        -> skip: multi-product kit, ratio not clearly this SKU's own
--  29. Daily Cleaner and Protectant (58799BA3)              -> extract 2 oz./gal.
--  30. Daily Cleaner and Protectant (60324871)              -> extract 2 oz./gal.
--  31. Disinfectant                                         -> extract 1:64 / 2 oz per gallon
--  32. Disinfectant Cleaner                                 -> extract 1:256 / 1/2 ounce per gallon (stated verbatim)
--  33. Drain and Grease Trap Cleaner and Maintainer         -> skip: capacity-based dosing, not a water dilution
--  34. Drain Maintainer                                     -> skip: capacity-based dosing + only a floors range
--  35. Dumpster Cleaner and Odor Eliminator                 -> extract 6 ounces per gallon (1:20, stated verbatim)
--  36. Grinding & Honing Compound                           -> skip: ratio ambiguous between DensiClean/LiquiGrind sub-SKUs
--  37. Heavy Duty Vehicle Cleaner                           -> skip: heavy vs light soil, no default marked
--  38. High Power                                           -> extract 10 oz. /gal. (light-to-medium tier)
--  39. High Temperature Rinse Aid                           -> extract 1:256 / 0.5 oz/gal
--  40. HYDROLINE SEALER                                     -> skip: ratio belongs to "wood finish maintenance cleaner"
--  41. HYDROLINEr PLUS                                      -> skip: ratio belongs to "wood finish maintenance cleaner"
--  42. Industrial Degreaser                                 -> skip: light/moderate/heavy ranges, no default marked
--  43. Kitchen Cleaner & Degreaser                          -> skip: light/moderate/heavy tiers, no default marked
--  44. Lavender Multi Purpose Cleaner (B32F4F27)            -> extract 2 oz./gal.
--  45. Lavender Multi Purpose Cleaner (2E5DA16C)            -> skip: surfaces 2oz vs floors 1oz disagree
--  46. Lemon deodorant                                      -> skip: 3 distinct-purpose dilutions, no clear primary
--  47. LVT/Multi-Surface Stripper                           -> extract 12 oz. /gal. (light-to-medium tier)
--  48. Maintenance Cleaner for Wood Floors (1C3402A8)       -> skip: ambiguous "1:4" notation + multiple ranges
--  49. Maintenance Cleaner for Wood Floors (FF47C258)       -> skip: ambiguous "1:4" notation + multiple ranges
--  50. Multi-Purpose Acid Cleaner and Delimer                -> skip: heavy vs light build-up, no default marked
--  51. Multi-Purpose Cleaner/Deodorizer                      -> skip: surfaces 12oz vs floors 8oz disagree
--  52. Natural Degreaser & Deodorizer                        -> extract 4 oz/gal. (consistent across both uses)
--  53. Neutral Daily Floor Cleaner                           -> extract 0.5 US oz./US gal.
--  54. Neutral Disinfectant Cleaner (Canada Only) (EE1A5D28) -> skip: metric-only label, no printed oz/gal
--  55. Neutral Disinfectant Cleaner (Canada Only) (3B8F2C54) -> skip: metric-only label, no printed oz/gal
--  56. Non-Ammoniated Wax and Finish Stripper                -> extract 13 oz./gal. (normal strip)
--  57. Non-Butyl/Non-Ammoniated Floor Stripper               -> extract 25.6 oz./gal. (exact match to 1:5)
--  58. One-Step (F1AC4836)                                   -> skip: RTU, DO NOT DILUTE
--  59. One-Step (B332DBA3)                                   -> skip: RTU, DO NOT DILUTE
--  60. Oxygen Stain Remover for Kitchens                     -> skip: many different applications/units, mostly ranges
--  61. Paint                                                 -> extract (1:1) / 128 oz/gal (exact)
--  62. Peroxide Disinfectant Cleaner                         -> extract 1:64 / 2 oz per gallon (combined clean/disinfect/deodorize)
--  63. Peroxide Hospital Disinfectant Cleaner                -> extract 1:20 / 6.5 oz per gallon (disinfection-specific, matches product name)
--  64. SANIBET 256                                           -> extract 1:256 / 0.5 oz/gal
--  65. Soft Surface Cleaner                                  -> extract 2 oz./gal. (primary; heavy-soil variant is 4 oz./gal)
--  66. SPECIAL #150 BUT CHANGED COLOR                        -> skip: surfaces 6oz vs floors 2oz disagree
--  67. STREETSHOE 275                                        -> skip: ratio belongs to "wood finish maintenance cleaner"
--  68. STREETSHOE 350                                        -> skip: ratio belongs to "wood finish maintenance cleaner"
--  69. Super concentrated hand dishwashing detergent (lower) -> extract 0.25 oz./gal.
--  70. Super Concentrated Hand Dishwashing Detergent (upper) -> extract display-only "0.5 - 2 oz. per 10 gallons" (range; oz/gal left null)
--  71. Thickened Disinfectant Toilet Bowl Cleaner            -> skip: direct-ounce application, not a per-gallon dilution
--  72. Tote Dispensing System                                -> skip: dispenser hardware description, no ratio given
--  73. Two Component Waterbased Sport Floor Finish           -> skip: ratio belongs to "Squeaky Cleaner"
--  74. Water-Based High Traffic Wood Floor Finish            -> skip: ratio belongs to "Squeaky Cleaner"
--
-- 34 of the 74 candidates get a written value; 40 are left null (skipped) per the reasoning above.

insert into rag.product_line_fact (entity_id, dilution_oz_per_gal, dilution_display, confidence, source_record_id)
values
  ('f905908a-342f-46a3-9f58-d40660bf0cba', 0.5,   '1:256',                          0.75, null), -- 1 Minute Disinfectant
  ('7b8810da-ea50-4ce1-a220-9ff6063a0e80', 0.5,   '1:256',                          0.75, null), -- 5 Minute Alkaline Disinfectant
  ('13517166-9f7c-4f23-8397-982198eca9f1', 13,    '13 oz./gal.',                    0.75, null), -- Aggressive No-Rinse Stripper
  ('73a68da3-4569-4abd-aae7-6bd986437121', 4,     '4 oz. per gallon',               0.75, null), -- Aggressive Wood Floor Cleaner
  ('fa9350f3-8862-47d0-a5f1-0f208a7c8799', 4,     '4 oz. per gallon',               0.75, null), -- Aggressive Wood Floor Cleaner
  ('2440542a-09f4-44a9-9802-7da9df3998f9', 2,     '2 ounces per gallon',            0.75, null), -- Broad Spectrum Disinfectant Cleaner
  ('cf2e0785-31d2-46fb-b1e0-29b154f49952', 13,    '13 oz./gal.',                    0.75, null), -- BESTSCENTT VERY BERRY 3000
  ('af118eda-1371-4604-b0f6-0f5744137544', 13,    '13 oz./gal.',                    0.75, null), -- Concentrated Air Freshener Liquid
  ('c294fa3c-1e21-4553-adca-f5185e2cbfa0', 13,    '13 oz./gal.',                    0.75, null), -- Concentrated Deodorizing Liquid
  ('d119f1c7-c022-4c95-8b5c-50318e7e5909', 13,    '13 oz./gal.',                    0.75, null), -- Concentrated Deodorizing Liquid
  ('8ebf2413-c485-489a-b46b-9763c8d67b78', 13,    '13 oz./gal.',                    0.75, null), -- Concentrated Deodorizing Liquid
  ('91c2c39a-42a0-4b71-96fb-649156f0bf1c', 13,    '13 oz./gal.',                    0.75, null), -- Concentrated Deodorizing Liquid
  ('851f5674-6b94-4c7c-9c4b-a1584391806a', 0.5,   '1:256',                          0.75, null), -- Concentrated Neutral Disinfectant Cleaner
  ('d1d2e639-ff21-4762-9348-99a216476b3d', 10,    '10 oz. per gallon',              0.75, null), -- Concentrated Stripper for Permanent Coatings
  ('31286018-9548-4adc-bc4f-31d4ab8f87b4', 2,     '2 oz./gal.',                     0.75, null), -- Daily Cleaner and Protectant
  ('d95421ac-2af4-429c-a4c3-400845da9521', 2,     '2 oz./gal.',                     0.75, null), -- Daily Cleaner and Protectant
  ('aca83ec1-d432-48b2-a208-5438fa6476e5', 2,     '1:64',                           0.75, null), -- Disinfectant
  ('d2babcdd-021f-4a46-bf70-82610af19e36', 0.5,   '1:256',                          0.75, null), -- Disinfectant Cleaner
  ('cd1e1c60-4fe9-42aa-ac63-7d29eda2a2e2', 6,     '6 ounces per gallon',            0.75, null), -- Dumpster Cleaner and Odor Eliminator
  ('578d833a-faa9-4b95-b086-607445c03e6b', 10,    '10 oz. /gal.',                   0.75, null), -- High Power
  ('b9777b07-07be-482f-826b-61bd6e94c98d', 0.5,   '1:256',                          0.75, null), -- High Temperature Rinse Aid
  ('cc9a4a97-925d-4a80-8e45-beff57d1a02a', 12,    '12 oz. /gal.',                   0.75, null), -- LVT/Multi-Surface Stripper
  ('fa959dd8-d5d2-4379-846d-d302712cd016', 2,     '2 oz./gal.',                     0.75, null), -- Lavender Multi Purpose Cleaner
  ('c52139b8-4f0c-4758-a89f-2a8ac9ea4a10', 4,     '4 oz/gal.',                      0.75, null), -- Natural Degreaser & Deodorizer
  ('bf8c2faa-58a6-4f67-be1d-3ea81cd1aea5', 0.5,   '0.5 US oz./US gal.',             0.75, null), -- Neutral Daily Floor Cleaner
  ('d3e61fe5-dec8-421c-aae0-6014aca153ab', 13,    '13 oz./gal.',                    0.75, null), -- Non-Ammoniated Wax and Finish Stripper
  ('2d4bfb6c-d8d3-4eaf-8101-b8ff55e254bc', 25.6,  '25.6 oz./gal.',                  0.75, null), -- Non-Butyl/Non-Ammoniated Floor Stripper
  ('948f2b92-ae69-4e5d-808c-79aa52f80140', 128,   '(1:1)',                          0.75, null), -- Paint
  ('c3ea066a-6cc2-4e67-9f53-5f496bed794c', 2,     '1:64',                           0.75, null), -- Peroxide Disinfectant Cleaner
  ('f29a6184-5aad-4721-9020-1b354be0f4cb', 6.5,   '1:20',                           0.75, null), -- Peroxide Hospital Disinfectant Cleaner
  ('0f73226d-bb88-44dc-a9a5-0da208df18dc', 0.5,   '1:256',                          0.75, null), -- SANIBET 256
  ('d7ac3c55-6594-49a2-8a80-2c753605b054', 2,     '2 oz./gal.',                     0.75, null), -- Soft Surface Cleaner
  ('a23941ca-c69d-4941-be22-afe1d512627a', 0.25,  '0.25 oz./gal.',                  0.75, null), -- Super concentrated hand dishwashing detergent
  ('62863114-643c-473f-b23e-7b5914a18446', null,  '0.5 - 2 oz. per 10 gallons',     0.75, null)  -- Super Concentrated Hand Dishwashing Detergent (range; oz/gal left null)
on conflict (entity_id) where product_key is null
do update set
  dilution_oz_per_gal = excluded.dilution_oz_per_gal,
  dilution_display = excluded.dilution_display,
  confidence = excluded.confidence,
  updated_at = timezone('utc'::text, now())
where rag.product_line_fact.dilution_oz_per_gal is null;
