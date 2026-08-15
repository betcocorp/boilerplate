import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  it('returns the keyword-router fallback and never calls the LLM when BEX_LLM_ROUTER_ENABLED is unset', async () => {
    delete process.env.BEX_LLM_ROUTER_ENABLED;
    const runLlm = vi.fn();

    const out = await classifyUserIntent('What do you recommend to strip and recoat a VCT floor using the floor maintenance program?', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(runLlm).not.toHaveBeenCalled();
    expect(out.source).toBe('keyword_fallback');
    expect(out.intent).toBe('floor');
    expect(intentClassificationSchema.safeParse(out).success).toBe(true);
  });

  it('falls back to the keyword router when the LLM call rejects, and never throws', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    const runLlm = vi.fn().mockRejectedValue(new Error('llm down'));

    const out = await classifyUserIntent('what is the SDS hazard rating for this cleaner', [], {
      runLlm,
      now: () => Date.now(),
    });

    expect(out.source).toBe('keyword_fallback');
    expect(out.intent).toBe('product');
  });

  it('falls back to the keyword router when the LLM call exceeds BEX_ROUTER_TIMEOUT_MS', async () => {
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
    expect(out.intent).toBe('dilution');
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

  it('caches a fallback classification too, so a down model is not re-hit within the TTL', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    const runLlm = vi.fn().mockRejectedValue(new Error('llm down'));

    await classifyUserIntent('a message', [], { runLlm, now: () => Date.now() });
    await classifyUserIntent('a message', [], { runLlm, now: () => Date.now() });

    expect(runLlm).toHaveBeenCalledOnce();
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

  it('isLlmRouterEnabled defaults to false and requires the literal string "true"', () => {
    delete process.env.BEX_LLM_ROUTER_ENABLED;
    expect(isLlmRouterEnabled()).toBe(false);

    process.env.BEX_LLM_ROUTER_ENABLED = 'yes';
    expect(isLlmRouterEnabled()).toBe(false);

    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    expect(isLlmRouterEnabled()).toBe(true);
  });

  it('isLlmRouterShadowMode defaults to true and is disabled only by the literal string "false"', () => {
    delete process.env.BEX_LLM_ROUTER_SHADOW_MODE;
    expect(isLlmRouterShadowMode()).toBe(true);

    process.env.BEX_LLM_ROUTER_SHADOW_MODE = 'false';
    expect(isLlmRouterShadowMode()).toBe(false);

    process.env.BEX_LLM_ROUTER_SHADOW_MODE = 'true';
    expect(isLlmRouterShadowMode()).toBe(true);
  });
});
