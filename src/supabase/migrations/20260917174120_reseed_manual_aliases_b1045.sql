-- B0-1045 — Re-seed the manual, human-verified rag.product_alias rows lost when B0-878
-- truncated the table (22,634 -> 66 rows) to drop deterministic SKU/title seeding in favor
-- of corpus-grounded mining only. That truncation also destroyed the two manual seed rows
-- from B0-485 (HAN, pH7Q family), which were correct and never part of the junk being
-- cleared. This migration restores those two exactly, and adds three new small,
-- deliberately non-trivial families (Push, AF79, Green Earth) plus one near-miss spelling
-- (B0-776 criterion #1: "Hard as Nailz" -> Hard As Nails).
--
-- Everything below was confirmed directly against live rag.entity / legacy.prod_line via
-- the Supabase MCP on 2026-09-17 -- none of it is guessed, and none of it is a bare
-- case/plural/capitalization variant of an existing row (that was exactly the junk B0-878
-- removed; see the epic description on B0-878).
--
-- Convention adopted for B0-776 acceptance criterion #2 ("an agreed alias_type convention
-- for near-miss spellings, distinguishable from a confirmed exact alias"): misspelling rows
-- are seeded at confidence 0.9, vs. 1.0 for confirmed exact/acronym/title/synonym rows. This
-- reuses the alias_type='misspelling' value already added by B0-481 rather than adding a new
-- enum member.
--
-- 1) HAN / "Hard as Nailz" -> Hard As Nails Floor Finish
--    product_line_key DBF2B1E5-FD1A-4E42-A3A5-D7C8F5C3B671, entity_id ae9d0696-41a4-4e40-8305-28bd0a47bbbe
--    (the product_line-tier entity, titled "Hard Film Floor Finish" -- same entity B0-485
--    originally pointed at; several of its product-tier variants are literally named "Hard As
--    Nails Floor Finish ..."). "HAN" is the identical row B0-485 seeded and B0-878 wiped.
--    "Hard as Nailz" is new: the near-miss spelling named in B0-776's golden case (PRO-010,
--    "Do you have a product called Hard as Nailz?"). NOTE: B0-776 also flags that this line's
--    SDS/profile is mis-attributed to a generic "Hard Film Floor Finish" document rather than a
--    dedicated Hard As Nails profile -- that is a document-to-entity linking defect (overlaps
--    B0-769), not something this alias data can fix, and is left out of scope here.
--
-- 2) pH7Q -> three separate rows, one per distinct product_line_key, all verified = true.
--    Identical to what B0-485 seeded (re-confirmed live 2026-09-17: all three entities/keys
--    still exist unchanged). Deliberately ambiguous by design -- see B0-485's own migration
--    comment (20260815180000) for why these three must never be merged under one alias row.
--    - FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94 (pH7Q Neutral Disinfectant)
--    - 69171DB7-F490-4C87-A67E-C1F928768D68 (pH7Q Dual)
--    - 168549A1-B75F-4D00-B5C1-087A95C317D9 (pH7Q Ultra)
--
-- 3) "Push" / "Puhs" -> the Push / Drain Maintainer line.
--    product_line_key F831DAC3-288E-4013-AE36-D0141F8F94F1, entity_id 1752add8-50d6-49c1-8d72-1d40d2fb170e
--    (product_line-tier entity; its stored title is the generic legacy string "All Purpose
--    Cleaner and Odor Eliminator" -- "Push" does not appear anywhere in rag.product_alias
--    today even though several product-tier variants under this line are literally titled
--    "Push", "Push (Mango)", "Push (Lemon & Sage)", "Push Drain Maintainer/Cleaner ...").
--    alias_type = 'title' because "Push" is the product's real, printed name -- not a
--    nickname -- that the product-line-tier title simply doesn't capture.
--    "Puhs" is a transposed-letter typo of "Push" (misspelling, confidence 0.9).
--
-- 4) "AF79" / "AG79" -> Acid Free Bathroom Cleaner.
--    product_line_key 5DA2C45A-E3EC-4693-902C-8589705D1E71, entity_id 8efad4b1-b0c6-4f8d-83dc-603652a67918
--    (prod_line_id 079; its own marketing description literally reads "AF79 provides
--    outstanding value and economy..."). Note: 'AFBC' already exists in the table at
--    confidence 0.35 / unverified (source = corpus_scan_cooccurrence) for this same
--    product_line_key -- left untouched here; this adds the higher-confidence,
--    human-verified forms alongside it, not a replacement.
--    "AG79" is a single-letter-substitution typo of "AF79" (misspelling, confidence 0.9).
--    Distinct from "AF79 Concentrate" (prod_line_id 331, product_line_key
--    9E99BDBB-DA3A-4555-98CC-FFF684555D0B) and "AF315" (prod_line_id 315) -- different EPA
--    registrations, kept as separate SKUs per src/lib/training/efficacy-legacy-reconciliation.md
--    -- neither is aliased here to avoid conflating regulated-label data across variants.
--
-- 5) "Green Earth" -> three separate rows, deliberately ambiguous, same pattern as pH7Q.
--    "Green Earth" (or "Earth" used loosely in conversation) genuinely names 11+ distinct
--    product lines in legacy.prod_line (all purpose, bathroom cleaner, glass & surface, pond
--    treatment, RTU carpet spotter, septic/drain, toilet bowl, urinal screen & block, plus a
--    floor-machine equipment line and a Push-branded sub-line) -- collapsing it onto one would
--    silently guess wrong as often as not. This seeds three of the most common as a
--    demonstrative, deliberately-unresolved set rather than all 11+:
--    - 1C7898FD-85A1-442B-8865-8B14D1E02BA8 (Green Earth All Purpose), entity_id e35d3d91-6b57-4daf-8307-80c127b47e1d
--    - 3432387A-5187-4F3F-B384-ED4E073E45A8 (Green Earth Bathroom Cleaner), entity_id 2dd15dd0-e785-44ac-8310-47a7b2775c41
--    - F7C59A9C-1E03-4568-837B-AA58BA96736C (Green Earth Glass & Surface), entity_id 69c13c35-2ad7-41e8-84f6-f947e9499fc9
--    Bare "Earth" alone was deliberately NOT seeded -- a single common English word is exactly
--    the kind of over-broad alias that produced the original 22k-row cleanup problem; "Green
--    Earth" is the realistic phrase a person actually types or says.
insert into rag.product_alias
  (alias, alias_norm, entity_id, product_line_key, source, confidence, alias_type, verified)
values
  ('HAN', 'han', 'ae9d0696-41a4-4e40-8305-28bd0a47bbbe', 'DBF2B1E5-FD1A-4E42-A3A5-D7C8F5C3B671', 'manual', 1.0, 'acronym', true),
  ('Hard as Nailz', 'hard as nailz', 'ae9d0696-41a4-4e40-8305-28bd0a47bbbe', 'DBF2B1E5-FD1A-4E42-A3A5-D7C8F5C3B671', 'manual', 0.9, 'misspelling', true),

  ('pH7Q', 'ph7q', '02fd6247-7e76-4018-bb45-40cf40a2fab8', 'FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94', 'manual', 1.0, 'acronym', true),
  ('pH7Q', 'ph7q', 'bc01860b-3948-4c96-84bf-762ff67c01aa', '69171DB7-F490-4C87-A67E-C1F928768D68', 'manual', 1.0, 'acronym', true),
  ('pH7Q', 'ph7q', '851f5674-6b94-4c7c-9c4b-a1584391806a', '168549A1-B75F-4D00-B5C1-087A95C317D9', 'manual', 1.0, 'acronym', true),

  ('Push', 'push', '1752add8-50d6-49c1-8d72-1d40d2fb170e', 'F831DAC3-288E-4013-AE36-D0141F8F94F1', 'manual', 1.0, 'title', true),
  ('Puhs', 'puhs', '1752add8-50d6-49c1-8d72-1d40d2fb170e', 'F831DAC3-288E-4013-AE36-D0141F8F94F1', 'manual', 0.9, 'misspelling', true),

  ('AF79', 'af79', '8efad4b1-b0c6-4f8d-83dc-603652a67918', '5DA2C45A-E3EC-4693-902C-8589705D1E71', 'manual', 1.0, 'synonym', true),
  ('AG79', 'ag79', '8efad4b1-b0c6-4f8d-83dc-603652a67918', '5DA2C45A-E3EC-4693-902C-8589705D1E71', 'manual', 0.9, 'misspelling', true),

  ('Green Earth', 'green earth', 'e35d3d91-6b57-4daf-8307-80c127b47e1d', '1C7898FD-85A1-442B-8865-8B14D1E02BA8', 'manual', 1.0, 'common_name', true),
  ('Green Earth', 'green earth', '2dd15dd0-e785-44ac-8310-47a7b2775c41', '3432387A-5187-4F3F-B384-ED4E073E45A8', 'manual', 1.0, 'common_name', true),
  ('Green Earth', 'green earth', '69c13c35-2ad7-41e8-84f6-f947e9499fc9', 'F7C59A9C-1E03-4568-837B-AA58BA96736C', 'manual', 1.0, 'common_name', true)
on conflict (alias_norm, product_line_key) do nothing;
