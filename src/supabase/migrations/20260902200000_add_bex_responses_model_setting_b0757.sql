-- B0-757 — move the `resolveResponsesModel` "preview" default off process.env into public.settings.
--
-- `resolveResponsesModel` (~/lib/openai/client.ts) used to resolve the `preview` tag (the fleet-wide
-- default whenever a caller passes no explicit model, or the literal `preview` tag) via
-- `process.env.BEX_RESPONSES_MODEL ?? process.env.OPENAI_BEX_MODEL ?? 'gpt-4.1-mini'`. Neither env
-- var has ever been set in any environment (confirmed 2026-09-02, same as B0-603's finding for
-- BEX_VALIDATOR_MODEL), so `preview` has always silently resolved to `gpt-4.1-mini` — a materially
-- weaker/cheaper model than `gpt-4.1` — with nothing in the UI showing which model actually ran.
-- This invalidated a full 234-item regression run on 2026-08-29 (run
-- 7fb79091-e93b-4d52-a38b-4283f5cd639f scored 64.6/D vs 71.3/C for the same set on gpt-4.1).
--
-- Seeded to 'gpt-4.1-mini' so applying this migration alone is behavior-preserving for the many
-- other `preview` consumers across the app (live Bex chat's own model picker defaults to `preview`
-- too, plus the grader/failure-root-cause/category-classifier/competitor-extraction fallbacks) —
-- bumping the fleet-wide default is a separate, broader decision this ticket does not make. The
-- specific regression-run hazard is instead closed by changing the CI run-creation route
-- (`POST /api/admin/tests/runs`) and the "Run dataset" server action's hand-crafted-POST fallback
-- to default to `gpt-4.1` instead of `preview`, so an automated run that omits `modelTag` entirely
-- can no longer silently land on the cheaper model.
--
-- Unlike BEX_ROUTER_MODEL/BEX_VALIDATOR_MODEL (whose allowed lists mirror BEX_MODEL_TAGS and whose
-- readers re-validate against that enum), `allowed_values` is left NULL here on purpose: the old
-- BEX_RESPONSES_MODEL/OPENAI_BEX_MODEL env vars accepted ANY concrete OpenAI model id (e.g. a dated
-- snapshot like `gpt-4.1-mini-2026-01-01`), not just the BEX_MODEL_TAGS enum, and this row replaces
-- them one-for-one — a populated `allowed_values` would turn the /admin/settings field into a fixed
-- dropdown and remove that "pin an exact id without a deploy" capability. `resolveGenerationModelDefaultTag`
-- (~/lib/openai/client.ts) only guards against the literal string 'preview', which would otherwise
-- make `resolveResponsesModel('preview')` resolve to itself.
insert into public.settings (key, value, value_type, description, allowed_values)
values
  (
    'BEX_RESPONSES_MODEL',
    'gpt-4.1-mini',
    'string',
    'Concrete OpenAI model id the "preview" tag (and any missing/empty modelTag) resolves to via resolveResponsesModel (~/lib/openai/client.ts). Any concrete model id is accepted, same as the env vars it replaces (e.g. a dated snapshot) — just never the literal string "preview". Moved off the BEX_RESPONSES_MODEL / OPENAI_BEX_MODEL env vars per B0-638/B0-757 — neither was ever actually set, so this seed value preserves the real prior default exactly.',
    null
  )
on conflict (key) do nothing;
