import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-515 — a controllable `client.responses.create`, used only by the "context carry" describe
 * block below to exercise the REAL `defaultRunLlm` (i.e. calling `classifyUserIntent` with its
 * default deps, not an injected `runLlm`) and inspect exactly what gets sent to the model. Every
 * other describe block in this file injects its own `runLlm` and never touches this mock.
 */
const responsesCreateMock = vi.fn();
vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({
    responses: { create: (...args: unknown[]) => responsesCreateMock(...args) },
  }),
}));

import {
  classifyUserIntent,
  computeIntentClassifierCacheKey,
  DEFAULT_BEX_ROUTER_MODEL,
  DEFAULT_BEX_ROUTER_TIMEOUT_MS,
  getIntentClassifierCacheStats,
  intentClassificationSchema,
  isLlmRouterEnabled,
  isLlmRouterShadowMode,
  resetIntentClassifierCache,
  resolveRouterModel,
  resolveRouterTimeoutMs,
  type PriorTurnMessage,
} from '~/lib/orchestrator/intent-classifier';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetIntentClassifierCache();
  responsesCreateMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetIntentClassifierCache();
});

const llmResult = {
  intent: 'floor' as const,
  confidence: 0.9,
  entities: {
    betcoProduct: null,
    competitorBrand: null,
    competitorProduct: null,
    surfaceType: 'VCT floor',
    taskDescription: 'strip and recoat a VCT floor',
  },
  suggestedTool: 'search_product_docs' as const,
};

describe('classifyUserIntent — B0-504 fallback behavior', () => {
  it('never calls the LLM and degrades to the ambiguous fallback when BEX_LLM_ROUTER_ENABLED is explicitly false (kill-switch)', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'false';
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
    delete process.env.BEX_LLM_ROUTER_ENABLED;
    const runLlm = vi.fn().mockResolvedValue(llmResult);

    const out = await classifyUserIntent('strip and recoat this VCT floor', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(runLlm).toHaveBeenCalledOnce();
    expect(out.source).toBe('llm');
    expect(out.intent).toBe('floor');
  });

  it('degrades to the ambiguous fallback when the LLM call rejects, and never throws', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
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
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    process.env.BEX_ROUTER_TIMEOUT_MS = '10';
    const runLlm = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(llmResult), 100);
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
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    const runLlm = vi.fn().mockResolvedValue({ ...llmResult, confidence: 1.4 });

    const out = await classifyUserIntent('strip and recoat this VCT floor', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(out.source).toBe('llm');
    expect(out.intent).toBe('floor');
    expect(out.confidence).toBe(1);
    expect(out.entities.surfaceType).toBe('VCT floor');
  });

  it('caches a successful classification: an identical (message, priorMessages) call does not re-invoke the LLM', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    const runLlm = vi.fn().mockResolvedValue(llmResult);
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
    expect(second).toEqual(first);
    expect(getIntentClassifierCacheStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('does NOT cache a failed classification: the next identical call retries the LLM (B0-511 — a cached transient timeout would poison live routing for the TTL)', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    const runLlm = vi
      .fn()
      .mockRejectedValueOnce(new Error('llm down'))
      .mockResolvedValueOnce(llmResult);

    const first = await classifyUserIntent('a message', [], { runLlm, now: () => Date.now() });
    const second = await classifyUserIntent('a message', [], { runLlm, now: () => Date.now() });

    expect(runLlm).toHaveBeenCalledTimes(2);
    expect(first.source).toBe('keyword_fallback');
    expect(first.fallbackReason).toBe('llm down');
    expect(second.source).toBe('llm');
    expect(second.fallbackReason).toBeNull();
  });

  it('does not throw even when the LLM dep itself throws synchronously', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
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
});

describe('B0-506 env-var resolution', () => {
  it('resolveRouterModel defaults and honors an override', () => {
    delete process.env.BEX_ROUTER_MODEL;
    expect(resolveRouterModel()).toBe(DEFAULT_BEX_ROUTER_MODEL);

    process.env.BEX_ROUTER_MODEL = 'gpt-4.1-mini';
    expect(resolveRouterModel()).toBe('gpt-4.1-mini');
  });

  it('resolveRouterTimeoutMs defaults and rejects invalid overrides', () => {
    delete process.env.BEX_ROUTER_TIMEOUT_MS;
    expect(resolveRouterTimeoutMs()).toBe(DEFAULT_BEX_ROUTER_TIMEOUT_MS);

    process.env.BEX_ROUTER_TIMEOUT_MS = '500';
    expect(resolveRouterTimeoutMs()).toBe(500);

    process.env.BEX_ROUTER_TIMEOUT_MS = '-5';
    expect(resolveRouterTimeoutMs()).toBe(DEFAULT_BEX_ROUTER_TIMEOUT_MS);

    process.env.BEX_ROUTER_TIMEOUT_MS = 'not-a-number';
    expect(resolveRouterTimeoutMs()).toBe(DEFAULT_BEX_ROUTER_TIMEOUT_MS);
  });

  it('isLlmRouterEnabled defaults to true (B0-511 cutover) and is disabled only by the literal string "false"', () => {
    delete process.env.BEX_LLM_ROUTER_ENABLED;
    expect(isLlmRouterEnabled()).toBe(true);

    process.env.BEX_LLM_ROUTER_ENABLED = 'yes';
    expect(isLlmRouterEnabled()).toBe(true);

    process.env.BEX_LLM_ROUTER_ENABLED = 'false';
    expect(isLlmRouterEnabled()).toBe(false);
  });

  it('isLlmRouterShadowMode defaults to false (B0-511 cutover) and requires the literal string "true"', () => {
    delete process.env.BEX_LLM_ROUTER_SHADOW_MODE;
    expect(isLlmRouterShadowMode()).toBe(false);

    process.env.BEX_LLM_ROUTER_SHADOW_MODE = 'false';
    expect(isLlmRouterShadowMode()).toBe(false);

    process.env.BEX_LLM_ROUTER_SHADOW_MODE = 'true';
    expect(isLlmRouterShadowMode()).toBe(true);
  });
});

describe('classifyUserIntent — B0-515 entity extraction', () => {
  it('passes through every extracted entity field from a realistic recommendations-style message', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    const runLlm = vi.fn().mockResolvedValue({
      intent: 'recommendations' as const,
      confidence: 0.82,
      entities: {
        betcoProduct: 'Betco Green Earth NABC',
        competitorBrand: 'Diversey',
        competitorProduct: 'Virex II 256',
        surfaceType: 'stainless steel prep table',
        taskDescription: 'find the Betco equivalent to disinfect a prep table',
      },
      suggestedTool: 'lookup_cross_reference' as const,
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
    });
    expect(out.suggestedTool).toBe('lookup_cross_reference');
  });

  it('leaves every entity field null when the model extracted nothing, rather than defaulting any of them', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    const runLlm = vi.fn().mockResolvedValue({
      intent: 'ambiguous' as const,
      confidence: 0.2,
      entities: {
        betcoProduct: null,
        competitorBrand: null,
        competitorProduct: null,
        surfaceType: null,
        taskDescription: null,
      },
      suggestedTool: null,
    });

    const out = await classifyUserIntent('hello', [], { runLlm, now: () => Date.now() });

    expect(out.entities).toEqual({
      betcoProduct: null,
      competitorBrand: null,
      competitorProduct: null,
      surfaceType: null,
      taskDescription: null,
    });
    expect(out.suggestedTool).toBeNull();
  });
});

/**
 * B0-515 — conversational context carry. The tests above always inject their own `runLlm`, which
 * proves `priorMessages` reaches the DEPS INTERFACE but never proves the real implementation
 * (`defaultRunLlm`) actually forwards prior turns to the model, or how it shapes them. These tests
 * call `classifyUserIntent` with its default deps and inspect the real `client.responses.create`
 * payload built by `defaultRunLlm`.
 */
describe('classifyUserIntent — B0-515 conversational context carry (default deps)', () => {
  beforeEach(() => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    responsesCreateMock.mockResolvedValue({
      output_text: JSON.stringify(llmResult),
    });
  });

  it('replays prior turns to the model, oldest-first, ending with the current message', async () => {
    const priorMessages: PriorTurnMessage[] = [
      { id: 'm1', role: 'user', content: 'What do you recommend for a locker room floor?' },
      { id: 'm2', role: 'assistant', content: 'A neutral disinfectant cleaner works well there.' },
    ];

    await classifyUserIntent('And what about the shower stalls specifically?', priorMessages);

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    const call = responsesCreateMock.mock.calls[0]?.[0] as { input: unknown[] };
    expect(call.input).toEqual([
      { role: 'user', content: 'What do you recommend for a locker room floor?', type: 'message' },
      {
        role: 'assistant',
        content: 'A neutral disinfectant cleaner works well there.',
        type: 'message',
      },
      { role: 'user', content: 'And what about the shower stalls specifically?', type: 'message' },
    ]);
  });

  it('sends only the current message when no prior turns are supplied', async () => {
    await classifyUserIntent('What is the dilution ratio for Fight Bac RTU?', []);

    const call = responsesCreateMock.mock.calls[0]?.[0] as { input: unknown[] };
    expect(call.input).toEqual([
      { role: 'user', content: 'What is the dilution ratio for Fight Bac RTU?', type: 'message' },
    ]);
  });

  it('caps replayed history to the most recent 8 prior turns (MAX_PRIOR_MESSAGES)', async () => {
    const priorMessages: PriorTurnMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i}`,
    }));

    await classifyUserIntent('current turn', priorMessages);

    const call = responsesCreateMock.mock.calls[0]?.[0] as { input: Array<{ content: string }> };
    // 8 capped prior turns + the current message = 9. The two oldest ("turn 0", "turn 1") are
    // dropped, proving this is a genuine cap and not an accidental no-op.
    expect(call.input).toHaveLength(9);
    expect(call.input.map((m) => m.content)).toEqual([
      'turn 2',
      'turn 3',
      'turn 4',
      'turn 5',
      'turn 6',
      'turn 7',
      'turn 8',
      'turn 9',
      'current turn',
    ]);
  });

  it('filters out blank/whitespace-only prior turns before replaying them', async () => {
    const priorMessages: PriorTurnMessage[] = [
      { id: 'm1', role: 'user', content: 'a real question' },
      { id: 'm2', role: 'assistant', content: '   ' },
      { id: 'm3', role: 'user', content: '' },
    ];

    await classifyUserIntent('the current question', priorMessages);

    const call = responsesCreateMock.mock.calls[0]?.[0] as { input: Array<{ content: string }> };
    expect(call.input.map((m) => m.content)).toEqual(['a real question', 'the current question']);
  });

  it('changes what the model receives when priorMessages changes, for an otherwise identical current message', async () => {
    await classifyUserIntent('follow-up question', [
      { id: 'a', role: 'user', content: 'context A' },
    ]);
    const firstCallInput = responsesCreateMock.mock.calls[0]?.[0] as { input: unknown[] };

    await classifyUserIntent('follow-up question', [
      { id: 'b', role: 'user', content: 'context B' },
    ]);
    const secondCallInput = responsesCreateMock.mock.calls[1]?.[0] as { input: unknown[] };

    // Same current message, different prior turn — the payload sent to the model differs, which
    // is the mechanism by which a follow-up question actually inherits earlier context.
    expect(firstCallInput.input).not.toEqual(secondCallInput.input);
  });
});
