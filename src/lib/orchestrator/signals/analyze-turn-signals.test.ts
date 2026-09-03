import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-786 — every test here injects `runLlm` and the two resolvers. No live model call is made (the
 * `ClassifyUserIntentDeps` / `ExtractCompetitorProductDeps` pattern this module follows), so the
 * suite runs with no OpenAI key.
 */
const responsesCreateMock = vi.fn();
vi.mock('~/lib/openai/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/openai/client')>();
  return {
    ...actual,
    getOpenAIClient: () => ({
      responses: { create: (...args: unknown[]) => responsesCreateMock(...args) },
    }),
  };
});

const settingOverrides = new Map<string, boolean | string | number>();
vi.mock('~/lib/settings/settings-service', () => ({
  getBooleanSetting: vi.fn((key: string, fallback: boolean) =>
    Promise.resolve(settingOverrides.has(key) ? (settingOverrides.get(key) as boolean) : fallback),
  ),
  getStringSetting: vi.fn((key: string, fallback: string) =>
    Promise.resolve(settingOverrides.has(key) ? (settingOverrides.get(key) as string) : fallback),
  ),
  getNumberSetting: vi.fn((key: string, fallback: number) =>
    Promise.resolve(settingOverrides.has(key) ? (settingOverrides.get(key) as number) : fallback),
  ),
}));

import {
  analyzeTurnSignals,
  buildSignalsInstructions,
  competitorIdentityFromSignals,
  computeTurnSignalsCacheKey,
  fallbackTurnSignals,
  getTurnSignalsCacheStats,
  resetTurnSignalsCache,
  toIntentClassification,
  type AnalyzeTurnSignalsDeps,
} from '~/lib/orchestrator/signals/analyze-turn-signals';
import { turnSignalsSchema, type LlmTurnSignals } from '~/lib/orchestrator/signals/signals-schemas';
import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';

const USAGE = { promptTokens: 11, completionTokens: 3, totalTokens: 14, cachedPromptTokens: 0 };

const LLM_SIGNALS: LlmTurnSignals = {
  intent: 'floor_vct',
  confidence: 0.9,
  betcoProduct: 'Speedex',
  competitorBrand: null,
  competitorProduct: null,
  otherCompetitorProduct: null,
  surfaceType: 'VCT floor',
  taskDescription: 'strip and recoat a VCT floor',
  brandFamily: 'betco',
  setting: 'commercial',
  productCategory: 'floor stripper',
  carriedProduct: null,
  suggestedTool: 'search_product_docs',
  crossReferenceIntent: false,
  competitorIsGenericChemistry: false,
  isConversionListAsk: false,
  answerShape: 'procedure',
  declineClass: null,
  regulatedSectionIntent: true,
};

function deps(overrides: Partial<AnalyzeTurnSignalsDeps> = {}): AnalyzeTurnSignalsDeps {
  return {
    runLlm: vi.fn().mockResolvedValue({ parsed: LLM_SIGNALS, usage: USAGE }),
    resolveProductEntity: vi
      .fn()
      .mockResolvedValue({ productLineKey: 'PL-9', resolutionSource: 'alias_exact' }),
    resolveBetcoEntity: vi.fn().mockResolvedValue({
      productLineKey: null,
      ambiguousAlias: false,
      catalogMatch: false,
      catalogProductLineKey: null,
    }),
    now: () => Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  resetTurnSignalsCache();
  responsesCreateMock.mockReset();
  settingOverrides.clear();
  settingOverrides.set('BEX_SIGNALS_ANALYSIS_ENABLED', true);
});

afterEach(() => {
  resetTurnSignalsCache();
  settingOverrides.clear();
});

describe('analyzeTurnSignals — one call, then deterministic enrichment', () => {
  it('returns a schema-valid result with the model signals and the enrichment', async () => {
    const d = deps();
    const out = await analyzeTurnSignals('how do I strip and recoat a VCT floor with Speedex', [], d);

    expect(turnSignalsSchema.parse(out)).toBeTruthy();
    expect(out.source).toBe('llm');
    expect(out.fallbackReason).toBeNull();
    expect(out.intent).toBe('floor_vct');
    expect(out.answerShape).toBe('procedure');
    expect(out.regulatedSectionIntent).toBe(true);
    expect(out.usage).toEqual(USAGE);
    // Enrichment: resolved from `betcoProduct`, NOT asserted by the model.
    expect(out.resolvedProductLineKey).toBe('PL-9');
    expect(out.resolutionSource).toBe('alias_exact');
    expect(d.resolveProductEntity).toHaveBeenCalledWith('Speedex');
  });

  it('clamps a confidence the model returned out of range', async () => {
    const out = await analyzeTurnSignals(
      'anything',
      [],
      deps({ runLlm: vi.fn().mockResolvedValue({ parsed: { ...LLM_SIGNALS, confidence: 1.7 }, usage: USAGE }) }),
    );
    expect(out.confidence).toBe(1);
  });

  it('does not resolve a product line when the model named no Betco product', async () => {
    const d = deps({
      runLlm: vi.fn().mockResolvedValue({ parsed: { ...LLM_SIGNALS, betcoProduct: null }, usage: USAGE }),
    });
    const out = await analyzeTurnSignals('what should I use', [], d);
    expect(d.resolveProductEntity).not.toHaveBeenCalled();
    expect(out.resolvedProductLineKey).toBeNull();
    expect(out.resolutionSource).toBeNull();
  });

  it('runs the self-reference check for a cross-reference turn, reusing the extracted identity', async () => {
    const d = deps({
      runLlm: vi.fn().mockResolvedValue({
        parsed: {
          ...LLM_SIGNALS,
          intent: 'cross_reference',
          betcoProduct: null,
          competitorBrand: null,
          competitorProduct: 'speedex',
          crossReferenceIntent: true,
        },
        usage: USAGE,
      }),
      resolveBetcoEntity: vi.fn().mockResolvedValue({
        productLineKey: 'PL-42',
        ambiguousAlias: false,
        catalogMatch: true,
        catalogProductLineKey: 'PL-42',
      }),
    });

    const out = await analyzeTurnSignals('what is the Betco equivalent of speedex', [], d);

    // The identity handed to the resolver is the one the SIGNALS call produced — no second
    // extraction call exists on this path.
    expect(d.resolveBetcoEntity).toHaveBeenCalledWith('speedex');
    expect(out.selfReferenceVerdict).toEqual({
      suppressed: true,
      reason: 'betco_product',
      productLineKey: 'PL-42',
      matched: 'speedex',
    });
  });

  it('lets the model signal decide the chemistry-term suppression, not CHEMISTRY_TERMS', async () => {
    const d = deps({
      runLlm: vi.fn().mockResolvedValue({
        parsed: {
          ...LLM_SIGNALS,
          intent: 'cross_reference',
          betcoProduct: null,
          competitorProduct: 'sodium hypochlorite solution',
          crossReferenceIntent: true,
          competitorIsGenericChemistry: true,
        },
        usage: USAGE,
      }),
    });

    const out = await analyzeTurnSignals('a Betco equivalent for sodium hypochlorite solution', [], d);
    // "sodium hypochlorite solution" is not in CHEMISTRY_TERMS — only the signal can catch it.
    expect(out.selfReferenceVerdict).toEqual({
      suppressed: true,
      reason: 'chemistry_term',
      productLineKey: null,
      matched: 'sodium hypochlorite solution',
    });
  });

  it('leaves the self-reference verdict null when the turn is not a cross-reference candidate', async () => {
    const d = deps();
    const out = await analyzeTurnSignals('how do I strip a VCT floor', [], d);
    expect(out.selfReferenceVerdict).toBeNull();
    expect(d.resolveBetcoEntity).not.toHaveBeenCalled();
  });
});

describe('analyzeTurnSignals — safety contract (never throws)', () => {
  it('degrades to the keyword router when the LLM call rejects', async () => {
    const out = await analyzeTurnSignals(
      'strip and recoat this VCT floor',
      [],
      deps({ runLlm: vi.fn().mockRejectedValue(new Error('llm down')) }),
    );

    expect(out.source).toBe('keyword_fallback');
    expect(out.fallbackReason).toBe('llm down');
    expect(out.usage).toBeNull();
    expect(out.model).toBeNull();
    // The keyword router's own decision, per the B0-786 "keyword router stays the floor" rule.
    expect(out.intent).toBe(routeUserMessageToSme('strip and recoat this VCT floor').agent ?? 'ambiguous');
    expect(turnSignalsSchema.safeParse(out).success).toBe(true);
  });

  it('degrades when the call exceeds BEX_ROUTER_TIMEOUT_MS, and never throws', async () => {
    settingOverrides.set('BEX_ROUTER_TIMEOUT_MS', 10);
    const out = await analyzeTurnSignals(
      'calibrate the dispenser tip chart',
      [],
      deps({
        runLlm: vi.fn(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ parsed: LLM_SIGNALS, usage: USAGE }), 100);
            }),
        ) as AnalyzeTurnSignalsDeps['runLlm'],
      }),
    );

    expect(out.source).toBe('keyword_fallback');
    expect(out.fallbackReason).toContain('router timeout');
  });

  it('degrades on a parse failure (a payload that is not the contract)', async () => {
    const out = await analyzeTurnSignals(
      'anything at all',
      [],
      deps({
        runLlm: vi.fn(async () => {
          // Mimics `llmTurnSignalsSchema.parse` rejecting a malformed model payload.
          throw new Error('invalid signals payload');
        }),
      }),
    );
    expect(out.source).toBe('keyword_fallback');
    expect(out.fallbackReason).toBe('invalid signals payload');
  });

  it('returns the disabled-flag fallback without calling the model or the resolvers', async () => {
    settingOverrides.set('BEX_SIGNALS_ANALYSIS_ENABLED', false);
    const d = deps();
    const out = await analyzeTurnSignals('strip and recoat this VCT floor', [], d);

    expect(d.runLlm).not.toHaveBeenCalled();
    expect(d.resolveProductEntity).not.toHaveBeenCalled();
    expect(out.source).toBe('keyword_fallback');
    expect(out.fallbackReason).toBe('signals_analysis_disabled');
  });

  it('degraded results carry the keyword cross-reference signal, matching the pre-B0-786 world', () => {
    const degraded = fallbackTurnSignals(
      'what is comparable to Spartan BNC-15',
      'llm_router_disabled',
    );
    expect(degraded.crossReferenceIntent).toBe(true);
    // Every other new signal degrades to its NEUTRAL value, never a guess.
    expect(degraded.answerShape).toBe('single_value');
    expect(degraded.declineClass).toBeNull();
    expect(degraded.regulatedSectionIntent).toBe(false);
    expect(degraded.isConversionListAsk).toBe(false);
  });
});

describe('analyzeTurnSignals — cache', () => {
  it('serves an identical (message, priorTurns) call from cache without re-invoking the model', async () => {
    const d = deps();
    await analyzeTurnSignals('same message', [], d);
    const second = await analyzeTurnSignals('same message', [], d);

    expect(d.runLlm).toHaveBeenCalledOnce();
    expect(getTurnSignalsCacheStats().hits).toBe(1);
    // A cache hit made no model call, so its tokens must not be re-attributed to this turn.
    expect(second.usage).toBeNull();
  });

  it('never caches a failure: the next identical call retries', async () => {
    const runLlm = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ parsed: LLM_SIGNALS, usage: USAGE });
    const d = deps({ runLlm });

    const first = await analyzeTurnSignals('flaky message', [], d);
    const second = await analyzeTurnSignals('flaky message', [], d);

    expect(first.source).toBe('keyword_fallback');
    expect(second.source).toBe('llm');
    expect(runLlm).toHaveBeenCalledTimes(2);
  });

  it('folds the contract version into the key so a contract change cannot serve a stale shape', () => {
    const key = computeTurnSignalsCacheKey('a message');
    // Different from the plain intent-classifier key for the same message.
    expect(key).not.toBe(computeTurnSignalsCacheKey('a message', [], 'other-model'));
    expect(key).toHaveLength(64);
  });
});

describe('adapters', () => {
  it('toIntentClassification re-nests the entity fields losslessly', async () => {
    const signals = await analyzeTurnSignals('how do I strip a VCT floor with Speedex', [], deps());
    const classification = toIntentClassification(signals);

    expect(classification.intent).toBe(signals.intent);
    expect(classification.confidence).toBe(signals.confidence);
    expect(classification.source).toBe(signals.source);
    expect(classification.usage).toEqual(signals.usage);
    expect(classification.entities).toEqual({
      betcoProduct: 'Speedex',
      competitorBrand: null,
      competitorProduct: null,
      surfaceType: 'VCT floor',
      taskDescription: 'strip and recoat a VCT floor',
      brandFamily: 'betco',
      setting: 'commercial',
      productCategory: 'floor stripper',
      carriedProduct: null,
    });
  });

  it('competitorIdentityFromSignals matches the ExtractedCompetitor contract it replaces', async () => {
    const d = deps({
      runLlm: vi.fn().mockResolvedValue({
        parsed: {
          ...LLM_SIGNALS,
          competitorBrand: 'Spartan',
          competitorProduct: 'BNC-15',
          otherCompetitorProduct: 'Virex II 256',
        },
        usage: USAGE,
      }),
    });
    const signals = await analyzeTurnSignals('betco equivalent to Spartan BNC-15', [], d);
    expect(competitorIdentityFromSignals(signals, 'betco equivalent to Spartan BNC-15')).toEqual({
      brand: 'Spartan',
      product: 'BNC-15',
      otherCompetitorProduct: 'Virex II 256',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
      resolved: true,
    });
  });

  it('competitorIdentityFromSignals falls back to the raw message with resolved=false (B0-779)', () => {
    const degraded = {
      ...fallbackTurnSignals('some message', 'llm down'),
      usage: null,
      model: null,
      resolvedProductLineKey: null,
      resolutionSource: null,
      selfReferenceVerdict: null,
    };
    const identity = competitorIdentityFromSignals(degraded, 'some message');
    expect(identity.product).toBe('some message');
    expect(identity.resolved).toBe(false);
    expect(identity.brand).toBeNull();
  });
});

describe('prompt', () => {
  it('renders the shared routing rules and the surface vocabulary rather than a second copy', () => {
    const prompt = buildSignalsInstructions();
    expect(prompt).toContain('Routing rules (apply in order):');
    expect(prompt).toContain('"terrazzo"');
    expect(prompt).toContain('regulatedSectionIntent');
    expect(prompt).toContain('answerShape');
    expect(prompt).toContain('declineClass');
  });
});
