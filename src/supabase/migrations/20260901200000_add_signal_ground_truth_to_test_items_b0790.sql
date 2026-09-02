-- B0-790: typed ground-truth columns for three of the four signals with no ground truth today
-- (product_mention already has ground truth in input_payload.product_mention — see
-- ~/lib/tests/signal-accuracy.ts). Provenance: TurnSignals contract, B0-786
-- (~/lib/orchestrator/signals/signals-schemas.ts) — surfaceType: z.string().nullable(),
-- brandFamily: z.enum(BRAND_FAMILIES).nullable(), setting: z.enum(USE_SETTINGS).nullable().
-- Plain nullable text (no CHECK constraint) even though brandFamily/setting are closed unions in
-- TS — validated in Zod/app code only, matching intended_agent_item's own precedent
-- (20260815120000_add_intended_agent_item_to_test_items_b0498.sql).

ALTER TABLE public.test_items
  ADD COLUMN IF NOT EXISTS expected_surface_type text NULL,
  ADD COLUMN IF NOT EXISTS expected_brand_family text NULL,
  ADD COLUMN IF NOT EXISTS expected_setting text NULL;

COMMENT ON COLUMN public.test_items.expected_surface_type IS
  'Per-item ground-truth surface type (matches TurnSignals.surfaceType, B0-786) for scoring the signals-extraction harness (B0-790). Null if unlabeled.';

COMMENT ON COLUMN public.test_items.expected_brand_family IS
  'Per-item ground-truth brand family: betco | basic_coatings | envirozyme | 1950 | competitor (matches TurnSignals.brandFamily / BRAND_FAMILIES, B0-786) for scoring the signals-extraction harness (B0-790). Null if unlabeled.';

COMMENT ON COLUMN public.test_items.expected_setting IS
  'Per-item ground-truth use setting: commercial | residential (matches TurnSignals.setting / USE_SETTINGS, B0-786) for scoring the signals-extraction harness (B0-790). Null if unlabeled.';
