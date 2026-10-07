-- B0-480 — give the "Alias Resolution Regression v1" gold set real grading criteria.
--
-- Why: all 5 items shipped with `expected_criteria = '[]'` and an empty `ideal_response`.
-- `aggregateCriteriaVerdicts` (~/lib/tests/criteria-schemas.ts) short-circuits to
-- `{ passed: true, score: null }` when the criteria array is empty, so the only live failure
-- signal was the legacy "the assistant refused to answer" check. That inverted the intent of
-- the set: verified in run 7145bd60-6611-482d-bb47-4731019614c4 (2026-08-21 17:32), the raw-SKU
-- item PASSED while answering about "BTB Instant Mildew Stain Remover" — the wrong product, the
-- exact defect this set exists to catch — and the deliberately-ambiguous item PASSED while
-- locking onto a single product ("Fast Drying"). Meanwhile a correct refusal counted as a
-- failure. The set could not detect its own target bug.
--
-- Tier semantics (pinned in criteria-schemas.ts): 1 = must have, any miss fails the item;
-- 2 = should have, score only. All criteria here are `semantic` on purpose — see the note on
-- the raw-SKU item for why no regulated literal is asserted.

-- 1) ECBA — bare-acronym exact-alias resolution.
-- rag.entity has exactly ONE row for product_line_key E98366D2-243A-40DA-B811-F40D8F3B4C45:
-- a product_line titled 'ECBA', with no product-tier rows and no descriptive body anywhere in
-- the corpus. So "what is it used for" is genuinely unanswerable from current data. The alias
-- behaviour (acronym -> correct product line) is what this item can legitimately assert; the
-- missing usage content is demoted to tier 2 so it costs score without masking the alias signal
-- as a hard failure. Do not "fix" this by inventing what ECBA stands for.
update public.test_items
set expected_criteria = '[
  {"concept":"Identifies ECBA as a Betco product line (resolves the bare acronym to a product rather than treating it as an unknown term)","tier":1,"match":"semantic"},
  {"concept":"States what ECBA is typically used for","tier":2,"match":"semantic"}
]'::jsonb
where id = '4796dd7b-4310-4baf-8ab7-b73c9c8efccd';

-- 2) pH7Q Neutral Disinfectant — must not bleed into its sibling formulations.
-- product_line_key FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94.
update public.test_items
set expected_criteria = '[
  {"concept":"Answers about pH7Q Neutral Disinfectant specifically, not the pH7Q Dual or pH7Q Ultra formulation","tier":1,"match":"semantic"},
  {"concept":"Describes it as a neutral-pH disinfectant cleaner for hard surfaces","tier":2,"match":"semantic"}
]'::jsonb
where id = '6e46e9a2-da41-469f-b8ef-c0f278a58f2a';

-- 3) pH7Q Dual Neutral Disinfectant Cleaner — the paired half of the above.
-- product_line_key 69171DB7-F490-4C87-A67E-C1F928768D68, a DIFFERENT line from item 2.
update public.test_items
set expected_criteria = '[
  {"concept":"Answers about pH7Q Dual Neutral Disinfectant Cleaner specifically, not the plain pH7Q or pH7Q Ultra formulation","tier":1,"match":"semantic"},
  {"concept":"Describes it as a concentrated neutral disinfectant cleaner","tier":2,"match":"semantic"}
]'::jsonb
where id = '763e10f9-e94f-4002-af28-ae5c4ce0f2af';

-- 4) Raw SKU 07512-00 — the wrong-product-attribution guard.
-- alias_norm '07512-00' -> product_line_key 110F65B0-FE92-412A-9A03-654586617F2C
-- (product line '9% Thickened HCl Toilet Bowl Cleaner'), product_key 07512 -> 'Kling'.
-- Tier 1 is product identity, because that is what actually regressed: a BTB answer must fail.
-- Deliberately NO criterion asserting the signal word. The live corpus carries DIFFERENT signal
-- words for the two regional sibling labels — 'Kling' (EN) label reads "Signal word: DANGER"
-- while 'Kling (Canada)' reads "Signal word: WARNING" (both SDS read "Danger") — and this prompt
-- names no region. Asserting one value would encode an inferred region, which the label rules
-- forbid. If a signal-word assertion is wanted, split a region-specific item and use
-- match:"exact" there.
update public.test_items
set expected_criteria = '[
  {"concept":"Identifies SKU 07512-00 as Kling, a 9% thickened HCl toilet bowl cleaner","tier":1,"match":"semantic"},
  {"concept":"Addresses the hazard information and signal word for that product from its label or SDS","tier":2,"match":"semantic"}
]'::jsonb
where id = '5c61d642-92de-4ba6-8da8-d8d3cf82e421';

-- 5) "Foaming Hand Sanitizer" — the false-positive-lock guard.
-- Genuinely ambiguous: rag.product_alias matches this phrase across 5 distinct product_line_keys
-- (B794615D, BE280BA1, ACE33250, 0879D7E9, 1473036D). There is no single correct product, so the
-- tier-1 criterion is inverted on purpose: naming one specific product as THE answer must fail,
-- and presenting the choice (or asking which is meant) must pass. This is the criterion that
-- turns a confident wrong lock into a red item.
update public.test_items
set expected_criteria = '[
  {"concept":"Conveys that Betco offers more than one foaming hand sanitizer, or asks which one is meant, instead of presenting a single specific product as the answer","tier":1,"match":"semantic"},
  {"concept":"Notes that both alcohol-based and alcohol-free options exist","tier":2,"match":"semantic"}
]'::jsonb
where id = 'a23b6466-cb13-41b0-b018-cc42f5b9a57d';
