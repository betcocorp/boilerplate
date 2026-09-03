-- B0-756 — split BEX_DISABLE_CONFIDENCE_GATING into two independent kill switches.
--
-- Real Supabase-backed calibration research (test_result_items joined to workflow_steps.output
-- gate records, ~14.6k graded items) found six distinct mechanisms behind the one flag, with two
-- very different calibration stories:
--
--   * usage_safety_coverage (0.55 cap) and regulated_claim_guardrail (hard verbatim check) show
--     REAL separation between good and bad answers (or are correctness checks, not thresholds at
--     all) -- re-enabling these was correct and is left on BEX_DISABLE_CONFIDENCE_GATING, which
--     is now `false` in this project.
--   * The REC-4 similarity/brand/category-mismatch caps (recommendation-gate.ts,
--     LOW_SIMILARITY_CONFIDENCE_CAP=0.75/MISSING_BRAND_CONFIDENCE_CAP=0.8/
--     CATEGORY_MISMATCH_CONFIDENCE_CAP=0.2) and the XREF recommendation gate
--     (XREF_RECOMMENDATION_MIN_CONFIDENCE=0.80 + its validator floor=0.60) show an INVERTED
--     signal on the same data -- turns these caps hit graded BETTER than turns that passed
--     through uncapped (76.5% vs 62.0% pass). Re-enabling these as-is would very likely reproduce
--     the exact "confidence gate declining good answers" complaint that got the flag turned off
--     in the first place. This echoes B0-97's finding for the XREF score specifically (AUC 0.319,
--     "no usable ability to rank correct answers above wrong ones") -- the fix is to repair the
--     scorer, not slide a threshold on a non-predictive signal.
--
-- This row seeds the new, narrower kill switch (BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING) to
-- `true` (bypassed), so those four mechanisms stay off pending scorer work, independent of
-- BEX_DISABLE_CONFIDENCE_GATING's own state. See ~/lib/recommendations/confidence-scoring.ts's
-- `isRecommendationConfidenceGatingDisabled` for the code side of this split.
insert into public.settings (key, value, value_type, description, allowed_values)
values
  (
    'BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING',
    'true',
    'boolean',
    'B0-756 split of BEX_DISABLE_CONFIDENCE_GATING: bypasses ONLY the REC-4 similarity/brand/category-mismatch caps (recommendation-gate.ts) and the XREF recommendation gate + validator floor (confidence-scoring.ts, recommendation-guardrails.ts). Defaults to true (bypassed) -- real calibration data showed these four have an inverted/non-predictive signal (capped turns graded BETTER than uncapped ones). Do not flip to false until the underlying scorer is fixed and re-measured; sliding this threshold alone will not help. BEX_DISABLE_CONFIDENCE_GATING covers the other two mechanisms (usage-safety coverage, regulated-claim grounding) separately and is unaffected by this row.',
    null
  )
on conflict (key) do nothing;
