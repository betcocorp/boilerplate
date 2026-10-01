-- B0-786 — configuration for the consolidated pre-orchestration signals-analysis call.
--
-- Three rows:
--   * BEX_SIGNALS_ANALYSIS_ENABLED — rollout flag for the new single-call signals path. Seeded
--     `false`, so applying this alone changes nothing: today's scattered intent-classifier +
--     keyword-signal path keeps deciding until someone flips it at /admin/settings.
--   * BEX_ROUTER_MODEL / BEX_ROUTER_TIMEOUT_MS — the model tag and latency ceiling for the
--     intent/signals classifier call. These two were the last `process.env` holdouts on this path
--     (read via resolveRouterModel/resolveRouterTimeoutMs in ~/lib/orchestrator/intent-classifier.ts);
--     moved here per B0-638 — flags, models, thresholds and timeouts live in `public.settings`,
--     env is for secrets and runtime-required values only.
--
-- APPLYING THIS MIGRATION CHANGES BEHAVIOUR: the router model becomes `gpt-4.1`, replacing the
-- `gpt-4o-mini` that DEFAULT_BEX_ROUTER_MODEL falls back to today. Decided by the product owner
-- 2026-09-01. Cost reporting is unaffected — `public.model_pricing` already carries a `gpt-4.1`
-- row (verified live 2026-09-01: $2.00 in / $0.50 cached / $8.00 out per Mtok), so the B0-565 cost
-- views' INNER lateral join still matches and the turn is not dropped from cost reporting. It is
-- however ~13x the rate of gpt-4o-mini on BOTH input and output ($2.00/$8.00 vs $0.15/$0.60 per
-- Mtok), on a per-turn call. Measured against 30 days of live classifier usage (avg 1,430 prompt /
-- 93 completion tokens over 2,928 calls) that is roughly $0.80 -> $10.60 per 30 days before
-- prompt-cache discounts.
-- BEX_ROUTER_TIMEOUT_MS is seeded at the existing DEFAULT_BEX_ROUTER_TIMEOUT_MS (5000ms), so the
-- ceiling is unchanged; on timeout the turn still degrades to the keyword router.
--
-- allowed_values on BEX_ROUTER_MODEL mirrors BEX_MODEL_TAGS (~/lib/constants/models.ts) exactly,
-- same convention as REPORT_GRADING_MODEL (B0-765) and ROUTER_TYPE (B0-656): advisory metadata the
-- admin API validates writes against and /admin/settings renders as a select — NOT a DB constraint
-- (only value_type has a CHECK), so readers must still re-validate the stored tag.
insert into public.settings (key, value, value_type, description, allowed_values)
values
  (
    'BEX_SIGNALS_ANALYSIS_ENABLED',
    'false',
    'boolean',
    'Rollout flag for the consolidated pre-orchestration signals-analysis call (B0-786): one LLM call that detects every user-prompt signal, replacing the scattered intent-classifier + keyword detection. Off = the existing scattered path decides. Off by default.',
    null
  ),
  (
    'BEX_ROUTER_MODEL',
    'gpt-4.1',
    'string',
    'Model tag for the intent/signals classifier call (B0-786). Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts); resolved to a concrete OpenAI model id via resolveResponsesModel (~/lib/openai/client.ts). Moved off the BEX_ROUTER_MODEL env var per B0-638. Set to gpt-4.1 2026-09-01 — the previous env/code default was gpt-4o-mini.',
    array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6']
  ),
  (
    'BEX_ROUTER_TIMEOUT_MS',
    '5000',
    'number',
    'Latency ceiling in milliseconds for the intent/signals classifier call (B0-786). On timeout the turn degrades to the keyword router rather than failing. Moved off the BEX_ROUTER_TIMEOUT_MS env var per B0-638; 5000 matches the existing DEFAULT_BEX_ROUTER_TIMEOUT_MS, set generously in B0-511 because live classifier calls run ~1.2-1.9s warm with tails past 2.5s.',
    null
  )
on conflict (key) do nothing;
