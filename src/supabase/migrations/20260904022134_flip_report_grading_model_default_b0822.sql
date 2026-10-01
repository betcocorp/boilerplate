-- B0-822 — REPORT_GRADING_MODEL defaults to claude-opus-5 (decided by Tom Bird, 2026-09-03), to
-- match the desktop agent-evaluation grading flow (Claude Opus 5) the run report is measured against.
-- Applied live as migration `flip_report_grading_model_default_b0822`.
--
-- The B0-806 migration widened allowed_values to GRADING_MODEL_TAGS but deliberately left the VALUE
-- at gpt-5.6 pending the parity measurement (B0-824). This flips it, and rewrites the description
-- so the row states the current default instead of a promised future one. The code fallback
-- (DEFAULT_GRADING_MODEL_TAG, src/lib/tests/report/grading-model.ts) moves to claude-opus-5 in the
-- same change, so a missing or unreadable row behaves identically.
--
-- Idempotent: inserts the row on an environment that never got B0-765, updates value + description
-- where either differs, and is a no-op (updated_at untouched) where both already match. Never
-- changes allowed_values on an existing row (B0-806 owns that) and touches no other settings row.
--
-- Behaviour: every NEW run report grades on anthropic:claude-opus-5 at REPORT_GRADING_EFFORT. That
-- needs ANTHROPIC_API_KEY in env AND Anthropic account credits — there is no fallback provider, so a
-- grading call fails outright without them (seen live: run 12cef5c4-ac57-4001-a20b-44a1aae8bdaa
-- failed 2026-09-04 01:25 UTC with "Your credit balance is too low"). Switch the row back to gpt-5.6
-- in /admin/settings to grade on OpenAI again; reports already generated keep the model recorded on
-- their report_state.
insert into public.settings (key, value, value_type, description, allowed_values)
values (
  'REPORT_GRADING_MODEL',
  'claude-opus-5',
  'string',
  'Model tag used for LLM run-report grading (case scoring, case-scorer.ts) and Top-3 findings synthesis (synthesizer.ts) in orchestrator.ts (B0-765). Default claude-opus-5 per Tom Bird 2026-09-03 (B0-822), matching the desktop agent-evaluation grading flow; the code fallback DEFAULT_GRADING_MODEL_TAG (src/lib/tests/report/grading-model.ts) is the same tag, so a missing row behaves identically. Must be one of GRADING_MODEL_TAGS (~/lib/constants/models.ts): an OpenAI tag resolves through resolveResponsesModel (preview, the BEX_MODEL_* pins and the BEX_RESPONSES_MODEL row still apply); a claude-* tag is called on the Anthropic Messages API as-is (B0-806) and honours REPORT_GRADING_EFFORT. claude-* tags require ANTHROPIC_API_KEY in env and Anthropic account credits - there is no fallback provider, so grading fails outright without them. Switch back to gpt-5.6 (alias for gpt-5.6-sol; the default from 2026-08-31 to 2026-09-03) here in /admin/settings if needed. Read once per report and persisted on report_state, so a change affects new reports only.',
  array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-opus-5', 'claude-sonnet-5']
)
on conflict (key) do update
set value = excluded.value,
    description = excluded.description,
    updated_at = now()
where public.settings.value is distinct from excluded.value
   or public.settings.description is distinct from excluded.description;
