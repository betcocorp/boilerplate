import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-515 — a controllable model call, used only by the "context carry" and B0-908 describe blocks
 * below to exercise the REAL `defaultRunLlm` (i.e. calling `classifyUserIntent` with its default
 * deps, not an injected `runLlm`) and inspect exactly what gets sent to the model. Every other
 * describe block in this file injects its own `runLlm` and never touches this mock.
 *
 * B0-908 — the seam is `completeStructuredWithUsage` (`~/lib/llm/structured-completion`), which
 * routes on the resolved model id, not `client.responses.create`; the classifier itself never
 * touches a provider SDK any more.
 */
const completeStructuredMock = vi.fn();
vi.mock('~/lib/llm/structured-completion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/llm/structured-completion')>();
  return {
    ...actual,
    completeStructuredWithUsage: (...args: unknown[]) => completeStructuredMock(...args),
  };
});

// B0-638 — BEX_LLM_ROUTER_ENABLED/BEX_LLM_ROUTER_SHADOW_MODE moved to the `settings` table.
// Default mock just echoes back each call's own `fallback` arg, so every existing test that
// relied on the old "true"/"false" env-var defaults keeps working unchanged; tests that need a
// non-default value override with `mockResolvedValueOnce`/`mockImplementationOnce` below.
// B0-786 — BEX_ROUTER_MODEL/BEX_ROUTER_TIMEOUT_MS moved to the table too; same echo-the-fallback
// default so every test that never cared about them keeps the documented defaults.
// B0-903 — `resolveModel` reads BEX_LLM_PROVIDER for the `preview` tag; default `openai`.
vi.mock('~/lib/settings/settings-service', () => ({
  getBooleanSetting: vi.fn((_key: string, fallback: boolean) => Promise.resolve(fallback)),
  getStringSetting: vi.fn((_key: string, fallback: string) => Promise.resolve(fallback)),
  getNumberSetting: vi.fn((_key: string, fallback: number) => Promise.resolve(fallback)),
  getLlmProvider: vi.fn(() => Promise.resolve('openai')),
}));

// B0-903 — the real resolver, wrapped so tests can assert the router goes THROUGH it (rather than
// straight to `resolveResponsesModel`) without changing what it returns.
vi.mock('~/lib/llm/resolve-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/llm/resolve-model')>();
  return { ...actual, resolveModel: vi.fn(actual.resolveModel) };
});

import { resolveModel } from '~/lib/llm/resolve-model';
import {
  getBooleanSetting,
  getLlmProvider,
  getNumberSetting,
  getStringSetting,
} from '~/lib/settings/settings-service';
import {
  applyFloorSurfaceRoutingOverride,
  classifyUserIntent,
  computeIntentClassifierCacheKey,
  DEFAULT_BEX_ROUTER_MODEL_TAG,
  DEFAULT_BEX_ROUTER_TIMEOUT_MS,
  getIntentClassifierCacheStats,
  INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS,
  intentClassificationSchema,
  isLlmRouterEnabled,
  isLlmRouterShadowMode,
  resetIntentClassifierCache,
  resolveRouterModel,
  resolveRouterModelTag,
  resolveRouterTimeoutMs,
  type PriorTurnMessage,
} from '~/lib/orchestrator/intent-classifier';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetIntentClassifierCache();
  completeStructuredMock.mockReset();
  vi.mocked(getBooleanSetting).mockImplementation((_key, fallback) => Promise.resolve(fallback));
  vi.mocked(getStringSetting).mockImplementation((_key, fallback) => Promise.resolve(fallback));
  vi.mocked(getNumberSetting).mockImplementation((_key, fallback) => Promise.resolve(fallback));
  vi.mocked(getLlmProvider).mockResolvedValue('openai');
  vi.mocked(resolveModel).mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetIntentClassifierCache();
});

const llmResult = {
  intent: 'floor_vct' as const,
  confidence: 0.9,
  entities: {
    betcoProduct: null,
    competitorBrand: null,
    competitorProduct: null,
    surfaceType: 'VCT floor',
    taskDescription: 'strip and recoat a VCT floor',
    brandFamily: null,
    setting: null,
    productCategory: null,
    carriedProduct: null,
  },
  suggestedTool: 'search_product_docs' as const,
};

const USAGE = { promptTokens: 210, completionTokens: 24, totalTokens: 234, cachedPromptTokens: 0 };

describe('classifyUserIntent — B0-504 fallback behavior', () => {
  it('never calls the LLM and degrades to the ambiguous fallback when BEX_LLM_ROUTER_ENABLED is explicitly false (kill-switch)', async () => {
    vi.mocked(getBooleanSetting).mockResolvedValueOnce(false);
    const runLlm = vi.fn();

    const out = await classifyUserIntent('What do you recommend to strip and recoat a VCT floor using the floor maintenance program?', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(runLlm).not.toHaveBeenCalled();
    expect(out.source).toBe('keyword_fallback');
    // B0-511 hardening: the fallback no longer consults the keyword router — degraded turns run
    // the generalist ambiguous fallthrough instead of a keyword guess.
    expect(out.intent).toBe('ambiguous');
    expect(out.fallbackReason).toBe('llm_router_disabled');
    expect(intentClassificationSchema.safeParse(out).success).toBe(true);
  });

  it('is enabled by default: an unset BEX_LLM_ROUTER_ENABLED calls the LLM', async () => {
    const runLlm = vi.fn().mockResolvedValue({ parsed: llmResult, usage: USAGE });

    const out = await classifyUserIntent('strip and recoat this VCT floor', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(runLlm).toHaveBeenCalledOnce();
    expect(out.source).toBe('llm');
    expect(out.intent).toBe('floor_vct');
    // B0-563 — the live call's usage is attributed, tagged with the model that made it.
    expect(out.usage).toEqual(USAGE);
    expect(out.model).toBe(await resolveRouterModel());
  });

  it('degrades to the ambiguous fallback when the LLM call rejects, and never throws', async () => {
    const runLlm = vi.fn().mockRejectedValue(new Error('llm down'));

    const out = await classifyUserIntent('what is the SDS hazard rating for this cleaner', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(out.source).toBe('keyword_fallback');
    expect(out.intent).toBe('ambiguous');
    expect(out.fallbackReason).toBe('llm down');
  });

  it('degrades to the ambiguous fallback when the LLM call exceeds BEX_ROUTER_TIMEOUT_MS', async () => {
    // B0-786 — the ceiling is a `settings` row now, not an env var.
    vi.mocked(getNumberSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_TIMEOUT_MS' ? 10 : fallback),
    );
    const runLlm = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ parsed: llmResult, usage: USAGE }), 100);
        }),
    );

    const out = await classifyUserIntent('calibrate the dispenser tip chart', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(out.source).toBe('keyword_fallback');
    expect(out.intent).toBe('ambiguous');
    expect(out.fallbackReason).toContain('router timeout');
  });

  it('returns the LLM classification, clamped and tagged, when it resolves in time', async () => {
    const runLlm = vi.fn().mockResolvedValue({ parsed: { ...llmResult, confidence: 1.4 }, usage: USAGE });

    const out = await classifyUserIntent('strip and recoat this VCT floor', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(out.source).toBe('llm');
    expect(out.intent).toBe('floor_vct');
    expect(out.confidence).toBe(1);
    expect(out.entities.surfaceType).toBe('VCT floor');
  });

  it('caches a successful classification: an identical (message, priorMessages) call does not re-invoke the LLM', async () => {
    const runLlm = vi.fn().mockResolvedValue({ parsed: llmResult, usage: USAGE });
    const priorMessages: PriorTurnMessage[] = [
      { id: 'm1', role: 'user', content: 'hi' },
    ];

    const first = await classifyUserIntent('strip and recoat this VCT floor', priorMessages, {
      runLlm,
      now: () => Date.now(),
    });
    const second = await classifyUserIntent('strip and recoat this VCT floor', priorMessages, {
      runLlm,
      now: () => Date.now(),
    });

    expect(runLlm).toHaveBeenCalledOnce();
    // B0-563 — a cache HIT makes no model call, so its usage must not re-attribute the original
    // call's tokens to this second, free turn; everything else about the cached decision matches.
    expect(first.usage).toEqual(USAGE);
    expect(second).toEqual({ ...first, usage: null });
    expect(getIntentClassifierCacheStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('does NOT cache a failed classification: the next identical call retries the LLM (B0-511 — a cached transient timeout would poison live routing for the TTL)', async () => {
    const runLlm = vi
      .fn()
      .mockRejectedValueOnce(new Error('llm down'))
      .mockResolvedValueOnce({ parsed: llmResult, usage: USAGE });

    const first = await classifyUserIntent('a message', [], { runLlm, now: () => Date.now() });
    const second = await classifyUserIntent('a message', [], { runLlm, now: () => Date.now() });

    expect(runLlm).toHaveBeenCalledTimes(2);
    expect(first.source).toBe('keyword_fallback');
    expect(first.fallbackReason).toBe('llm down');
    expect(second.source).toBe('llm');
    expect(second.fallbackReason).toBeNull();
  });

  it('does not throw even when the LLM dep itself throws synchronously', async () => {
    const runLlm = vi.fn(() => {
      throw new Error('sync boom');
    });

    await expect(
      classifyUserIntent('a message', [], { runLlm, now: () => Date.now() }),
    ).resolves.toMatchObject({ source: 'keyword_fallback' });
  });
});

describe('computeIntentClassifierCacheKey', () => {
  it('is stable for identical inputs and differs when prior-turn ids differ', () => {
    const a = computeIntentClassifierCacheKey('hello', [{ id: '1', role: 'user', content: 'x' }]);
    const b = computeIntentClassifierCacheKey('hello', [{ id: '1', role: 'user', content: 'x' }]);
    const c = computeIntentClassifierCacheKey('hello', [{ id: '2', role: 'user', content: 'x' }]);

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('does not collide across a message/id-list boundary shift', () => {
    const a = computeIntentClassifierCacheKey('ab', [{ id: 'c', role: 'user', content: 'x' }]);
    const b = computeIntentClassifierCacheKey('a', [{ id: 'bc', role: 'user', content: 'x' }]);

    expect(a).not.toBe(b);
  });

  it('B0-671 — differs by model, so an explicit override never reads back another model\'s cached classification', () => {
    const a = computeIntentClassifierCacheKey('hello', [], 'gpt-4.1');
    const b = computeIntentClassifierCacheKey('hello', [], 'gpt-5.5');
    const omitted = computeIntentClassifierCacheKey('hello', []);

    expect(a).not.toBe(b);
    expect(a).not.toBe(omitted);
    expect(b).not.toBe(omitted);
  });

  it('B0-671 — is stable when model is omitted (matches pre-existing callers)', () => {
    expect(computeIntentClassifierCacheKey('hello', [])).toBe(
      computeIntentClassifierCacheKey('hello', []),
    );
  });
});

describe('classifyUserIntent — B0-671 model override', () => {
  it('passes the override through to runLlm and stamps it on the result, leaving resolveRouterModel untouched', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_MODEL' ? 'gpt-4o' : fallback),
    );
    const runLlm = vi.fn().mockResolvedValue({ parsed: llmResult, usage: USAGE });

    const out = await classifyUserIntent(
      'strip and recoat this VCT floor',
      [],
      { runLlm, now: () => Date.now() },
      'gpt-4.1',
    );

    expect(runLlm).toHaveBeenCalledWith(
      'strip and recoat this VCT floor',
      [],
      expect.anything(),
      'gpt-4.1',
    );
    expect(out.model).toBe('gpt-4.1');
    expect(out.model).not.toBe(await resolveRouterModel());
  });

  it('falls back to resolveRouterModel() when the override is omitted — every existing caller is unaffected', async () => {
    const runLlm = vi.fn().mockResolvedValue({ parsed: llmResult, usage: USAGE });

    const out = await classifyUserIntent('strip and recoat this VCT floor', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(runLlm).toHaveBeenCalledWith(
      'strip and recoat this VCT floor',
      [],
      expect.anything(),
      undefined,
    );
    expect(out.model).toBe(await resolveRouterModel());
  });

  it('a call with a model override does not read back a classification cached under a different (or no) model for the same message', async () => {
    const runLlm = vi.fn().mockResolvedValue({ parsed: llmResult, usage: USAGE });

    const withoutOverride = await classifyUserIntent('a shared message', [], {
      runLlm,
      now: () => Date.now(),
    });
    const withOverride = await classifyUserIntent(
      'a shared message',
      [],
      { runLlm, now: () => Date.now() },
      'gpt-4.1',
    );

    expect(runLlm).toHaveBeenCalledTimes(2);
    expect(withoutOverride.model).toBe(await resolveRouterModel());
    expect(withOverride.model).toBe('gpt-4.1');
  });
});

describe('B0-786 settings-table resolution', () => {
  it('resolveRouterModelTag defaults to gpt-4.1 and honors a valid `settings` tag', async () => {
    expect(await resolveRouterModelTag()).toBe(DEFAULT_BEX_ROUTER_MODEL_TAG);

    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_MODEL' ? 'gpt-4.1-mini' : fallback),
    );
    expect(await resolveRouterModelTag()).toBe('gpt-4.1-mini');
  });

  it('rejects a stored value that is not a BEX_MODEL_TAGS tag (allowed_values is advisory, not a constraint)', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_MODEL' ? 'gpt-4o-mini' : fallback),
    );
    expect(await resolveRouterModelTag()).toBe(DEFAULT_BEX_ROUTER_MODEL_TAG);
  });

  it('resolveRouterModel resolves the tag to a concrete model id, never the raw tag string', async () => {
    // B0-757 — BEX_RESPONSES_MODEL (what the router's `preview` tag falls through to) is a settings
    // row too, resolved through the same mocked getStringSetting rather than process.env. B0-831
    // made that row a BEX_MODEL_TAGS tag, so the fixture stores a tag, not a raw model id.
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(
        key === 'BEX_ROUTER_MODEL'
          ? 'preview'
          : key === 'BEX_RESPONSES_MODEL'
            ? 'gpt-4o'
            : fallback,
      ),
    );
    expect(await resolveRouterModel()).toBe('gpt-4o');
  });

  it('resolveRouterTimeoutMs defaults and rejects a non-positive stored value', async () => {
    expect(await resolveRouterTimeoutMs()).toBe(DEFAULT_BEX_ROUTER_TIMEOUT_MS);

    vi.mocked(getNumberSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_TIMEOUT_MS' ? 500 : fallback),
    );
    expect(await resolveRouterTimeoutMs()).toBe(500);

    vi.mocked(getNumberSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_TIMEOUT_MS' ? -5 : fallback),
    );
    expect(await resolveRouterTimeoutMs()).toBe(DEFAULT_BEX_ROUTER_TIMEOUT_MS);
  });

  it('isLlmRouterEnabled defaults to true (B0-511 cutover) and reads the `settings` row otherwise', async () => {
    expect(await isLlmRouterEnabled()).toBe(true);

    vi.mocked(getBooleanSetting).mockResolvedValueOnce(false);
    expect(await isLlmRouterEnabled()).toBe(false);
  });

  it('isLlmRouterShadowMode defaults to false (B0-511 cutover) and reads the `settings` row otherwise', async () => {
    expect(await isLlmRouterShadowMode()).toBe(false);

    vi.mocked(getBooleanSetting).mockResolvedValueOnce(true);
    expect(await isLlmRouterShadowMode()).toBe(true);
  });
});

describe('classifyUserIntent — B0-515 entity extraction', () => {
  it('passes through every extracted entity field from a realistic cross_reference-style message', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: {
        intent: 'cross_reference' as const,
        confidence: 0.82,
        entities: {
          betcoProduct: 'Betco Green Earth NABC',
          competitorBrand: 'Diversey',
          competitorProduct: 'Virex II 256',
          surfaceType: 'stainless steel prep table',
          taskDescription: 'find the Betco equivalent to disinfect a prep table',
          brandFamily: null,
          setting: null,
          productCategory: null,
          carriedProduct: null,
        },
        suggestedTool: 'lookup_cross_reference' as const,
      },
      usage: USAGE,
    });

    const out = await classifyUserIntent(
      'We currently use Diversey Virex II 256 on our stainless steel prep tables — what is the Betco equivalent?',
      [],
      { runLlm, now: () => Date.now() },
    );

    expect(intentClassificationSchema.safeParse(out).success).toBe(true);
    // Every field, not just the one or two other tests in this file happen to touch.
    expect(out.entities).toEqual({
      betcoProduct: 'Betco Green Earth NABC',
      competitorBrand: 'Diversey',
      competitorProduct: 'Virex II 256',
      surfaceType: 'stainless steel prep table',
      taskDescription: 'find the Betco equivalent to disinfect a prep table',
      brandFamily: null,
      setting: null,
      productCategory: null,
      carriedProduct: null,
    });
    expect(out.suggestedTool).toBe('lookup_cross_reference');
  });

  /**
   * B0-758 — the scope signals survive parsing, including the two closed enums. `brandFamily` and
   * `setting` are `z.enum(...)`, so an unlisted value would fail the parse rather than pass through
   * — that is deliberate, and this test pins the accepted spellings.
   */
  it('parses the B0-758 scope, category and carry-over signals', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: {
        intent: 'floor_vct' as const,
        confidence: 0.71,
        entities: {
          betcoProduct: null,
          competitorBrand: null,
          competitorProduct: null,
          surfaceType: 'hardwood',
          taskDescription: 'refinish a hardwood floor at home',
          brandFamily: 'basic_coatings' as const,
          setting: 'residential' as const,
          productCategory: 'wood floor finish',
          carriedProduct: 'Street Shine',
        },
        suggestedTool: 'search_product_docs' as const,
      },
      usage: USAGE,
    });

    const out = await classifyUserIntent('what about at home?', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(intentClassificationSchema.safeParse(out).success).toBe(true);
    expect(out.entities.brandFamily).toBe('basic_coatings');
    expect(out.entities.setting).toBe('residential');
    expect(out.entities.productCategory).toBe('wood floor finish');
    expect(out.entities.carriedProduct).toBe('Street Shine');
  });

  it('rejects a brandFamily outside the four Betco brands plus competitor', () => {
    // Guards the org rule: no invented sub-brands may enter the pipeline through this field.
    const withInventedBrand = {
      intent: 'product' as const,
      confidence: 0.6,
      entities: {
        betcoProduct: null,
        competitorBrand: null,
        competitorProduct: null,
        surfaceType: null,
        taskDescription: null,
        brandFamily: 'betco_pro',
        setting: null,
        productCategory: null,
        carriedProduct: null,
      },
      suggestedTool: null,
      source: 'llm' as const,
      fallbackReason: null,
      usage: null,
      model: null,
    };

    expect(intentClassificationSchema.safeParse(withInventedBrand).success).toBe(false);
  });

  it('leaves every entity field null when the model extracted nothing, rather than defaulting any of them', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: {
        intent: 'ambiguous' as const,
        confidence: 0.2,
        entities: {
          betcoProduct: null,
          competitorBrand: null,
          competitorProduct: null,
          surfaceType: null,
          taskDescription: null,
          brandFamily: null,
          setting: null,
          productCategory: null,
          carriedProduct: null,
        },
        suggestedTool: null,
      },
      usage: USAGE,
    });

    const out = await classifyUserIntent('hello', [], { runLlm, now: () => Date.now() });

    expect(out.entities).toEqual({
      betcoProduct: null,
      competitorBrand: null,
      competitorProduct: null,
      surfaceType: null,
      taskDescription: null,
      brandFamily: null,
      setting: null,
      productCategory: null,
      carriedProduct: null,
    });
    expect(out.suggestedTool).toBeNull();
  });
});

/** The request object `defaultRunLlm` hands to `completeStructuredWithUsage`. */
type StructuredRequest = {
  model: string;
  system: string;
  user: string;
  priorMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  temperature?: number;
  requestOptions?: { maxRetries?: number; timeoutMs?: number; signal?: AbortSignal };
};

function structuredCall(index = 0): StructuredRequest {
  return completeStructuredMock.mock.calls[index]?.[0] as StructuredRequest;
}

/**
 * B0-515 — conversational context carry. The tests above always inject their own `runLlm`, which
 * proves `priorMessages` reaches the DEPS INTERFACE but never proves the real implementation
 * (`defaultRunLlm`) actually forwards prior turns to the model, or how it shapes them. These tests
 * call `classifyUserIntent` with its default deps and inspect the real request built by
 * `defaultRunLlm`.
 *
 * B0-908 — prior turns travel as the helper's `priorMessages` (`{ role, content }`), which the
 * helper emits as `{ role, content, type: 'message' }` Responses `input` items ahead of `user` —
 * the same bytes the classifier's own `client.responses.create` call sent before.
 */
describe('classifyUserIntent — B0-515 conversational context carry (default deps)', () => {
  beforeEach(() => {
    completeStructuredMock.mockResolvedValue({ text: JSON.stringify(llmResult), usage: USAGE });
  });

  it('replays prior turns to the model, oldest-first, with the current message as `user`', async () => {
    const priorMessages: PriorTurnMessage[] = [
      { id: 'm1', role: 'user', content: 'What do you recommend for a locker room floor?' },
      { id: 'm2', role: 'assistant', content: 'A neutral disinfectant cleaner works well there.' },
    ];

    await classifyUserIntent('And what about the shower stalls specifically?', priorMessages);

    expect(completeStructuredMock).toHaveBeenCalledTimes(1);
    const call = structuredCall();
    expect(call.priorMessages).toEqual([
      { role: 'user', content: 'What do you recommend for a locker room floor?' },
      { role: 'assistant', content: 'A neutral disinfectant cleaner works well there.' },
    ]);
    expect(call.user).toBe('And what about the shower stalls specifically?');
  });

  it('sends only the current message when no prior turns are supplied', async () => {
    await classifyUserIntent('What is the dilution ratio for Fight Bac RTU?', []);

    const call = structuredCall();
    expect(call.priorMessages).toEqual([]);
    expect(call.user).toBe('What is the dilution ratio for Fight Bac RTU?');
  });

  it('caps replayed history to the most recent 8 prior turns (MAX_PRIOR_MESSAGES)', async () => {
    const priorMessages: PriorTurnMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i}`,
    }));

    await classifyUserIntent('current turn', priorMessages);

    const call = structuredCall();
    // The two oldest ("turn 0", "turn 1") are dropped, proving this is a genuine cap and not an
    // accidental no-op; roles survive the mapping.
    expect(call.priorMessages).toHaveLength(8);
    expect(call.priorMessages?.map((m) => m.content)).toEqual([
      'turn 2',
      'turn 3',
      'turn 4',
      'turn 5',
      'turn 6',
      'turn 7',
      'turn 8',
      'turn 9',
    ]);
    expect(call.priorMessages?.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(call.user).toBe('current turn');
  });

  it('filters out blank/whitespace-only prior turns before replaying them', async () => {
    const priorMessages: PriorTurnMessage[] = [
      { id: 'm1', role: 'user', content: 'a real question' },
      { id: 'm2', role: 'assistant', content: '   ' },
      { id: 'm3', role: 'user', content: '' },
    ];

    await classifyUserIntent('the current question', priorMessages);

    const call = structuredCall();
    expect(call.priorMessages).toEqual([{ role: 'user', content: 'a real question' }]);
    expect(call.user).toBe('the current question');
  });

  it('changes what the model receives when priorMessages changes, for an otherwise identical current message', async () => {
    await classifyUserIntent('follow-up question', [
      { id: 'a', role: 'user', content: 'context A' },
    ]);
    await classifyUserIntent('follow-up question', [
      { id: 'b', role: 'user', content: 'context B' },
    ]);

    // Same current message, different prior turn — the payload sent to the model differs, which
    // is the mechanism by which a follow-up question actually inherits earlier context.
    expect(structuredCall(0).user).toBe(structuredCall(1).user);
    expect(structuredCall(0).priorMessages).not.toEqual(structuredCall(1).priorMessages);
  });
});

/**
 * B0-908 — the classifier is provider-neutral: it hands `completeStructuredWithUsage` the resolved
 * model id and the helper decides which API to call. What the classifier owns is that the SAME
 * system prompt, schema, cap and transport knobs go out regardless of provider.
 */
describe('classifyUserIntent — B0-908 provider-neutral call (default deps)', () => {
  beforeEach(() => {
    completeStructuredMock.mockResolvedValue({ text: JSON.stringify(llmResult), usage: USAGE });
  });

  it('calls the helper with the resolved claude-sonnet-5 id when BEX_ROUTER_MODEL holds that tag', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_MODEL' ? 'claude-sonnet-5' : fallback),
    );

    const out = await classifyUserIntent('strip and recoat this VCT floor', []);

    expect(completeStructuredMock).toHaveBeenCalledTimes(1);
    const call = structuredCall();
    // An Anthropic tag IS the model id (`resolveResponsesModel` passes it through), so the helper's
    // `modelProviderFor` sees `claude-sonnet-5` and takes the Anthropic Messages path.
    expect(call.model).toBe('claude-sonnet-5');
    expect(out.source).toBe('llm');
    expect(out.model).toBe('claude-sonnet-5');
    expect(out.usage).toEqual(USAGE);
  });

  it('sends the same prompt bytes, strict schema, cap and transport options for every provider', async () => {
    await classifyUserIntent('strip and recoat this VCT floor', []);
    const openai = structuredCall(0);

    resetIntentClassifierCache();
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_MODEL' ? 'claude-sonnet-5' : fallback),
    );
    await classifyUserIntent('strip and recoat this VCT floor', []);
    const anthropic = structuredCall(1);

    expect(openai.model).toBe('gpt-4.1');
    expect(anthropic.model).toBe('claude-sonnet-5');
    for (const call of [openai, anthropic]) {
      expect(call.system).toContain('Routing rules (apply in order):');
      expect(call.schemaName).toBe('intent_classification');
      expect(call.schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(call.maxOutputTokens).toBe(INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS);
      expect(call.temperature).toBe(0);
      expect(call.requestOptions).toMatchObject({ maxRetries: 0, timeoutMs: DEFAULT_BEX_ROUTER_TIMEOUT_MS });
      expect(call.requestOptions?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(openai.system).toBe(anthropic.system);
    expect(openai.user).toBe(anthropic.user);
    expect(openai.priorMessages).toEqual(anthropic.priorMessages);
    expect(openai.schema).toEqual(anthropic.schema);
  });

  it("forwards withRouterTimeout's abort signal, so a raced-out request is cancelled at the SDK", async () => {
    vi.mocked(getNumberSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_TIMEOUT_MS' ? 10 : fallback),
    );
    let seen: AbortSignal | undefined;
    completeStructuredMock.mockImplementation(
      (request: StructuredRequest) =>
        new Promise((resolve) => {
          seen = request.requestOptions?.signal;
          setTimeout(() => resolve({ text: JSON.stringify(llmResult), usage: USAGE }), 100);
        }),
    );

    const out = await classifyUserIntent('calibrate the dispenser tip chart', []);

    expect(out.source).toBe('keyword_fallback');
    expect(out.fallbackReason).toContain('router timeout');
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(true);
  });

  it('routes a truncated structured answer to the keyword fallback, like any unparseable payload', async () => {
    const { StructuredOutputTruncatedError } = await import('~/lib/llm/structured-completion');
    completeStructuredMock.mockRejectedValue(new StructuredOutputTruncatedError());

    const out = await classifyUserIntent('what is the SDS hazard rating for this cleaner', []);

    expect(out.source).toBe('keyword_fallback');
    expect(out.intent).toBe('ambiguous');
    expect(out.fallbackReason).toContain('max_output_tokens');
  });

  it('B0-903 — resolves the BEX_ROUTER_MODEL tag through resolveModel, and the claude tag from the row reaches the seam', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'BEX_ROUTER_MODEL' ? 'claude-haiku-4-5' : fallback),
    );

    const out = await classifyUserIntent('how do I set up the dispenser', []);

    expect(resolveModel).toHaveBeenCalledWith('claude-haiku-4-5');
    expect(structuredCall().model).toBe('claude-haiku-4-5');
    expect(out.model).toBe('claude-haiku-4-5');
  });

  it('B0-903 — a `preview` router tag follows the BEX_LLM_PROVIDER per-vendor default row', async () => {
    vi.mocked(getStringSetting).mockImplementation((key, fallback) => {
      if (key === 'BEX_ROUTER_MODEL') return Promise.resolve('preview');
      if (key === 'BEX_ANTHROPIC_MODEL') return Promise.resolve('claude-opus-5');
      return Promise.resolve(fallback);
    });
    vi.mocked(getLlmProvider).mockResolvedValue('anthropic');

    await classifyUserIntent('how do I set up the dispenser', []);

    expect(resolveModel).toHaveBeenCalledWith('preview');
    expect(structuredCall().model).toBe('claude-opus-5');
  });
});

/**
 * B0-1034 — the VCT product-selection misroute. In golden run 844f8eb3 row 17 ("What stripping and
 * finish products should I use for my VCT floor?") the LLM router returned `recommendations` at
 * confidence 0.85 while extracting `surfaceType: "vct"`, and that verdict was the routing decision
 * (`keyword_route` was `product`, `semantic_route` was `ambiguous`), so the turn ran the
 * recommendations specialist prompt instead of floor_vct's.
 *
 * B0-977 added `applyFloorSurfaceRoutingOverride` as the deterministic safety net on top of the
 * prompt rule, but shipped it with no test. These cases pin BOTH halves of its contract — it fires
 * for a substrate-named `recommendations` verdict, and it touches nothing else — so a later prompt
 * or classifier refactor cannot quietly drop the guardrail (see the AGENTS.md note on guardrails
 * removed twice as "verified equivalent").
 */
describe('applyFloorSurfaceRoutingOverride — B0-1034 / B0-977 substrate override', () => {
  it('re-routes the golden-item verdict: `recommendations` + a VCT surface → floor_vct, with a reason', () => {
    const out = applyFloorSurfaceRoutingOverride({
      intent: 'recommendations',
      surfaceType: 'vct',
    });

    expect(out.intent).toBe('floor_vct');
    expect(out.routingOverrideReason).toContain('floor_surface_override');
    expect(out.routingOverrideReason).toContain('floor_vct');
  });

  it.each([
    ['VCT floor', 'floor_vct'],
    ['terrazzo', 'floor_vct'],
    ['gym floor', 'floor_wood_sport'],
    ['concrete', 'floor_concrete'],
    ['grout', 'floor_stg'],
  ] as const)('sends a `recommendations` verdict for %j to %s', (surfaceType, expected) => {
    expect(applyFloorSurfaceRoutingOverride({ intent: 'recommendations', surfaceType }).intent).toBe(
      expected,
    );
  });

  it.each(['product', 'bathroom', 'dilution', 'cross_reference', 'floor_vct', 'ambiguous'] as const)(
    'leaves a non-`recommendations` verdict (%s) untouched even with a floor surface',
    (intent) => {
      const out = applyFloorSurfaceRoutingOverride({ intent, surfaceType: 'VCT floor' });

      expect(out.intent).toBe(intent);
      expect(out.routingOverrideReason).toBeNull();
    },
  );

  it.each([null, undefined, '', 'stainless steel', 'carpet'])(
    'leaves `recommendations` alone when surfaceType (%j) is absent or not a floor substrate',
    (surfaceType) => {
      const out = applyFloorSurfaceRoutingOverride({ intent: 'recommendations', surfaceType });

      expect(out.intent).toBe('recommendations');
      expect(out.routingOverrideReason).toBeNull();
    },
  );
});

describe('classifyUserIntent — B0-1034 VCT product-selection asks never land on `recommendations`', () => {
  /** Exactly what the model emitted for golden row 17: `recommendations` @ 0.85 with the substrate extracted. */
  const misroutedVerdict = (surfaceType: string, taskDescription: string) => ({
    intent: 'recommendations' as const,
    confidence: 0.85,
    entities: {
      betcoProduct: null,
      competitorBrand: null,
      competitorProduct: null,
      surfaceType,
      taskDescription,
      brandFamily: null,
      setting: null,
      productCategory: 'floor stripper',
      carriedProduct: null,
    },
    suggestedTool: 'search_product_docs' as const,
  });

  it.each([
    // The failing golden item itself, verbatim.
    [
      'What stripping and finish products should I use for my VCT floor?',
      'vct',
      'choose stripper and finish for a VCT floor',
    ],
    // Paraphrases of the same shape — "which of our products for <named substrate>".
    [
      'Which stripper and floor finish should we buy for our VCT hallways?',
      'VCT floor',
      'select stripper and finish for VCT hallways',
    ],
    [
      'What products do you recommend for stripping and refinishing a terrazzo lobby?',
      'terrazzo',
      'strip and refinish a terrazzo lobby',
    ],
    [
      'We need to strip and recoat vinyl composition tile — what should we use?',
      'vinyl composition tile',
      'strip and recoat vinyl composition tile',
    ],
  ])('routes %j to floor_vct', async (message, surfaceType, taskDescription) => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: misroutedVerdict(surfaceType, taskDescription),
      usage: USAGE,
    });

    const out = await classifyUserIntent(message, [], { runLlm, now: () => Date.now() });

    expect(out.intent).toBe('floor_vct');
    expect(out.source).toBe('llm');
    // The model call succeeded — an override is not a degradation, so `fallbackReason` stays null.
    expect(out.fallbackReason).toBeNull();
    expect(out.routingOverrideReason).toContain('floor_vct');
    // The override re-routes only; it must not rewrite the model's own confidence or entities.
    expect(out.confidence).toBe(0.85);
    expect(out.entities.surfaceType).toBe(surfaceType);
  });

  it('still routes a genuine substrate-free job ask to `recommendations` (no regression)', async () => {
    const runLlm = vi.fn().mockResolvedValue({
      parsed: {
        ...misroutedVerdict('', 'degrease a commercial kitchen floor'),
        entities: {
          ...misroutedVerdict('', 'degrease a commercial kitchen floor').entities,
          surfaceType: null,
          productCategory: null,
        },
      },
      usage: USAGE,
    });

    const out = await classifyUserIntent(
      'What should I use to get grease off a kitchen floor?',
      [],
      { runLlm, now: () => Date.now() },
    );

    expect(out.intent).toBe('recommendations');
    expect(out.routingOverrideReason).toBeNull();
  });

  it('keeps the schema valid after an override', async () => {
    const runLlm = vi
      .fn()
      .mockResolvedValue({ parsed: misroutedVerdict('vct', 'strip a VCT floor'), usage: USAGE });

    const out = await classifyUserIntent('what should I use on my VCT floor', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(intentClassificationSchema.parse(out).intent).toBe('floor_vct');
  });
});
