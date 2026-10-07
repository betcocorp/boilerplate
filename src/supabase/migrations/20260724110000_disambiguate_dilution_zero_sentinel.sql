-- B0-265 — Disambiguate the dilution_code='0' sentinel on rag.entity (product_line).
--
-- Background: the B0-194 backfill (20260715090100_backfill_product_line_fact_from_entity.sql,
-- line 16) blanket-set dilution_display = 'RTU / not diluted' for EVERY rag.entity row with
-- metadata->>'dilution_code' = '0', without checking whether the product was actually
-- ready-to-use. dilution_code='0' is ambiguous: it conflates (a) genuinely ready-to-use
-- products, and (b) concentrates whose real dilution ratio simply couldn't be parsed by the
-- legacy import. That means the 11 real concentrates identified below have been carrying a
-- FALSE "ready to use" label in rag.product_line_fact since B0-194 — a customer-facing safety
-- risk (telling someone not to dilute a product that needs it).
--
-- Classification method: read the full, verbatim "Directions for Use" text for all 74 lines
-- from legacy.product_direction_of_use (via legacy.prod_line_attr, AttrTable=
-- 'productdirectionofuse'), never inferred from product title/name. One line titled
-- "Ready-to-Use Deodorizing Liquid" (CD7A8E0D-F632-4FF9-883A-FB8D68A5F756) turned out to
-- contain a real "Dilute 13 oz./gal...for TRIGGER SPRAYERS" instruction, confirming titles
-- cannot be trusted for this classification.
--
-- Scope (74 rows total with dilution_code='0'):
--   * 1 row is "DISCONTINUED" (A0B966CE-DB28-4F8B-8B4F-F98FD1DAFE78 / entity
--     1f8a5ecd-1f75-444e-85fc-0987d1f74c67) — not a real product, excluded, no action taken.
--   * 62 rows are genuinely RTU (directions describe direct/undiluted use — spray-and-wipe,
--     floor finish/sealer applied as a coating, etc — with no dilution ratio anywhere in the
--     text). This migration sets dilution_display = 'Ready to use' for these, leaving
--     dilution_oz_per_gal untouched (remains null, correctly — no numeric value is invented).
--   * 11 rows are real concentrates that need dilution but whose ratio wasn't parsed by the
--     legacy import (dispenser/capsule-fed products, or directions containing an explicit
--     "dilute X oz/gal" instruction for at least one use-mode despite an RTU-sounding title,
--     or laundry powders dosed by weight rather than oz/gal). For these, this migration
--     CLEARS the incorrect blanket 'RTU / not diluted' label back to null so BEX no longer
--     asserts a false RTU status; dilution_oz_per_gal remains null and is queued for real
--     extraction under B0-264. See B0-265 Jira comment for the full per-line quote of the
--     dilution text driving each classification.
--
-- Idempotent: re-running is a no-op after the first application — the RTU upsert only touches
-- rows where dilution_oz_per_gal is still null, and the correction only touches rows that
-- still carry the stale 'RTU / not diluted' sentinel.

-- 1) Genuinely RTU lines (62): set the correct RTU display, never touch dilution_oz_per_gal.
insert into rag.product_line_fact (entity_id, product_key, dilution_display)
values
  ('9009bcbc-58ec-4e10-b3de-c46e2647fca1', null, 'Ready to use'), -- 9% HCl Porcelain Toilet Bowl Cleaner
  ('8efad4b1-b0c6-4f8d-83dc-603652a67918', null, 'Ready to use'), -- Acid Free Bathroom Cleaner
  ('01524fe9-15c2-4d60-93ca-5a323a9ab672', null, 'Ready to use'), -- Acrylic Polymer Floor Finish
  ('7957e594-636b-4e85-9ac2-e854c57be83f', null, 'Ready to use'), -- Acrylic Urethane Sealer - Finish
  ('c51a17ef-9943-4376-8d35-e6daf8e4ea1c', null, 'Ready to use'), -- All Purpose Spot and Stain Remover
  ('17f158dd-c48c-480f-80b5-613fce391dda', null, 'Ready to use'), -- Ammoniated Glass and Surface Cleaner
  ('238c55a1-5651-4002-be0e-caadf183f03f', null, 'Ready to use'), -- Bathroom Disinfectant
  ('49ee47d8-afe5-4d2d-b346-f095d134a0fa', null, 'Ready to use'), -- Black Mark Resistant Metal Interlocked Floor Finish
  ('db69da28-9741-4334-8605-f01c351cb346', null, 'Ready to use'), -- Broad Spectrum Disinfectant Cleaner
  ('c07b1f82-e5a6-46b0-a1be-1c45c877933e', null, 'Ready to use'), -- Cleaner Sanitizer Deodorizer
  ('3ee36ce3-4667-4375-98b5-6a081aaa0bac', null, 'Ready to use'), -- Clear Waterbased Sport Finish
  ('4808c456-3047-444a-871c-c807298f6d96', null, 'Ready to use'), -- DefenderT Linoleum System floor finish
  ('405a59ee-6821-4c25-ac21-92f5616bfcc5', null, 'Ready to use'), -- DefenderT linoleum system sealer
  ('61cd3650-3688-4faa-8c90-e70d488ed4e2', null, 'Ready to use'), -- Dust mop treatment
  ('4b2b63d6-1258-4ddc-aca1-e638cfa57b52', null, 'Ready to use'), -- Extended Wear Formula Floor Finish
  ('f252a522-6cce-4bb2-815e-09fb3ed2a35c', null, 'Ready to use'), -- Fast Drying - Fast Curing Floor Finish - Max-CureT Technology
  ('e02d05c3-5b4b-4878-807f-1b375637c636', null, 'Ready to use'), -- Foaming Cleaner and Deodorant
  ('ae9d0696-41a4-4e40-8305-28bd0a47bbbe', null, 'Ready to use'), -- Hard Film Floor Finish
  ('775e7e6d-bdbf-4999-9b28-041c85728cf2', null, 'Ready to use'), -- Hard Surface Cleaner
  ('a4369d1c-7f4a-40e5-aea5-6a1aa57a920f', null, 'Ready to use'), -- Healthcare Prewash
  ('e1d7c9d7-772f-49dc-8aac-6f1ddf775630', null, 'Ready to use'), -- Heavy Duty 23% HCL Toilet Bowl Cleaner
  ('6b9e3ec7-1bd8-4887-994f-bbc26568fec7', null, 'Ready to use'), -- Heavy Duty Cleaner/Degreaser
  ('34d5458b-7482-43aa-919a-b4f6b9bd1d59', null, 'Ready to use'), -- High Flash Multi-Purpose Solvent
  ('deea0e96-fedf-4da6-af20-74305ad494f5', null, 'Ready to use'), -- High Gloss Remarkable Response Floor Finish
  ('12d0b518-7e8e-4113-a6c4-666cb4613c81', null, 'Ready to use'), -- Instant Mildew Stain Remover
  ('e6f22c3d-e58b-4780-9b91-a5938e429fff', null, 'Ready to use'), -- Liquid Abrasive Creme Cleanser
  ('ec4a5958-cabb-4e86-b778-efa218d635d1', null, 'Ready to use'), -- Metal Interlocked Acrylic Polymer Floor Finish
  ('3711089d-a063-4452-beff-eb75e53dee53', null, 'Ready to use'), -- Metal Interlocked Acrylic Polymer Floor Sealer
  ('3d32161a-1a6a-42fc-9d80-72471b727ab7', null, 'Ready to use'), -- Metal Interlocked Floor Finish
  ('fbfbb435-c4e5-4a8b-ac6c-e95d7dcab604', null, 'Ready to use'), -- Natural Gum and Grease Remover
  ('4590a5bc-55ed-4582-95ab-d76c51001f1a', null, 'Ready to use'), -- Non-Ammoniated Glass Cleaner
  ('26981039-cae5-4e9e-89ac-c7e05e172d86', null, 'Ready to use'), -- Non-Zinc Floor Finish and Sealer
  ('c4ba1cf5-f61e-40e7-a8b4-69e469f63dfc', null, 'Ready to use'), -- Non-Zinc Floor Finish and Sealer
  ('d857a334-1995-479e-81e7-7b8524f62a37', null, 'Ready to use'), -- Oil-Based Wood Sport Finish
  ('f8d891a6-b152-44c5-ba83-dba56040d8e1', null, 'Ready to use'), -- Oven Cleaner
  ('96a01c79-b5ab-4c46-8d15-b40cbfe51abd', null, 'Ready to use'), -- Prewash - Iron
  ('78655eb4-5744-4d92-bbdb-b0a913f09ca6', null, 'Ready to use'), -- Prewash for Broad Spectrum Organic Stains
  ('6dff354a-1abb-4b0c-a0bb-807f1579f9e8', null, 'Ready to use'), -- Ready-to-Use Deodorizing Liquid
  ('fe7d5c78-d06a-4f55-bfb7-44c919cac7d0', null, 'Ready to use'), -- Ready-to-Use Deodorizing Liquid
  ('361f2e3c-a59e-4fd2-9613-a13414944d9a', null, 'Ready to use'), -- Ready-to-Use Deodorizing Liquid
  ('d7df1825-47f1-4946-b47b-1eda16dc1ba0', null, 'Ready to use'), -- Ready-to-Use Deodorizing Liquid
  ('b3f978c2-66a6-4237-97d2-e5246ab5d00d', null, 'Ready to use'), -- Ready-To-Use Malodor Eliminator
  ('106ac83a-6851-4ace-a2c8-cadf5d94c6f3', null, 'Ready to use'), -- Ready-To-Use Malodor Eliminator
  ('f5784576-7564-4d71-bfbc-a142365a4031', null, 'Ready to use'), -- Ready-To-Use Malodor Eliminator
  ('84c4e6de-26a8-4773-8aa5-66b5fb924a62', null, 'Ready to use'), -- Ready-To-Use Malodor Eliminator
  ('aa8094d2-6d47-46c6-ac25-8b754c991a2c', null, 'Ready to use'), -- Ready-To-Use Malodor Eliminator
  ('3a34f303-ff5b-47c1-818b-1f48826c185f', null, 'Ready to use'), -- Red Stain / Tannin / Debrowner Treatment
  ('4ad6ac02-6674-4771-bbc7-746c5c4d7cc0', null, 'Ready to use'), -- RTU Non-Corrosive Heavy-Duty Restroom Cleaner
  ('8085fb07-0b73-4212-9dc6-6e7b5236d07b', null, 'Ready to use'), -- Scrub and recoat floor finish
  ('78b7f550-9aa3-415e-bfff-75b173772c3c', null, 'Ready to use'), -- Solvent Prewash for Broad Spectrum Organic Soils
  ('fc0754f4-085f-4ab4-aafe-4f94da934b3e', null, 'Ready to use'), -- Static Dissipative Floor Finish
  ('2958efd6-3140-45e2-826b-e9350fa030bc', null, 'Ready to use'), -- Thermoplastic spray buff
  ('68868c09-5806-485b-b3eb-2cb52017b8a9', null, 'Ready to use'), -- Toilet Bowl
  ('4ebbceb5-aec0-49eb-b75f-2b8411f36d92', null, 'Ready to use'), -- Urethane Gloss Finish for Wood Gym Floors
  ('c1bbb5a8-9c4c-4757-b73d-ce8acd9c8855', null, 'Ready to use'), -- Urethane Gloss Finish for Wood Gym Floors
  ('a2a9fe4e-c236-452a-9b49-b67603307fdf', null, 'Ready to use'), -- Value Priced Restroom Disinfectant
  ('043417ce-87ca-459e-b2fb-017ec0416b16', null, 'Ready to use'), -- ViBRIGHTT Disinfectant Acid Bowl Cleaner
  ('9d634aad-4613-4ab1-9073-93b123421525', null, 'Ready to use'), -- Water Rinsable Foaming Degreaser/ Deodorizer
  ('ccd2bec6-c87a-4c81-bb24-5943ff7bf81c', null, 'Ready to use'), -- Water Rinsable Multi-Purpose Solvent
  ('61a9e62b-5dd6-4dde-9294-ed6719c2a234', null, 'Ready to use'), -- Water-Based / Ultra Durable Gloss
  ('d5412a1a-9774-4458-9b39-9b3c9e40e305', null, 'Ready to use'), -- Water-Based High Traffic Wood Floor Finish
  ('6395dcf6-748c-43b6-8d68-a40cbf1fc6ef', null, 'Ready to use')  -- Waterless Cleaner
on conflict (entity_id) where (product_key is null)
do update set
  dilution_display = excluded.dilution_display,
  updated_at        = timezone('utc', now())
where rag.product_line_fact.dilution_oz_per_gal is null;

-- 2) Real concentrates misclassified as RTU by the B0-194 blanket backfill (11): clear the
-- false 'RTU / not diluted' label back to null. Left null == queued for real extraction
-- (B0-264). Only touches rows still carrying the stale sentinel value, so this is idempotent
-- and will never clobber a value set by a later, deliberate correction.
update rag.product_line_fact
set dilution_display = null,
    updated_at       = timezone('utc', now())
where product_key is null
  and dilution_oz_per_gal is null
  and dilution_display = 'RTU / not diluted'
  and entity_id in (
    'a226f6a8-ff92-4d8c-8f08-61fbfcbdb395', -- 9% Thickened HCl Toilet Bowl Cleaner (dilute 1:2 for sinks/tubs)
    '70eab346-a037-4aae-8dbe-08f04ffe41a9', -- Concentrated Flatware Presoak with Enzymes (dispenser/capsule-fed)
    'c0f3a543-d0ca-49cc-93c2-42e34b21a168', -- High performance top scrub cleaner (FASTDRAW dispenser)
    '47c99caa-8758-450c-876e-e7282435acf3', -- Ready-to-Use Deodorizing Liquid (trigger-sprayer dilution — the ticket's known example)
    'ae33040d-aef1-45e4-865c-849f959cdcd4', -- Ready-To-Use Multi-Purpose Cleaner (glass/mirror: dilute 2 oz./gallon)
    '5cc00674-7693-4f34-a250-87534b52a84a', -- Ready-To-Use Oven Grill and Range Hood Cleaner (dilute with equal parts water; 6-8 oz./gal for fryers)
    'f89c03ad-2c52-40ab-8746-60d8fd66d297', -- Reclaim Powder for Color Linens (1 container per 50 lbs of linen)
    '92b631c5-6d87-4914-a9f2-4e4bbdeb4a56', -- Reclaim Powder for Rust and Tannin Linens (1 container per 50 lbs of linen)
    '56016b30-7802-4d63-8188-20487bf9f4bd', -- Reclaim Powder for White Linens (dosing ratio present + unreadable fraction character)
    '1b4c4b04-69a2-4837-9a86-9a774ee5a1c4', -- Solid Machine Rinse Aid (dispenser/capsule-fed)
    'a1082257-7556-4485-98e0-3f0442d2d2cb'  -- Solid Non-Phosphate Manual Detergent (dispenser/capsule-fed)
  );
