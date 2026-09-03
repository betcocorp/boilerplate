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
import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';

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

/** Default LLM classification: Responses API, node keys enumerated in a strict json_schema. */
async function defaultClassify(
  input: { title: string | null; description: string | null },
  nodes: TaxonomyNode[],
): Promise<ClassifierResult> {
  try {
    const client = getOpenAIClient();
    const res = await client.responses.create({
      model:
        process.env.CATEGORY_CLASSIFIER_MODEL?.trim() ||
        (await resolveResponsesModel('preview')),
      instructions: buildClassifierPrompt(nodes),
      input: [
        {
          role: 'user',
          content: JSON.stringify({ title: input.title, description: input.description }),
          type: 'message',
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'category_classification',
          strict: true,
          schema: buildClassifierJsonSchema(nodes.map((n) => n.key)),
        },
      },
      store: false,
      stream: false,
      temperature: 0,
    });
    return classifierResultSchema.parse(JSON.parse(extractAssistantText(res)));
  } catch {
    return { category_key: CLASSIFIER_NONE, confidence: 0, rationale: 'classifier_failed' };
  }
}
