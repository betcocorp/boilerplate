import {
  isModelEffort,
  modelProviderFor,
  type GradingModelTag,
  type ModelEffort,
} from '~/lib/constants/models';
import { resolveModel } from '~/lib/llm/resolve-model';
import { getStringSetting } from '~/lib/settings/settings-service';

/**
 * B0-806 — which model grades a run report, and how hard it thinks. Both are settings rows (B0-638,
 * never env); both are read once per report by the orchestrator and persisted on `report_state`, so
 * a report always says what graded it and a mid-run settings change cannot split a report across
 * two models or two efforts.
 */

export const GRADING_MODEL_SETTING_KEY = 'REPORT_GRADING_MODEL';
export const GRADING_EFFORT_SETTING_KEY = 'REPORT_GRADING_EFFORT';

/**
 * B0-822 — Claude Opus 5 (Tom Bird, 2026-09-03), matching the desktop agent-evaluation flow. Used
 * only if the `REPORT_GRADING_MODEL` row is missing/unreadable; the row is seeded to the same tag
 * (`flip_report_grading_model_default_b0822`), so a missing row behaves identically. An Anthropic
 * tag needs `ANTHROPIC_API_KEY` and account credits — there is no fallback provider. The row is
 * switchable back to any `GRADING_MODEL_TAGS` tag (e.g. `gpt-5.6`) in /admin/settings.
 */
export const DEFAULT_GRADING_MODEL_TAG: GradingModelTag = 'claude-opus-5';

/** Anthropic's own default; `xhigh`/`max` buy depth for cost, `low`/`medium` the reverse. */
export const DEFAULT_GRADING_EFFORT: ModelEffort = 'high';

/**
 * Resolves a grading tag to the model id the provider is called with, through the vendor-neutral
 * `resolveModel` (B0-899/B0-902): an explicit tag — OpenAI or `claude-*` — gets the `BEX_MODEL_*`
 * env pins (`resolveResponsesModel` passes a Claude tag through as the exact Claude API id, B0-908),
 * and `preview` resolves to the default row of the vendor in `BEX_LLM_PROVIDER` rather than
 * always the OpenAI row.
 */
export async function resolveGradingModel(modelTag: string | undefined): Promise<string> {
  const tag = (modelTag ?? '').trim() || DEFAULT_GRADING_MODEL_TAG;
  return resolveModel(tag);
}

export async function loadGradingModelTag(): Promise<string> {
  return getStringSetting(GRADING_MODEL_SETTING_KEY, DEFAULT_GRADING_MODEL_TAG);
}

/**
 * `settings.allowed_values` is advisory metadata the admin API validates writes against, NOT a DB
 * constraint, so the stored value is re-validated here and an unrecognised one falls back to the
 * default rather than reaching the API as an invalid `effort`.
 */
export async function loadGradingEffort(): Promise<ModelEffort> {
  const raw = (await getStringSetting(GRADING_EFFORT_SETTING_KEY, DEFAULT_GRADING_EFFORT))
    .trim()
    .toLowerCase();
  return isModelEffort(raw) ? raw : DEFAULT_GRADING_EFFORT;
}

/**
 * The effort a report should RECORD: only an Anthropic model honours it, so on OpenAI the report
 * stores null rather than a number that had no effect on its grades.
 */
export function effortForModel(model: string, effort: ModelEffort): ModelEffort | null {
  return modelProviderFor(model) === 'anthropic' ? effort : null;
}

/** Reads a persisted `report_state.gradingEffort` back as a typed effort; anything unrecognised sends none. */
export function effortFromState(value: string | null | undefined): ModelEffort | undefined {
  return value && isModelEffort(value) ? value : undefined;
}
