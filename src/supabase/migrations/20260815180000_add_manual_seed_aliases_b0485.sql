-- B0-485: manual seed batch -- known high-traffic acronyms/nicknames not yet covered by any
-- seeded alias row. Checked live (2026-08-16): no existing rows for alias_norm in
-- ('han', 'ph7q', 'ph7q dual', 'ph7q ultra', 'ph 7q', 'hard as nails') -- only full-title phrases
-- were previously seeded for this family (e.g. "pH7Q Neutral Disinfectant", "pH7Q Dual Neutral
-- Disinfectant Cleaner", "pH7Q ULTRA").
--
-- 1) "HAN" -> Hard As Nails Floor Finish (product_line_key DBF2B1E5-FD1A-4E42-A3A5-D7C8F5C3B671).
--    entity_id points at the product_line-tier entity ("Hard Film Floor Finish"), matching the
--    entity already used by that line's existing verified title-sourced alias rows.
--
-- 2) "pH7Q" -> inserted as THREE separate rows, one per distinct product_line_key, all
--    verified = true. This deliberately creates a 3-way ambiguity for the bare acronym, which
--    resolveProductEntityByName's existing ambiguity gate (~/lib/rag/entity-context.ts,
--    resolveVerifiedTiebreak) correctly rejects (distinctVerifiedLineKeys.size = 3, not 1) rather
--    than silently falling through to an unrelated ILIKE title match. Per B0-486's
--    formulation-variant aliasing rule (src/docs/formulation-variant-aliasing-rules.md), these
--    three product_line_keys are confirmed genuinely distinct (pH7Q Neutral Disinfectant and pH7Q
--    Ultra disagree on EPA registration/contact time/dilution in rag.product_line_fact; pH7Q Dual
--    has no product-tier fact data at all) and must never be merged under one alias row -- seeding
--    all three under one alias_norm as separate rows is the correct, safe way to surface the
--    ambiguity rather than leaving it an unlogged accidental miss.
--    - FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94 (pH7Q Neutral Disinfectant)
--    - 69171DB7-F490-4C87-A67E-C1F928768D68 (pH7Q Dual)
--    - 168549A1-B75F-4D00-B5C1-087A95C317D9 (pH7Q Ultra)
--    entity_id for each points at that line's product_line-tier entity, matching the entity
--    already used by that line's existing verified title-sourced alias row.
insert into rag.product_alias
  (alias, alias_norm, entity_id, product_line_key, source, confidence, alias_type, verified)
values
  ('HAN', 'han', 'ae9d0696-41a4-4e40-8305-28bd0a47bbbe', 'DBF2B1E5-FD1A-4E42-A3A5-D7C8F5C3B671', 'manual', 1.0, 'acronym', true),
  ('pH7Q', 'ph7q', '02fd6247-7e76-4018-bb45-40cf40a2fab8', 'FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94', 'manual', 1.0, 'acronym', true),
  ('pH7Q', 'ph7q', 'bc01860b-3948-4c96-84bf-762ff67c01aa', '69171DB7-F490-4C87-A67E-C1F928768D68', 'manual', 1.0, 'acronym', true),
  ('pH7Q', 'ph7q', '851f5674-6b94-4c7c-9c4b-a1584391806a', '168549A1-B75F-4D00-B5C1-087A95C317D9', 'manual', 1.0, 'acronym', true)
on conflict (alias_norm, product_line_key) do nothing;
