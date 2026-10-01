-- B0-97 — labeled cross-reference gate-calibration question set.
--
-- AC1 of B0-97: a labeled competitor brand+product -> known correct Betco equivalent set, plus
-- known no-equivalent cases, in the /admin/tests harness.
--
-- Provenance is recorded per item and the two kinds must never be conflated:
--   * 'curated_legacy_mapping' — REAL. The expected Betco product is the curated equivalent in
--     legacy.competitor_products (Betco's own cross-reference table), resolved to its SKU
--     description via legacy.products.ProductsKey. No equivalence is authored in this file: the
--     brand, the competitor product description and the expected Betco product are all SELECTed
--     live from the legacy tables, so nothing is transcribed by hand.
--   * 'synthetic_no_equivalent' — FICTIONAL competitor brands/products. The legacy cardinality
--     audit found ZERO real competitor products lacking a Betco mapping, so a real "no equivalent"
--     case does not exist in the available data. These probe decline behaviour only and must never
--     be read as market data.
--
-- Each real item also carries the forced-web-path harvest result
-- (metadata.harvest_confidence / metadata.harvest_correct_exact_key) produced by
-- scripts/calibrate-xref-threshold.ts, so this set and the threshold curve in
-- src/docs/cross-reference-recommendations.md are traceable to the same engine runs.
--
-- Tagged intended_agent 'cross_reference' — the post-B0-663 SME id for competitor equivalence;
-- 'recommendations' is now the separate job/problem-based capability.

insert into public.tests (
  id, name, source_file_name, source_bucket, source_key, row_count, status,
  intended_agent, suite_version, is_golden, is_archived, metadata
) values (
  '3a1c7f52-9d4b-4e18-b6a7-2c95f0e41d83'::uuid,
  'Cross-Reference Gate Calibration (B0-97)',
  'cross-reference-gate-calibration-b0-97.csv',
  'local-fixture',
  'src/lib/tests/fixtures/cross-reference-gate-calibration-b0-97.csv',
  65,
  'ready',
  'cross_reference',
  'v1',
  false,
  false,
  jsonb_build_object(
    'jira', 'B0-97',
    'purpose', 'Labeled competitor->Betco set for cross-reference answer-gate calibration and regression',
    'ground_truth', 'legacy.competitor_products join legacy.products on ProductKey=ProductsKey',
    'positives', 60,
    'synthetic_negatives', 5,
    'caveat', 'Positives are answered by the deterministic legacy path, which never reaches gateRecommendation. Calibrating the gate itself requires scripts/calibrate-xref-threshold.ts --harvest.'
  )
)
on conflict (id) do update set
  name = excluded.name,
  row_count = excluded.row_count,
  intended_agent = excluded.intended_agent,
  is_archived = excluded.is_archived,
  metadata = excluded.metadata,
  updated_at = now();

delete from public.test_items where test_id = '3a1c7f52-9d4b-4e18-b6a7-2c95f0e41d83'::uuid;

-- Positives. (row_index, expected Betco ProductKey, competitor product description, harvest
-- confidence, harvest verdict at exact-key grain) — everything else is joined in.
with harvest (row_index, product_key, competitor_product, harvest_confidence, harvest_correct) as (
  values
    (0, '03F52A8B-1017-4B7F-857A-F6409B820D1B', '#26 Industrial Cleaner Concentrate', 0.619, false),
    (1, '3900BED1-476C-4722-A563-E4B5865649D8', 'AHPr 5', 0.656, false),
    (2, '3BE0B409-3C77-46EC-83EC-CE854D48D9EB', 'First Step Floor Sealer', 0.625, false),
    (3, '21F18725-7E79-42AC-8DCF-7F48439AD368', 'BRITE + CONC GLASS/ALL PURPOSECLEANER', 0.608, false),
    (4, '0AA2E5B8-752A-4069-AF10-99D4184CDB31', 'ProfiT Floor Cleaner Oil & Grease Remover', 0.661, false),
    (5, '4EDD4B50-682C-40F9-A5EB-AE877A191366', 'Hang-Tite Plus', 0.595, false),
    (6, 'DB80A4A7-06DF-48E0-A6FF-BD64F931F4FC', 'NO-RINSE FLOOR STRIPPER 4/CS  EZ-2000', 0.673, false),
    (7, '25A90F21-0FF7-4D05-A063-2C62A166147B', 'Brulin Floor Neutralizer', 0.758, false),
    (8, '713D7293-DF00-4209-956E-5B5EF7D8CB4B', 'Refresh Mild Liquid Cleanser', 0.595, false),
    (9, '02BBDF4A-41F2-4467-AD2C-25CC8604C0AF', 'Earth Sense #21', 0.584, false),
    (10, '42F54E32-DD76-4D11-B468-B58B45CAB443', 'E3 - Solid laundry Detergent', 0.599, false),
    (11, 'AB5CF23E-5492-4913-BCB7-7E62AE5DB4F4', 'Sumar Clean RF P6', 0.641, false),
    (12, '0FFE9796-6584-4E80-A57A-0118A5848AC4', 'Limon Pot and Pan Detergent Lemon Fresh', 0.643, false),
    (13, '0B4B0FFD-BB15-486F-BA50-FE2422927B9F', 'Solvs It! Extra H/D Cleaner Degreaser', 0.589, false),
    (14, 'C143CB5A-03BA-4957-91BB-598591608868', 'Orange Spray', 0.67, false),
    (15, '42B7EB1A-3E3E-424D-9EB5-B0F12891110F', 'Ultima Floor Finish', 0.632, false),
    (16, 'DD06A4F9-A219-4FE2-A54E-C8D328F08998', 'Earth Sense #20', 0.581, false),
    (17, '726DD1DD-1D41-4533-91A6-0C88ABB221F0', 'SPRING MIST ROOM FRESHNER 12cs', 0.593, false),
    (18, '583CC978-57C9-4F5F-8CFF-BD93D6B6A9CA', 'Super Hil-Tone', 0.616, false),
    (19, 'A5141A21-FD89-4DFD-A5D5-7A06EDDF116A', 'Pink Suds', 0.621, false),
    (20, '59EF88D0-57CF-43AE-960F-3117B18B9621', 'Tri-Star Laundry Detergent Plus', 0.56, false),
    (21, '9DA749C7-7D15-49DE-AEDF-91AF02BC142C', 'Cross-link Spray Buff', 0.586, false),
    (22, 'C3020F26-5AA6-4F3B-8E86-70196EF1D082', 'Defy GSP', 0, null),
    (23, '03F52A8B-1017-4B7F-857A-F6409B820D1B', 'AVATAR 4 DEGREASER 4/64oz/CS', 0.615, false),
    (24, 'D6A816B7-06F0-4014-945C-CA10493F5F39', 'Sanicare Pine QuatT', 0.64, false),
    (25, '3E8D6C7C-2151-4FFC-8699-05DAA1C90D1E', 'Reclaim NP', 0.36, false),
    (26, '42F54E32-DD76-4D11-B468-B58B45CAB443', 'USC Daybreak', 0, null),
    (27, '6B1BB97F-1B27-474A-89F9-B1534FFAC83B', 'Stone Beauty Countertop Polish', 0.497, false),
    (28, '6E65CAF6-DE66-4452-95F3-1CDBB0A6286C', '#16 Sanitizer Concentrate', 0.63, false),
    (29, '9157DDEE-BE1E-4AB2-8911-6642B0738FC3', 'Cancel Odour Control', 0.624, false),
    (30, '4F08FC79-D76E-43A0-A4CF-2167A5FE381C', 'USC Sanitizer ES', 0.592, false),
    (31, '0B5690F3-7C63-469D-B58E-BD191533BB9B', 'Antiseptic Hand Soap', 0.595, false),
    (32, '1960EFF8-359F-42C2-97CE-14E321E5F77E', 'Beer Cleanr', 0, null),
    (33, '0AA2E5B8-752A-4069-AF10-99D4184CDB31', 'Elements E12 Super Duty Degreaser', 0, null),
    (34, '6E65CAF6-DE66-4452-95F3-1CDBB0A6286C', 'Hard Surface Sanitizer', 0, null),
    (35, 'BB7AAF83-E1FD-4EFB-873E-DC1A04199FDE', 'Astro-Chem Degreaser', 0, null),
    (36, 'A2893C70-F5CD-43D4-B57A-6A1CC912B2DA', 'Fluff', 0.315, false),
    (37, 'A2893C70-F5CD-43D4-B57A-6A1CC912B2DA', 'Downy', 0, null),
    (38, '295BA809-39FB-4752-AC0F-4B2219107226', 'Misty Aspire Glass & Surface Cleaner', 0.572, false),
    (39, 'BB286D1A-F034-45FF-81E8-A6BF721B7673', 'Orang-A-Tang Cleaner', 0, null),
    (40, '578EC658-39A2-481A-A244-959EF0D55B1D', 'Bust Up Bakery Pan Soak Cleaner', 0.611, false),
    (41, 'DE773A79-F0A3-4278-AC26-BFC004046501', 'Whistler Laundry Detergent', 0, null),
    (42, '4615F205-ECFD-44FF-B922-EDB3B55E87D7', 'Bul-It Multi-Purpose Restroom Cleaner', 0.639, false),
    (43, 'C3020F26-5AA6-4F3B-8E86-70196EF1D082', 'Descale', 0.651, false),
    (44, '6B1BB97F-1B27-474A-89F9-B1534FFAC83B', 'Aqua Scrub', 0.574, false),
    (45, '95091A33-3FBE-47FA-B0B4-A7C67C1555A9', 'EPI-QUAT SANITIZER 4/CS', 0.588, false),
    (46, '426A2165-47A5-4635-81F6-C6E2E3DDC9ED', 'Dust Mop Treatment (Aerosol)', 0.645, true),
    (47, '17C6B5D3-D02F-4960-A826-4F754EA066A4', 'BLOCKBUSTER M METALSAFE POWDER4/9#/CS', 0, null),
    (48, '338ABEF1-BA29-49C4-9024-DE35241467A0', 'Glass Force Professional', 0.591, false),
    (49, '3F1A4382-BD3C-49EA-A046-AC76611E8A93', 'Aqua Solv', 0, null),
    (50, 'C994E805-F99D-43D1-BB2C-BD0A23734312', 'Kresto', 0.623, false),
    (51, '964C2659-1A79-4851-B003-936E04010F61', 'Breeze RTU Non-Acid Germicide', 0.626, false),
    (52, '87910D49-2E8A-4D96-BC80-900EAF4DBD28', 'Virexr Plus', 0.76, false),
    (53, '3BCAD428-0883-44F8-B24A-890B74CB7B3B', 'Salvation Floor Stripper', 0.628, false),
    (54, 'D8EEC65E-C591-4F42-B160-04948E992067', 'Blower Industrial Fan', 0.54, true),
    (55, '6B6BBAB1-230D-4E81-88D2-578DF70D1DED', 'Greaselift', 0.575, false),
    (56, '3E8D6C7C-2151-4FFC-8699-05DAA1C90D1E', 'Reclaim Powder', 0.536, true),
    (57, '3DA43452-9D80-4582-901B-479C766C71CB', 'Peroxide Glass and Surface Cleaner', 0.727, false),
    (58, '611F20FF-A262-4187-97AB-2DEFE8B5C46B', 'Green Light Floor Cleaner', 0, null),
    (59, '55AF775C-0A6C-40C1-8715-B92D7AE523BF', 'RTU Laundry Spotter', 0.598, false)
),
resolved as (
  select distinct on (h.row_index)
    h.row_index,
    c."Competitor"        as brand,
    h.competitor_product  as competitor_product,
    p."SLDescr"           as expected_product,
    h.product_key,
    h.harvest_confidence,
    h.harvest_correct
  from harvest h
  join legacy.competitor_products cp
    on upper(cp."ProductKey") = upper(h.product_key)
   and cp."ProductDescr" = h.competitor_product
  join legacy.competitor c
    on c."CompetitorID"::text = cp."Competitor"
  join legacy.products p
    on upper(p."ProductsKey") = upper(h.product_key)
  order by h.row_index
)
insert into public.test_items (
  test_id, row_index, prompt, expected_should_answer, expected_canonical_product,
  input_payload, metadata, expected_criteria, prompt_category, source, intended_agent_item
)
select
  '3a1c7f52-9d4b-4e18-b6a7-2c95f0e41d83'::uuid,
  r.row_index,
  'What is the Betco equivalent of ' || r.brand || ' ' || r.competitor_product || '?',
  true,
  r.expected_product,
  jsonb_build_object(
    'source', 'curated_legacy_mapping',
    'competitor_brand', r.brand,
    'competitor_product', r.competitor_product,
    'question_category', 'competitor_cross_reference'
  ),
  jsonb_build_object(
    'jira', 'B0-97',
    'provenance', 'curated_legacy_mapping',
    'betco_products_key', r.product_key,
    'synthetic', false,
    'harvest_confidence', r.harvest_confidence,
    'harvest_correct_exact_key', r.harvest_correct
  ),
  -- match 'exact': a product identity is an exact value, never paraphrased, and exact matching
  -- costs no LLM call (see src/lib/tests/criteria-grader.ts).
  jsonb_build_array(jsonb_build_object('concept', r.expected_product, 'tier', 1, 'match', 'exact')),
  'competitor_cross_reference',
  'curated_legacy_mapping',
  'cross_reference'
from resolved r;

-- Synthetic no-equivalent probes.
insert into public.test_items (
  test_id, row_index, prompt, expected_should_answer, expected_canonical_product,
  input_payload, metadata, expected_criteria, prompt_category, source, intended_agent_item
)
select
  '3a1c7f52-9d4b-4e18-b6a7-2c95f0e41d83'::uuid,
  n.row_index,
  'What is the Betco equivalent of ' || n.brand || ' ' || n.product || '?',
  false,
  null,
  jsonb_build_object(
    'source', 'synthetic_no_equivalent',
    'competitor_brand', n.brand,
    'competitor_product', n.product,
    'question_category', 'competitor_cross_reference'
  ),
  jsonb_build_object('jira', 'B0-97', 'provenance', 'synthetic_no_equivalent', 'synthetic', true),
  jsonb_build_array(
    jsonb_build_object('concept', 'declines to name a Betco equivalent', 'tier', 1, 'match', 'semantic')
  ),
  'competitor_cross_reference',
  'synthetic_no_equivalent',
  'cross_reference'
from (values
    (1000, 'Zorbex', 'Klenz-9000 Hyperfoam Concentrate'),
    (1001, 'Vantalux', 'OmniShield Ultra Sanitizer 7X'),
    (1002, 'Kraviton', 'PolyGleam Terrazzo Restorer'),
    (1003, 'Nubex Industrial', 'Quantum Drain Digest 400'),
    (1004, 'Helvorn Chemical', 'AeroBrite Neutral Rinse Plus')
) as n (row_index, brand, product);

update public.tests
   set row_count = (select count(*) from public.test_items where test_id = '3a1c7f52-9d4b-4e18-b6a7-2c95f0e41d83'::uuid),
       updated_at = now()
 where id = '3a1c7f52-9d4b-4e18-b6a7-2c95f0e41d83'::uuid;

-- B0-663 retag: these three predate the cross_reference/recommendations split and are mislabeled.
-- Archived state is deliberately left alone (B0-750 pruned the golden roster) — this only fixes
-- which agent the harness attributes them to.
update public.tests
   set intended_agent = 'cross_reference', updated_at = now()
 where id in (
   '6f3e946a-7bf5-474e-ae5b-56bac5dad98c'::uuid,  -- Recommendation Golden Set — Cross-Reference 1:1 (B0-99)
   '739623ab-db8a-4aac-9d72-a04ba54233d8'::uuid,  -- Recommendations test set
   '2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01'::uuid   -- Recommendations — No-Equivalent Probes (synthetic, B0-97)
 );
