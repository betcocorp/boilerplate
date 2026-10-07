-- B0-757 — move the three product-line retrieval-lock thresholds off process.env into
-- public.settings, same convention as every other settings-table migration (B0-638): flags,
-- models, thresholds and timeouts live in the table, env is for secrets/runtime-required values
-- only.
--
-- `~/lib/retrieval/product-line-resolution.ts` had three hardcoded consts, each independently
-- readable via a BEX_PRODUCT_LINE_LOCK_* env var (none of which was ever actually set in any
-- environment): MIN_LOCK_SIMILARITY (0.5), MIN_LOCK_MARGIN (0.06), HIGH_CONFIDENCE_ABSOLUTE (0.64).
-- Seeded at those exact values, so applying this migration alone changes nothing until someone
-- flips a row at /admin/settings. The one production call site
-- (`ragQueryForProductKnowledgeWithMeta`, ~/lib/retrieval/product-knowledge.ts) now reads these
-- through `getProductLineLockThresholds()` (~/lib/settings/settings-service.ts) before calling
-- `resolveProductLineFromMatches`; the function itself is untouched (still takes the same consts as
-- its own fallback defaults) so its unit tests and the B0-693 margin-corroboration logic are
-- unaffected.
insert into public.settings (key, value, value_type, description, allowed_values)
values
  (
    'BEX_PRODUCT_LINE_LOCK_MIN_SIMILARITY',
    '0.5',
    'number',
    'Minimum top-line cosine similarity for resolveProductLineFromMatches (~/lib/retrieval/product-line-resolution.ts) to consider locking retrieval to one product line. Below this, the lock is skipped as low-confidence regardless of margin. Moved off the BEX_PRODUCT_LINE_LOCK_MIN_SIMILARITY env var per B0-638/B0-757 — never actually set, so this seed value (0.5) preserves the prior default exactly.',
    null
  ),
  (
    'BEX_PRODUCT_LINE_LOCK_MARGIN',
    '0.06',
    'number',
    'Minimum spread between the #1 and #2 candidate product lines'' similarity scores for resolveProductLineFromMatches (~/lib/retrieval/product-line-resolution.ts) to corroborate a lock (B0-693). Moved off the BEX_PRODUCT_LINE_LOCK_MARGIN env var per B0-638/B0-757 — never actually set, so this seed value (0.06) preserves the prior default exactly.',
    null
  ),
  (
    'BEX_PRODUCT_LINE_LOCK_HIGH_CONFIDENCE',
    '0.64',
    'number',
    'Absolute top-line similarity threshold above which resolveProductLineFromMatches (~/lib/retrieval/product-line-resolution.ts) will lock even a close runner-up, UNLESS requireMarginForHighConfidence is set (the one production call site always sets it, per B0-693). Moved off the BEX_PRODUCT_LINE_LOCK_HIGH_CONFIDENCE env var per B0-638/B0-757 — never actually set, so this seed value (0.64) preserves the prior default exactly.',
    null
  )
on conflict (key) do nothing;
