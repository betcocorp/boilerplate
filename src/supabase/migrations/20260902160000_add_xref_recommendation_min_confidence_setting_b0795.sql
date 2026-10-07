-- B0-795 — move XREF_RECOMMENDATION_MIN_CONFIDENCE off process.env into public.settings.
--
-- B0-638 migrated ~15 flags from env to the settings table but missed this one:
-- `resolveXrefThreshold()` (src/lib/recommendations/confidence-scoring.ts) still read
-- `process.env.XREF_RECOMMENDATION_MIN_CONFIDENCE`. Verified live 2026-09-02: no settings row
-- existed (`select key from public.settings where key like '%XREF%'` returned only
-- XREF_RECOMMENDATION_TIMEOUT_MS) and no env var is set anywhere, so the live effective value has
-- always been the hardcoded DEFAULT_XREF_MIN_CONFIDENCE fallback of 0.80.
--
-- This row is therefore seeded to that SAME 0.80. Applying this migration changes NO behaviour by
-- design — it only moves where the number lives. B0-795's calibration explicitly did NOT retune the
-- value: with only 5 known-correct cases in the labeled set, and 1 labeled answered case above the
-- selection floor, `selectThreshold()` still refuses to name a threshold. Codifying a different
-- number here would be codifying a guess. See src/docs/cross-reference-recommendations.md.
--
-- Note this gate is separately bypassed in production while BEX_DISABLE_CONFIDENCE_GATING is true;
-- that flag is untouched here.
--
-- allowed_values is advisory metadata the admin API validates writes against and /admin/settings
-- renders — it is NOT a DB constraint (only value_type has a CHECK), which is why
-- `resolveXrefThreshold` re-validates the stored value via getNumberSetting's finite-number check
-- rather than trusting it.
insert into public.settings (key, value, value_type, description, allowed_values)
values
  (
    'XREF_RECOMMENDATION_MIN_CONFIDENCE',
    '0.80',
    'number',
    'Minimum overallConfidence (0-1) a web-grounded cross-reference recommendation must reach before gateRecommendation() will answer instead of declining to a sales rep. Read by resolveXrefThreshold (~/lib/recommendations/confidence-scoring); an explicit per-call threshold override still wins. Moved off the XREF_RECOMMENDATION_MIN_CONFIDENCE env var per B0-638/B0-795 - that env var was never set, so this seed value preserves the prior effective default (0.80) exactly. This number is NOT yet calibrated: see src/docs/cross-reference-recommendations.md before changing it, and note that BEX_DISABLE_CONFIDENCE_GATING currently bypasses this gate entirely.',
    null
  )
on conflict (key) do nothing;
