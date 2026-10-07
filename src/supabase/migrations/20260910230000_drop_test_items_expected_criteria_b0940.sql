-- B0-940 (epic B0-929) — drop `expected_criteria`, which no longer means anything distinct.
--
-- It arrived with B0-615 as `jsonb` holding tiered `{concept, tier, match}` objects, and its whole
-- purpose was carrying a tier and an exact-match flag the plain concept columns could not express.
-- B0-930 flattened it to `text[]`, which removed that purpose: `buildExpectedCriteria` assigns its
-- phrases tier 2, exactly what `expected_concepts` gets, so the two are indistinguishable at grade
-- time and an author has no way to know which to use.
--
-- No data is lost. The column has never held a value — 0 of 1,031 rows, before and after B0-930 —
-- so there is nothing to archive under `metadata` and nothing to restore if this is reverted.
--
-- The tier machinery itself stays: `minimum_concepts` -> tier 1 (gates the case) and
-- `expected_concepts` -> tier 2 (caps Completeness) still drive `gradeWithCriteria`.

alter table public.test_items drop column expected_criteria;
