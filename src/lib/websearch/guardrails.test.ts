import { describe, expect, it } from 'vitest';

import {
  WebSearchGuardrails,
  assertNoSecretInUrl,
  loadGuardrailPolicyFromEnv,
} from '~/lib/websearch/guardrails';
import { WebSearchError } from '~/lib/websearch/types';

describe('WebSearchGuardrails', () => {
  it('allows requests under the rate limit and rejects the one that exceeds it', () => {
    const g = new WebSearchGuardrails({
      maxRequestsPerWindow: 2,
      windowMs: 60_000,
      costBudgetUsdPerWindow: 999,
    });
    g.reserve(0, 1000);
    g.reserve(0, 1000);
    expect(() => g.reserve(0, 1000)).toThrowError(WebSearchError);
    expect(() => g.reserve(0, 1000)).toThrow(/rate limit/i);
  });

  it('rejects a request that would exceed the cost budget', () => {
    const g = new WebSearchGuardrails({
      maxRequestsPerWindow: 100,
      windowMs: 60_000,
      costBudgetUsdPerWindow: 0.02,
    });
    g.reserve(0.016, 1000);
    expect(() => g.reserve(0.016, 1000)).toThrow(/cost budget/i);
  });

  it('rolls the window forward so old hits stop counting', () => {
    const g = new WebSearchGuardrails({
      maxRequestsPerWindow: 1,
      windowMs: 1_000,
      costBudgetUsdPerWindow: 999,
    });
    g.reserve(0, 1000);
    expect(() => g.reserve(0, 1500)).toThrow(); // still in window
    g.reserve(0, 2500); // 1500ms later → old hit expired
    expect(g.snapshot(2500).requests).toBe(1);
  });
});

describe('assertNoSecretInUrl', () => {
  it('passes a clean URL and throws when the secret is embedded', () => {
    expect(assertNoSecretInUrl('https://api.tavily.com/search', 'tvly-secret-123')).toContain(
      'tavily',
    );
    expect(() =>
      assertNoSecretInUrl('https://x.test/?key=tvly-secret-123', 'tvly-secret-123'),
    ).toThrow(WebSearchError);
  });
});

describe('loadGuardrailPolicyFromEnv', () => {
  it('uses defaults and honors positive overrides', () => {
    expect(loadGuardrailPolicyFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      maxRequestsPerWindow: 30,
      windowMs: 60_000,
      costBudgetUsdPerWindow: 1,
    });
    expect(
      loadGuardrailPolicyFromEnv({ WEBSEARCH_RATE_LIMIT: '5' } as NodeJS.ProcessEnv)
        .maxRequestsPerWindow,
    ).toBe(5);
  });
});
