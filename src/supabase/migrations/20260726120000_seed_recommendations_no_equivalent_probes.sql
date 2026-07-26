-- B0-97 — seed a small SYNTHETIC "no confident equivalent" probe set for the recommendations
-- harness (`/admin/tests`). The real, DB-backed golden set ("Recommendation Golden Set —
-- Cross-Reference 1:1 (B0-99)", 1954 rows sourced from legacy.competitor_products) contains only
-- positive cases — every legacy mapping row has exactly one confirmed Betco equivalent, so it has
-- no "no equivalent" examples to draw from (see src/docs/cross-reference-recommendations.md,
-- "Legacy cardinality audit": zero competitor products with zero Betco mapping).
--
-- These 5 items use deliberately fictional competitor brand/product names (no real manufacturer or
-- product is referenced) so the answer gate's decline path has *some* harness coverage without
-- fabricating a false "known correct Betco equivalent" claim about a real competitor product. They
-- are explicitly NOT a substitute for a real, SME-reviewed no-equivalent seed list.
insert into public.tests
  (id, name, source_file_name, source_bucket, source_key, row_count, status, intended_agent, metadata)
select
  '2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01'::uuid,
  'Recommendations — No-Equivalent Probes (synthetic, B0-97)',
  'synthetic-no-equivalent-probes.json',
  'app-seed',
  'bex/seed/2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01/synthetic-no-equivalent-probes.json',
  5,
  'ready',
  'recommendations',
  jsonb_build_object(
    'synthetic', true,
    'purpose', 'B0-97 answer-gate negative-path coverage',
    'note', 'Fictional competitor products only — not real market data, not a substitute for an SME-reviewed no-equivalent seed list.'
  )
where not exists (
  select 1 from public.tests where id = '2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01'::uuid
);

insert into public.test_items
  (test_id, row_index, prompt, expected_result_type, expected_reason_code, input_payload)
select v.test_id, v.row_index, v.prompt, v.expected_result_type, v.expected_reason_code, v.input_payload
from (
  values
    (
      '2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01'::uuid, 1,
      'What is the Betco equivalent of Zorbex Klenz-9000?',
      'decline', 'no_confident_match',
      '{"source":"synthetic_no_equivalent_probe","competitor_brand":"Zorbex","competitor_product":"Klenz-9000"}'::jsonb
    ),
    (
      '2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01'::uuid, 2,
      'We currently use Nonexistex ProShine Ultra. Which Betco product should we switch to?',
      'decline', 'no_confident_match',
      '{"source":"synthetic_no_equivalent_probe","competitor_brand":"Nonexistex","competitor_product":"ProShine Ultra"}'::jsonb
    ),
    (
      '2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01'::uuid, 3,
      'Cross-reference Fictibrand QuantumClean 7 to a Betco product.',
      'decline', 'no_confident_match',
      '{"source":"synthetic_no_equivalent_probe","competitor_brand":"Fictibrand","competitor_product":"QuantumClean 7"}'::jsonb
    ),
    (
      '2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01'::uuid, 4,
      'Looking for a Betco alternative to Madeupco HyperFresh Foam. What do you recommend?',
      'decline', 'no_confident_match',
      '{"source":"synthetic_no_equivalent_probe","competitor_brand":"Madeupco","competitor_product":"HyperFresh Foam"}'::jsonb
    ),
    (
      '2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01'::uuid, 5,
      'Which Betco product replaces Placeholder Chemical Co''s Zenith 3000 Disinfectant?',
      'decline', 'no_confident_match',
      '{"source":"synthetic_no_equivalent_probe","competitor_brand":"Placeholder Chemical Co","competitor_product":"Zenith 3000 Disinfectant"}'::jsonb
    )
) as v(test_id, row_index, prompt, expected_result_type, expected_reason_code, input_payload)
where not exists (
  select 1 from public.test_items
  where test_id = '2f6a8c9a-2b7b-4e3f-8f2a-5f7c1c0f0a01'::uuid and row_index = v.row_index
);
