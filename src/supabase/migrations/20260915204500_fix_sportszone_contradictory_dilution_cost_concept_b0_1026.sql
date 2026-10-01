-- B0-1026: SportsZone golden item 31024c03 (row 12, "When to choose water vs solvent based for a
-- wooden gym floor?") carries a mandatory (minimum_concepts) entry, "waterbased typically carries
-- lower cost", that directly contradicts its own ideal_response and two of its own other
-- expected_concepts, which correctly state solvent-based has the LOWER upfront cost and
-- water-based has a HIGHER upfront cost but better long-term ROI/value. A correct answer can never
-- satisfy both facts at once. Remove the false concept from both minimum_concepts and
-- expected_concepts (the accurate fact is already fully expressed by the two other
-- expected_concepts entries, so no information is lost).
update test_items
set
  minimum_concepts = array_remove(minimum_concepts, 'waterbased typically carries lower cost'),
  expected_concepts = array_remove(expected_concepts, 'waterbased typically carries lower cost'),
  metadata = jsonb_set(
    coalesce(metadata, '{}'::jsonb),
    '{b0_1026_change_reason}',
    jsonb_build_object(
      'date', '2026-09-15',
      'ticket', 'B0-1026',
      'change', 'Removed the mandatory concept "waterbased typically carries lower cost" from minimum_concepts and expected_concepts: it directly contradicted the row''s own ideal_response and two of its own other expected_concepts (solvent-based has the lower upfront cost; water-based has a higher upfront cost but better long-term ROI/value). No other concept changed.'
    ),
    true
  )
where id = '31024c03-c995-4daa-a102-71417cb7cf5c';
