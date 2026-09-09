import {
  isBexModelTag,
  isModelEffort,
  modelProviderFor,
  type BexModelTag,
  type ModelEffort,
  type ModelProvider,
} from '~/lib/constants/models';
import { resolveModel } from '~/lib/llm/resolve-model';
import { getStringSetting } from '~/lib/settings/settings-service';

/**
 * B0-902 — which model the PER-ITEM graders use, and how hard an Anthropic one thinks. One resolver
 * shared by the three graders that judge a single harness item:
 *
 *   - semantic criteria grader   (`./criteria-grader.ts`)
 *   - semantic decline grader    (`./decline-grader.ts`)
 *   - failure root-cause analyst (`./failure-root-cause.ts`)
 *
 * Both knobs are settings rows (B0-638 — never env; the `BEX_GRADER_MODEL` /
 * `BEX_FAILURE_ROOT_CAUSE_MODEL` env reads are gone). The run-REPORT grader has its own pair
 * (`REPORT_GRADING_MODEL` / `REPORT_GRADING_EFFORT`, `./report/grading-model.ts`) because a report
 * is graded once, by one model, and says so; per-item grading happens inside the run and, by
 * default, follows whatever model the run itself was started with.
 */

export const ITEM_GRADING_MODEL_SETTING_KEY = 'TEST_ITEM_GRADING_MODEL';
export const ITEM_GRADING_EFFORT_SETTING_KEY = 'TEST_ITEM_GRADING_EFFORT';

/**
 * The sentinel row value meaning "grade with the run's own chat model" — the pre-B0-902 behaviour,
 * where each grader resolved `modelTag ?? 'preview'` exactly like the run did. It is the seeded
 * default so applying the migration changes nothing until an admin picks a tag.
 */
export const ITEM_GRADING_FOLLOW_RUN = 'run';

export type ItemGradingModelSetting = typeof ITEM_GRADING_FOLLOW_RUN | BexModelTag;

export const DEFAULT_ITEM_GRADING_MODEL_SETTING: ItemGradingModelSetting = ITEM_GRADING_FOLLOW_RUN;

/** Anthropic's own default; `xhigh`/`max` buy depth for cost, `low`/`medium` the reverse. */
export const DEFAULT_ITEM_GRADING_EFFORT: ModelEffort = 'high';

/**
 * Reads the `TEST_ITEM_GRADING_MODEL` row as a typed value. `settings.allowed_values` is advisory
 * metadata the admin API validates writes against, NOT a DB constraint, so the stored string is
 * re-validated here: anything that is neither `run` nor a `BEX_MODEL_TAGS` tag falls back to `run`
 * rather than reaching a provider as a non-existent model id.
 */
export async function loadItemGradingModelSetting(): Promise<ItemGradingModelSetting> {
  const raw = (
    await getStringSetting(ITEM_GRADING_MODEL_SETTING_KEY, DEFAULT_ITEM_GRADING_MODEL_SETTING)
  ).trim();
  if (raw === ITEM_GRADING_FOLLOW_RUN) return ITEM_GRADING_FOLLOW_RUN;
  return isBexModelTag(raw) ? raw : DEFAULT_ITEM_GRADING_MODEL_SETTING;
}

/**
 * Resolves the model id the per-item graders call, given the run's own model tag (the
 * `test_results.model` the run was started with; `undefined` for callers outside a run).
 *
 *   row = `run`  (default) → `resolveModel(runModelTag ?? 'preview')` — the grader follows the run.
 *   row = a tag            → `resolveModel(tag)` — one grader model for every run, regardless of the
 *                            chat model under test. `preview` here means the fleet default chosen
 *                            by `BEX_LLM_PROVIDER`; a `claude-*` tag routes to Anthropic.
 *
 * Always `resolveModel` (`~/lib/llm/resolve-model`), never `resolveResponsesModel` directly, so
 * `preview` honours the vendor row and the `BEX_MODEL_*` pins apply to explicit tags (B0-899).
 */
export async function resolveItemGradingModel(runModelTag?: string): Promise<string> {
  const setting = await loadItemGradingModelSetting();
  if (setting === ITEM_GRADING_FOLLOW_RUN) {
    return resolveModel(runModelTag ?? 'preview');
  }
  return resolveModel(setting);
}

/** Reads the `TEST_ITEM_GRADING_EFFORT` row; an unrecognised stored value falls back to `high`. */
export async function loadItemGradingEffort(): Promise<ModelEffort> {
  const raw = (
    await getStringSetting(ITEM_GRADING_EFFORT_SETTING_KEY, DEFAULT_ITEM_GRADING_EFFORT)
  )
    .trim()
    .toLowerCase();
  return isModelEffort(raw) ? raw : DEFAULT_ITEM_GRADING_EFFORT;
}

/** Everything a grader needs for one call, resolved once so the model it records is the model it called. */
export type ItemGradingConfig = {
  /** Resolved model id — the string the provider is called with and the one persisted as `gradingModel`. */
  model: string;
  provider: ModelProvider;
  /**
   * Only an Anthropic model honours `output_config.effort`; on OpenAI this is `undefined` so the
   * request carries no effort and nothing records one that had no effect (same rule as
   * `effortForModel` in `./report/grading-model.ts`).
   */
  effort: ModelEffort | undefined;
};

export async function resolveItemGradingConfig(runModelTag?: string): Promise<ItemGradingConfig> {
  const [model, effort] = await Promise.all([
    resolveItemGradingModel(runModelTag),
    loadItemGradingEffort(),
  ]);
  const provider = modelProviderFor(model);
  return { model, provider, effort: provider === 'anthropic' ? effort : undefined };
}
