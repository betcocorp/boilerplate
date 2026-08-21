-- B0-615: structured per-criterion grading contract ("Option B" in
-- claude/eval-grading-business-case.md). Additive-only: default '[]' means every
-- existing test_items row (and every row inserted by a writer that doesn't know
-- about this column yet) keeps today's behavior-only grading unchanged.

ALTER TABLE public.test_items
  ADD COLUMN IF NOT EXISTS expected_criteria jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.test_items.expected_criteria IS
  'Array of {concept, tier: 1|2|3, match: "semantic"|"exact"}. Tier 1 = must-have (any miss fails the item), 2 = should-have (score only), 3 = bonus (score only). "exact" criteria are checked as a literal substring match in code, never by the LLM judge — reserved for regulated values (dilution ratios, oz/gal, mL/L, ppm, contact times, CAS/EPA registration numbers) per the org rule against rounding/converting/inferring them. Empty array = legacy behavior-only grading (~/lib/tests/runner.ts gradeChatTestResponse).';
