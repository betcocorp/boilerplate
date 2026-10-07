import { isBexModelTag, type BexModelTag } from '~/lib/constants/models';
import { resolveModel } from '~/lib/llm/resolve-model';
import { getStringSetting } from '~/lib/settings/settings-service';

/**
 * B0-921 — which model rewrites and decomposes a retrieval query. One resolver shared by the two
 * single-shot calls in `~/lib/rag/search.ts` that reshape the user's words before embedding:
 *
 *   - query rewrite        (`rewriteQueryWithLlm`)   — expand abbreviations, strip filler
 *   - intent decomposition (`expandQueryIntents`)    — split a multi-intent ask into sub-queries
 *
 * Both used to build an OpenAI client directly and call chat completions on a hardcoded
 * `gpt-4.1-mini` (with an `OPENAI_QUERY_REWRITE_MODEL` env override that was never set anywhere), so
 * the B0-898..908 vendor seam did not reach the retrieval path at all and the model could not be
 * changed without a deploy. Both now go through `~/lib/llm/structured-completion`, and the tag lives
 * in a `settings` row (B0-638: env is for secrets; models, flags and thresholds are rows).
 */

export const QUERY_REWRITE_MODEL_SETTING_KEY = 'BEX_QUERY_REWRITE_MODEL';

/**
 * Seeded value, and a deliberate OpenAI pin rather than `preview`: this is Betco's mixed-fleet
 * position (see the Confluence Recommendation page). Query rewriting fires on EVERY retrieval, and
 * `gpt-4.1-mini` is roughly 3x cheaper and 1.8x faster than the equivalent Claude tier
 * (`claude-haiku-4-5`), so the high-volume cheap tier stays on OpenAI even when `BEX_LLM_PROVIDER`
 * puts the answering fleet on Anthropic. It is a row, not a hardcode — an admin can move these two
 * calls to any `BEX_MODEL_TAGS` tag, including `preview` (follow the fleet) or a `claude-*` tag.
 */
export const DEFAULT_QUERY_REWRITE_MODEL_TAG: BexModelTag = 'gpt-4.1-mini';

/**
 * Reads the row as a typed tag. `settings.allowed_values` is advisory metadata the admin API
 * validates writes against, NOT a DB constraint, so the stored string is re-validated here and
 * anything unrecognised falls back to the default rather than reaching a provider as a non-existent
 * model id.
 */
export async function loadQueryRewriteModelTag(): Promise<BexModelTag> {
  const raw = (
    await getStringSetting(QUERY_REWRITE_MODEL_SETTING_KEY, DEFAULT_QUERY_REWRITE_MODEL_TAG)
  ).trim();
  return isBexModelTag(raw) ? raw : DEFAULT_QUERY_REWRITE_MODEL_TAG;
}

/**
 * The concrete model id the two calls are made with. Goes through the vendor-neutral `resolveModel`
 * (B0-899), so a `claude-*` tag runs on the Anthropic Messages API and `preview` follows whichever
 * per-vendor default row `BEX_LLM_PROVIDER` selects.
 */
export async function resolveQueryRewriteModel(): Promise<string> {
  return resolveModel(await loadQueryRewriteModelTag());
}
