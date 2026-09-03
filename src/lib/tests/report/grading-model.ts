import {
  isModelEffort,
  modelProviderFor,
  type ModelEffort,
} from '~/lib/constants/models';
import { resolveResponsesModel } from '~/lib/openai/client';
import { getStringSetting } from '~/lib/settings/settings-service';

/**
 * B0-806 — which model grades a run report, and how hard it thinks. Both are settings rows (B0-638,
 * never env); both are read once per report by the orchestrator and persisted on `report_state`, so
 * a report always says what graded it and a mid-run settings change cannot split a report across
 * two models or two efforts.
 */

export const GRADING_MODEL_SETTING_KEY = 'REPORT_GRADING_MODEL';
export const GRADING_EFFORT_SETTING_KEY = 'REPORT_GRADING_EFFORT';

/** B0-765 — fallback only if the `REPORT_GRADING_MODEL` row is missing/unreadable (it is seeded `gpt-5.6`). */
export const DEFAULT_GRADING_MODEL_TAG = 'gpt-4.1';

/** Anthropic's own default; `xhigh`/`max` buy depth for cost, `low`/`medium` the reverse. */
export const DEFAULT_GRADING_EFFORT: ModelEffort = 'high';

/**
 * Resolves a grading tag to the model id the provider is called with. An Anthropic tag IS the exact
 * Claude API id and has no alias/env-override layer; an OpenAI tag goes through
 * `resolveResponsesModel` exactly as before, so `preview`, the `BEX_MODEL_*` pins and the
 * `BEX_RESPONSES_MODEL` row all still apply to grading on OpenAI.
 */
export async function resolveGradingModel(modelTag: string | undefined): Promise<string> {
  const tag = (modelTag ?? '').trim() || DEFAULT_GRADING_MODEL_TAG;
  if (modelProviderFor(tag) === 'anthropic') {
    return tag;
  }
  return resolveResponsesModel(tag);
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
