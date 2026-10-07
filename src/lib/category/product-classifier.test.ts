import { beforeEach, describe, expect, it, vi } from 'vitest';

// B0-904 — the model comes from the CATEGORY_CLASSIFIER_MODEL settings row (default `preview`)
// through `resolveModel`; both are mocked so no test touches Supabase or a provider.
const { mockComplete, mockResolveModel, mockLogError, settingOverrides } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockResolveModel: vi.fn(async (tag: string) => (tag === 'preview' ? 'gpt-test' : tag)),
  mockLogError: vi.fn(),
  settingOverrides: new Map<string, string>(),
}));
vi.mock('~/lib/llm/structured-completion', () => ({
  completeStructuredWithUsage: mockComplete,
}));
vi.mock('~/lib/observability/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: mockLogError,
}));
vi.mock('~/lib/llm/resolve-model', () => ({
  resolveModel: mockResolveModel,
}));
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: vi.fn((key: string, fallback: string) =>
    Promise.resolve(settingOverrides.get(key) ?? fallback),
  ),
}));
vi.mock('~/lib/workflows/product-support/max-output-tokens', () => ({
  resolveMaxOutputTokens: () => 1200,
}));
// The default deps reach Supabase; neither repository is exercised here but both must not connect on import.
vi.mock('~/lib/category/classifier-repository', () => ({
  CLASSIFIER_LINK_SOURCE: 'classifier',
  loadProdLineClassifierInputs: vi.fn(),
  upsertClassifierLink: vi.fn(),
}));
vi.mock('~/lib/category/taxonomy-repository', () => ({
  loadTaxonomyNodes: vi.fn(),
}));

import {
  buildClassifierJsonSchema,
  buildClassifierPrompt,
  CLASSIFIER_PROMPT_VERSION,
  formatNodeOptions,
  type ClassifierResult,
} from '~/lib/category/classifier-prompt';
import type { ClassifierLink } from '~/lib/category/classifier-repository';
import type { TaxonomyNode } from '~/lib/category/category-resolver';
import {
  defaultClassify,
  resolveClassifierOutcome,
  runProductClassifier,
  type ClassifyDeps,
} from '~/lib/category/product-classifier';

const NODES: TaxonomyNode[] = [
  { key: 'disinfectants', name: 'Disinfectants', path: ['Cleaning', 'Disinfectants'] },
  { key: 'floor-care', name: 'Floor Care', path: ['Cleaning', 'Floor Care'] },
];
const VALID = new Set(NODES.map((n) => n.key));

const result = (over: Partial<ClassifierResult> = {}): ClassifierResult => ({
  category_key: 'disinfectants',
  confidence: 0.9,
  rationale: 'quat disinfectant',
  ...over,
});

describe('resolveClassifierOutcome (B0-35)', () => {
  it('links a grounded, high-confidence result', () => {
    expect(resolveClassifierOutcome(result(), VALID, 0.7)).toEqual({
      categoryKey: 'disinfectants',
      outcome: 'linked',
    });
  });
  it('queues a grounded, below-threshold result for review', () => {
    expect(resolveClassifierOutcome(result({ confidence: 0.5 }), VALID, 0.7)).toEqual({
      categoryKey: 'disinfectants',
      outcome: 'queued',
    });
  });
  it('marks "none" as unclassified', () => {
    expect(resolveClassifierOutcome(result({ category_key: 'none' }), VALID, 0.7)).toEqual({
      categoryKey: null,
      outcome: 'unclassified',
    });
  });
  it('rejects a key not in the option set (grounding)', () => {
    expect(resolveClassifierOutcome(result({ category_key: 'made-up' }), VALID, 0.7)).toEqual({
      categoryKey: null,
      outcome: 'unclassified',
    });
  });
});

describe('runProductClassifier (B0-35)', () => {
  const inputs = [
    { prodLineKey: 'L1', prodLineId: 'P1', title: 'Quat Disinfectant', description: null },
    { prodLineKey: 'L2', prodLineId: 'P2', title: 'Mystery Product', description: null },
    { prodLineKey: 'L3', prodLineId: 'P3', title: 'Weak Floor Signal', description: null },
  ];

  it('routes each prod-line and persists only grounded proposals', async () => {
    const persisted: ClassifierLink[] = [];
    const byLine: Record<string, ClassifierResult> = {
      L1: result({ category_key: 'disinfectants', confidence: 0.95 }), // linked
      L2: result({ category_key: 'none', confidence: 0 }), // unclassified
      L3: result({ category_key: 'floor-care', confidence: 0.55 }), // queued
    };
    let idx = 0;
    const deps: ClassifyDeps = {
      loadNodes: async () => NODES,
      classify: async () => byLine[inputs[idx++].prodLineKey],
      persistLink: async (link) => { persisted.push(link); },
    };

    const { proposals, summary } = await runProductClassifier(inputs, deps, { minConfidence: 0.7 });

    expect(summary).toEqual({ total: 3, linked: 1, queued: 1, unclassified: 1 });
    // grounded proposals (linked + queued) are persisted; the unclassified one is not
    expect(persisted.map((p) => p.prodLineKey).sort()).toEqual(['L1', 'L3']);
    expect(proposals.every((p) => p.promptVersion === CLASSIFIER_PROMPT_VERSION)).toBe(true);
    expect(proposals.every((p) => p.optionCount === NODES.length)).toBe(true);
    expect(proposals.find((p) => p.prodLineKey === 'L2')?.categoryKey).toBeNull();
  });

  it('does not persist when nothing is grounded', async () => {
    const persist = vi.fn(async () => {});
    const deps: ClassifyDeps = {
      loadNodes: async () => NODES,
      classify: async () => result({ category_key: 'none', confidence: 0 }),
      persistLink: persist,
    };
    const { summary } = await runProductClassifier([inputs[0]], deps);
    expect(summary.unclassified).toBe(1);
    expect(persist).not.toHaveBeenCalled();
  });
});

/**
 * B0-908 — the default classifier goes through the provider-neutral `completeStructuredWithUsage`,
 * so a `claude-*` id resolved for the `preview` tag is sent as-is with the same prompt + enumerated
 * key schema. A failure still returns the `classifier_failed` sentinel.
 */
describe('defaultClassify (B0-908)', () => {
  const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 };

  beforeEach(() => {
    mockComplete.mockReset();
    mockResolveModel.mockReset();
    mockResolveModel.mockResolvedValue('claude-sonnet-5');
    mockLogError.mockClear();
    settingOverrides.clear();
  });

  it('B0-904 — reads the model tag from the CATEGORY_CLASSIFIER_MODEL settings row and resolves it through resolveModel', async () => {
    settingOverrides.set('CATEGORY_CLASSIFIER_MODEL', 'claude-haiku-4-5');
    mockResolveModel.mockImplementation(async (tag: string) => tag);
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ category_key: 'floor-care', confidence: 0.8, rationale: 'finish' }),
      usage: USAGE,
    });

    await defaultClassify({ title: 'Floor Finish', description: null }, NODES);

    expect(mockResolveModel).toHaveBeenCalledWith('claude-haiku-4-5');
    expect(mockComplete.mock.calls[0][0].model).toBe('claude-haiku-4-5');
  });

  it('B0-904 — a stored value outside BEX_MODEL_TAGS falls back to the preview tag (allowed_values is advisory)', async () => {
    settingOverrides.set('CATEGORY_CLASSIFIER_MODEL', 'gpt-4o-mini');
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ category_key: 'floor-care', confidence: 0.8, rationale: 'finish' }),
      usage: USAGE,
    });

    await defaultClassify({ title: 'Floor Finish', description: null }, NODES);

    expect(mockResolveModel).toHaveBeenCalledWith('preview');
  });

  it('calls completeStructuredWithUsage with the resolved claude id and the enumerated-key schema', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ category_key: 'floor-care', confidence: 0.8, rationale: 'finish' }),
      usage: USAGE,
    });

    const out = await defaultClassify({ title: 'Floor Finish', description: null }, NODES);

    expect(mockResolveModel).toHaveBeenCalledWith('preview');
    expect(mockComplete).toHaveBeenCalledOnce();
    expect(mockComplete.mock.calls[0][0]).toMatchObject({
      model: 'claude-sonnet-5',
      system: buildClassifierPrompt(NODES),
      user: JSON.stringify({ title: 'Floor Finish', description: null }),
      schemaName: 'category_classification',
      schema: buildClassifierJsonSchema(['disinfectants', 'floor-care']),
      maxOutputTokens: 1200,
      temperature: 0,
    });
    expect(out).toEqual({ category_key: 'floor-care', confidence: 0.8, rationale: 'finish' });
  });

  it('returns the classifier_failed sentinel when the helper throws', async () => {
    mockComplete.mockRejectedValue(new Error('output truncated at max_output_tokens'));

    const out = await defaultClassify({ title: 'Floor Finish', description: null }, NODES);

    expect(out).toEqual({ category_key: 'none', confidence: 0, rationale: 'classifier_failed' });
  });

  /**
   * B0-922 — `classifier_failed` is a plausible-looking result only a string match can distinguish
   * from a genuine "none", so it must never be silent. A provider failure is logged once by the seam
   * itself; the model-answered-but-unusable path never reaches the seam's catch, so it logs here.
   */
  it('does not double-log a provider failure the seam already recorded', async () => {
    mockComplete.mockRejectedValue(new Error('400 invalid schema'));

    await defaultClassify({ title: 'Floor Finish', description: null }, NODES);

    expect(mockLogError).not.toHaveBeenCalled();
  });

  it.each([
    ['unparseable JSON', 'not json at all'],
    ['JSON that fails the result schema', JSON.stringify({ category_key: 'floor-care' })],
  ])('logs the sentinel when the model answers with %s', async (_label, text) => {
    mockComplete.mockResolvedValue({ text, usage: USAGE });

    const out = await defaultClassify({ title: 'Floor Finish', description: null }, NODES);

    expect(out).toEqual({ category_key: 'none', confidence: 0, rationale: 'classifier_failed' });
    expect(mockLogError).toHaveBeenCalledOnce();
    expect(mockLogError).toHaveBeenCalledWith(
      'category_classifier_unusable_output',
      expect.objectContaining({
        model: 'claude-sonnet-5',
        schema: 'category_classification',
        optionCount: NODES.length,
      }),
    );
  });
});

describe('classifier prompt (B0-35)', () => {
  it('lists every node key as an option', () => {
    const options = formatNodeOptions(NODES);
    expect(options).toContain('disinfectants:');
    expect(options).toContain('floor-care:');
    const prompt = buildClassifierPrompt(NODES);
    expect(prompt).toContain('Disinfectants');
    expect(prompt).toContain('"none"');
  });
});
