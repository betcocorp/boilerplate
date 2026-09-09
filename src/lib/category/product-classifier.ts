import {
  buildClassifierJsonSchema,
  buildClassifierPrompt,
  CLASSIFIER_NONE,
  CLASSIFIER_PROMPT_VERSION,
  classifierResultSchema,
  type ClassifierResult,
} from '~/lib/category/classifier-prompt';
import {
  CLASSIFIER_LINK_SOURCE,
  loadProdLineClassifierInputs,
  upsertClassifierLink,
  type ClassifierLink,
  type ProdLineClassifierInput,
} from '~/lib/category/classifier-repository';
import type { TaxonomyNode } from '~/lib/category/category-resolver';
import { loadTaxonomyNodes } from '~/lib/category/taxonomy-repository';
import { isBexModelTag } from '~/lib/constants/models';
import { resolveModel } from '~/lib/llm/resolve-model';
import { completeStructuredWithUsage } from '~/lib/llm/structured-completion';
import { getStringSetting } from '~/lib/settings/settings-service';
import { resolveMaxOutputTokens } from '~/lib/workflows/product-support/max-output-tokens';

/**
 * B0-35 — LLM classifier for prod-lines the deterministic linker (B0-34) could not place.
 *
 * For each unplaced prod-line it classifies the title/description into one taxonomy node with a
 * calibrated confidence, then routes:
 *   - grounded + confidence ≥ threshold → `linked` (written as a `source='classifier'` proposal),
 *   - grounded + below threshold        → `queued` (written too, but flagged low-confidence for the
 *     B0-36 review queue — a proposal, never treated as authoritative),
 *   - not grounded ("none" / unknown key) → `unclassified` (nothing written).
 * The prompt version + option-set size are recorded on every proposal for provenance. All LLM +
 * DB collaborators are injected so the routing is unit-testable without a model or database.
 */

export { CLASSIFIER_LINK_SOURCE };

export const DEFAULT_CLASSIFIER_MIN_CONFIDENCE = 0.7;

/** Resolve the auto-link confidence floor: env `CATEGORY_CLASSIFIER_MIN_CONFIDENCE` → default 0.70. */
export function resolveClassifierMinConfidence(override?: number | null): number {
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  const raw = process.env.CATEGORY_CLASSIFIER_MIN_CONFIDENCE?.trim();
  const env = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(env) ? env : DEFAULT_CLASSIFIER_MIN_CONFIDENCE;
}

export type ClassifierOutcome = 'linked' | 'queued' | 'unclassified';

export type ClassifierProposal = {
  prodLineKey: string;
  prodLineId: string | null;
  categoryKey: string | null;
  confidence: number;
  rationale: string;
  outcome: ClassifierOutcome;
  promptVersion: string;
  optionCount: number;
};

/** Pure routing: ground the chosen key against the option set, then split by the confidence floor. */
export function resolveClassifierOutcome(
  result: ClassifierResult,
  validKeys: Set<string>,
  threshold: number,
): { categoryKey: string | null; outcome: ClassifierOutcome } {
  if (result.category_key === CLASSIFIER_NONE || !validKeys.has(result.category_key)) {
    return { categoryKey: null, outcome: 'unclassified' };
  }
  return {
    categoryKey: result.category_key,
    outcome: result.confidence >= threshold ? 'linked' : 'queued',
  };
}

export type ClassifyDeps = {
  loadNodes: () => Promise<TaxonomyNode[]>;
  classify: (input: { title: string | null; description: string | null }, nodes: TaxonomyNode[]) => Promise<ClassifierResult>;
  persistLink: (link: ClassifierLink) => Promise<void>;
};

const defaultDeps: ClassifyDeps = {
  loadNodes: () => loadTaxonomyNodes(),
  classify: (input, nodes) => defaultClassify(input, nodes),
  persistLink: (link) => upsertClassifierLink(link),
};

export type RunProductClassifierResult = {
  proposals: ClassifierProposal[];
  summary: { total: number; linked: number; queued: number; unclassified: number };
};

export async function runProductClassifier(
  prodLines: ProdLineClassifierInput[],
  deps: ClassifyDeps = defaultDeps,
  opts: { minConfidence?: number } = {},
): Promise<RunProductClassifierResult> {
  const nodes = await deps.loadNodes();
  const validKeys = new Set(nodes.map((n) => n.key));
  const threshold = resolveClassifierMinConfidence(opts.minConfidence);
  const optionCount = nodes.length;

  const proposals: ClassifierProposal[] = [];
  for (const line of prodLines) {
    const result = await deps.classify({ title: line.title, description: line.description }, nodes);
    const { categoryKey, outcome } = resolveClassifierOutcome(result, validKeys, threshold);

    if (categoryKey) {
      await deps.persistLink({
        prodLineKey: line.prodLineKey,
        prodLineId: line.prodLineId,
        categoryKey,
        confidence: result.confidence,
      });
    }

    proposals.push({
      prodLineKey: line.prodLineKey,
      prodLineId: line.prodLineId,
      categoryKey,
      confidence: result.confidence,
      rationale: result.rationale,
      outcome,
      promptVersion: CLASSIFIER_PROMPT_VERSION,
      optionCount,
    });
  }

  const summary = {
    total: proposals.length,
    linked: proposals.filter((p) => p.outcome === 'linked').length,
    queued: proposals.filter((p) => p.outcome === 'queued').length,
    unclassified: proposals.filter((p) => p.outcome === 'unclassified').length,
  };
  return { proposals, summary };
}

/** Convenience: resolve prod-line text for the given keys, then classify + persist. */
export async function classifyUnplacedProdLines(
  prodLineKeys: string[],
  deps: ClassifyDeps = defaultDeps,
  opts: { minConfidence?: number } = {},
): Promise<RunProductClassifierResult> {
  const inputs = await loadProdLineClassifierInputs(prodLineKeys);
  return runProductClassifier(inputs, deps, opts);
}

/** B0-904 — the `settings` row holding this call's `BEX_MODEL_TAGS` tag (replaces the env var of the same name, B0-638). */
export const CATEGORY_CLASSIFIER_MODEL_SETTING_KEY = 'CATEGORY_CLASSIFIER_MODEL';

/**
 * B0-904 — the model tag for the category-classifier call, from the `CATEGORY_CLASSIFIER_MODEL`
 * settings row, re-validated against `BEX_MODEL_TAGS` (`allowed_values` is advisory, not a DB
 * constraint); an unrecognised value falls back to `preview`.
 */
export async function resolveCategoryClassifierModelTag(): Promise<string> {
  const raw = (await getStringSetting(CATEGORY_CLASSIFIER_MODEL_SETTING_KEY, 'preview')).trim();
  return isBexModelTag(raw) ? raw : 'preview';
}

/**
 * Resolved model id for the category-classifier call: the settings tag through `resolveModel`, so
 * `preview` follows the `BEX_LLM_PROVIDER` row's per-vendor default and an explicit tag (including
 * `claude-*`) resolves as everywhere else.
 */
export async function resolveCategoryClassifierModel(): Promise<string> {
  return resolveModel(await resolveCategoryClassifierModelTag());
}

/**
 * Default LLM classification: node keys enumerated in a strict json_schema. B0-908 — the call goes
 * through `completeStructuredWithUsage`, which routes on the resolved model id (`claude-*` →
 * Anthropic, otherwise OpenAI Responses). The previous direct call sent no output cap; the shared
 * `resolveMaxOutputTokens()` ceiling covers a key + confidence + one-line rationale. Truncation or
 * refusal throws into the same `classifier_failed` fallback a parse failure did. Exported so the
 * request shape can be asserted without a live model.
 */
export async function defaultClassify(
  input: { title: string | null; description: string | null },
  nodes: TaxonomyNode[],
): Promise<ClassifierResult> {
  try {
    const { text } = await completeStructuredWithUsage({
      model: await resolveCategoryClassifierModel(),
      system: buildClassifierPrompt(nodes),
      user: JSON.stringify({ title: input.title, description: input.description }),
      schemaName: 'category_classification',
      schema: buildClassifierJsonSchema(nodes.map((n) => n.key)),
      maxOutputTokens: resolveMaxOutputTokens(),
      temperature: 0,
    });
    return classifierResultSchema.parse(JSON.parse(text));
  } catch {
    return { category_key: CLASSIFIER_NONE, confidence: 0, rationale: 'classifier_failed' };
  }
}
