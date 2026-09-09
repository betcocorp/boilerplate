-- B0-906 — HARNESS_INSIGHTS_MODEL: the model that writes the harness's narrative summaries.
--
-- Four calls describe a run rather than judge it, and before this ticket three of them hardcoded
-- `gpt-4.1-mini` in application code while the fourth silently followed the fleet chat default:
--   run insights            (src/lib/tests/run-insights.ts, "Analyze this run")
--   run comparison analysis (src/lib/tests/run-comparison-analysis.ts, new-failure triage)
--   item AI review          (src/app/(authenticated)/admin/tests/[testId]/items/[itemId]/actions.ts)
--   prompt trace insights   (src/app/api/admin/observability/runs/[runId]/insights/route.ts)
-- None of them affects a grade, which is why they share one row instead of following
-- TEST_ITEM_GRADING_MODEL (B0-902) — but none could be repointed without a deploy, which B0-638
-- forbids for a non-secret.
--
-- Read by `resolveHarnessInsightsModel` (~/lib/tests/harness-insights-model.ts) and resolved to a
-- concrete id via resolveModel (~/lib/llm/resolve-model.ts): `preview` follows the BEX_LLM_PROVIDER
-- row's per-vendor default (openai -> BEX_RESPONSES_MODEL, anthropic -> BEX_ANTHROPIC_MODEL); a
-- gpt-* tag is called on the OpenAI Responses API; a claude-* tag is the exact Claude API id and is
-- called on the Anthropic Messages API, which requires ANTHROPIC_API_KEY in env (a secret, so env
-- not settings). There is no fallback provider.
--
-- Seed value gpt-4.1-mini is behaviour-preserving: it is what three of the four already called.
-- Deliberately a concrete tag rather than `preview` — these summaries are cheap by design, and
-- inheriting the fleet default would silently re-price them against the chat model.
--
-- allowed_values is advisory metadata POST /api/admin/settings validates writes against and
-- /admin/settings renders as a select, NOT a DB constraint: the reader re-validates against
-- BEX_MODEL_TAGS and falls back to gpt-4.1-mini on anything unrecognised.
insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'HARNESS_INSIGHTS_MODEL',
    'gpt-4.1-mini',
    'string',
    'Model tag for the four eval-harness narrative calls: run insights ("Analyze this run"), run comparison analysis, per-item AI review, and prompt trace insights on /admin/observability (B0-906). None of them affects a grade — per-item grading is TEST_ITEM_GRADING_MODEL and report grading is REPORT_GRADING_MODEL. Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts); an unrecognised value is treated as gpt-4.1-mini. preview follows the BEX_LLM_PROVIDER row''s per-vendor default (openai -> BEX_RESPONSES_MODEL, anthropic -> BEX_ANTHROPIC_MODEL). A claude-* tag is the exact Claude API id, called on the Anthropic Messages API via ~/lib/llm/structured-completion, and requires ANTHROPIC_API_KEY in env plus account credits — there is no fallback provider. Seeded gpt-4.1-mini, which three of the four calls hardcoded before B0-906, so applying the migration changed nothing. The resolved id is persisted on each generated row (ai_suggestions.model) so a stored insight always says which model wrote it.',
    array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5']
  )
on conflict (key) do nothing;
