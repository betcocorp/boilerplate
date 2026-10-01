import { isBexModelTag, type BexModelTag } from '~/lib/constants/models';
import { resolveModel } from '~/lib/llm/resolve-model';
import { getStringSetting } from '~/lib/settings/settings-service';

/**
 * B0-906 — which model writes the harness's narrative summaries. One resolver shared by the four
 * calls that describe a run rather than judge it:
 *
 *   - run insights            (`./run-insights.ts`, "Analyze this run")
 *   - run comparison analysis (`./run-comparison-analysis.ts`, new-failure triage)
 *   - item AI review          (`src/app/(authenticated)/admin/tests/[testId]/items/[itemId]/actions.ts`)
 *   - prompt trace insights   (`src/app/api/admin/observability/runs/[runId]/insights/route.ts`)
 *
 * None of them affects a grade — they are read by a human looking at a run — which is why they sit
 * on one row instead of following `TEST_ITEM_GRADING_MODEL`. Before this ticket three of the four
 * hardcoded `gpt-4.1-mini` and the fourth read `preview`, so none could be repointed without a
 * deploy (B0-638: models belong in `public.settings`, never in code or env).
 *
 * The seeded value is `gpt-4.1-mini`, which is what three of the four already called, so applying
 * the migration changes nothing until an admin picks another tag.
 */

export const HARNESS_INSIGHTS_MODEL_SETTING_KEY = 'HARNESS_INSIGHTS_MODEL';

/**
 * The tag three of the four call sites hardcoded before B0-906. Deliberately a concrete tag rather
 * than `preview`: these summaries are cheap-by-design, and inheriting the fleet default would
 * silently re-price them against whatever chat model the fleet is on.
 */
export const DEFAULT_HARNESS_INSIGHTS_MODEL_TAG: BexModelTag = 'gpt-4.1-mini';

/**
 * Reads the row as a typed tag. `settings.allowed_values` is advisory metadata the admin API
 * validates writes against, NOT a DB constraint, so the stored string is re-validated here and
 * anything unrecognised falls back to the default rather than reaching a provider as a
 * non-existent model id.
 */
export async function loadHarnessInsightsModelTag(): Promise<BexModelTag> {
  const raw = (
    await getStringSetting(
      HARNESS_INSIGHTS_MODEL_SETTING_KEY,
      DEFAULT_HARNESS_INSIGHTS_MODEL_TAG,
    )
  ).trim();
  return isBexModelTag(raw) ? raw : DEFAULT_HARNESS_INSIGHTS_MODEL_TAG;
}

/**
 * The concrete model id the insight calls are made with. Goes through the vendor-neutral
 * `resolveModel` (B0-899), so a `claude-*` tag runs on the Anthropic Messages API and `preview`
 * follows whichever per-vendor default row `BEX_LLM_PROVIDER` selects.
 */
export async function resolveHarnessInsightsModel(): Promise<string> {
  return resolveModel(await loadHarnessInsightsModelTag());
}
