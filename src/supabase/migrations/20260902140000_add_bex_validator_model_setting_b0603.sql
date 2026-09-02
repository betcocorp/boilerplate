-- B0-603 — move BEX_VALIDATOR_MODEL off process.env into public.settings, same convention as
-- BEX_ROUTER_MODEL (B0-786): flags, models, thresholds and timeouts live in the settings table,
-- env is for secrets and runtime-required values only (B0-638).
--
-- BEX_VALIDATOR_MODEL was never actually set anywhere (confirmed 2026-09-02 — no env file, no
-- production override), so `resolveValidatorModel` always fell through to
-- `resolveResponsesModel(modelTag ?? 'preview')`, i.e. the validator's real default has always
-- been the 'preview' tag (gpt-4.1-mini), not 'gpt-4.1' as B0-603's ticket text assumed. Seeding
-- this row to 'preview' keeps that behavior unchanged — applying this migration alone changes
-- nothing. An explicit `modelTag` (e.g. a test run's model override) still wins over this row;
-- it only supplies the default when no override is given.
--
-- allowed_values mirrors BEX_MODEL_TAGS (~/lib/constants/models.ts) exactly, same convention as
-- BEX_ROUTER_MODEL/REPORT_GRADING_MODEL: advisory metadata the admin API validates writes
-- against and /admin/settings renders as a select — NOT a DB constraint.
insert into public.settings (key, value, value_type, description, allowed_values)
values
  (
    'BEX_VALIDATOR_MODEL',
    'preview',
    'string',
    'Model tag the validator pass (runValidatorPass, ~/lib/workflows/product-support/validator.ts) calls when a run does not pass an explicit modelTag override. Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts); resolved to a concrete OpenAI model id via resolveResponsesModel. Moved off the BEX_VALIDATOR_MODEL env var per B0-638/B0-603 — that env var was never actually set, so this seed value (preview -> gpt-4.1-mini) preserves the real prior default exactly.',
    array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6']
  )
on conflict (key) do nothing;
