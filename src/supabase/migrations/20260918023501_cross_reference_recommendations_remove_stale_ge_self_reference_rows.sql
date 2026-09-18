-- B0-1055: remove stale "GE Fight Bac RTU" cross-reference recommendation rows.
-- These are self-reference misfires that predate the B0-876 fix (competitor-self-reference.ts /
-- findBetcoSelfReferenceWebResult in recommend-cross-reference.ts), which now suppresses "GE"/
-- "Green Earth" line-prefixed products before they ever reach this table. All 5 rows are
-- unreviewed (status IN ('declined','escalated'), never verified/rejected), so deleting them
-- loses no human decision. Candidates cascade-delete via the existing FK.
delete from rag.cross_reference_recommendations
where lower(trim(coalesce(competitor_brand, ''))) = 'ge'
  and lower(trim(competitor_product)) = 'fight bac rtu'
  and status not in ('verified', 'rejected');
