import { WebSearchError } from '~/lib/websearch/types';

/**
 * WEB-5 — Guardrails, cost controls & observability.
 *
 * A rolling-window rate limit + cost budget for external searches, plus a helper to keep secrets
 * out of outbound URLs. Provenance/observability (provider, cost, result count) is emitted via the
 * audit log at the call site; this module enforces the hard limits before a provider is billed.
 */

export type GuardrailPolicy = {
  maxRequestsPerWindow: number;
  windowMs: number;
  costBudgetUsdPerWindow: number;
};

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadGuardrailPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GuardrailPolicy {
  return {
    maxRequestsPerWindow: positiveNumber(env.WEBSEARCH_RATE_LIMIT, 30),
    windowMs: positiveNumber(env.WEBSEARCH_RATE_WINDOW_MS, 60_000),
    costBudgetUsdPerWindow: positiveNumber(env.WEBSEARCH_COST_BUDGET_USD, 1),
  };
}

/**
 * In-memory rolling-window limiter. Process-local (like the response cache); a durable/shared
 * limiter would move this to Redis/Postgres, but this bounds runaway spend within an instance.
 */
export class WebSearchGuardrails {
  private hits: { at: number; cost: number }[] = [];

  constructor(private readonly policy: GuardrailPolicy) {}

  /** Reserve a slot for a request of the given estimated cost; throws when a limit is hit. */
  reserve(estimatedCostUsd: number, now: number = Date.now()): void {
    this.hits = this.hits.filter((h) => now - h.at < this.policy.windowMs);

    if (this.hits.length >= this.policy.maxRequestsPerWindow) {
      throw new WebSearchError(
        'rate_limited',
        `Web-search rate limit exceeded (${this.policy.maxRequestsPerWindow} per ${this.policy.windowMs}ms).`,
        429,
      );
    }

    const spent = this.hits.reduce((sum, h) => sum + h.cost, 0);
    if (spent + estimatedCostUsd > this.policy.costBudgetUsdPerWindow) {
      throw new WebSearchError(
        'cost_cap_exceeded',
        `Web-search cost budget exceeded ($${this.policy.costBudgetUsdPerWindow.toFixed(3)} per window).`,
        429,
      );
    }

    this.hits.push({ at: now, cost: Math.max(0, estimatedCostUsd) });
  }

  /** Live window state (for observability / tests). */
  snapshot(now: number = Date.now()): { requests: number; spentUsd: number } {
    const live = this.hits.filter((h) => now - h.at < this.policy.windowMs);
    return {
      requests: live.length,
      spentUsd: live.reduce((sum, h) => sum + h.cost, 0),
    };
  }
}

/**
 * Guard against leaking a secret (e.g. the provider API key) into an outbound URL. Returns the URL
 * unchanged when clean; throws when the secret is present so it can't be logged or requested.
 */
export function assertNoSecretInUrl(url: string, secret: string | undefined): string {
  if (secret && secret.length >= 8 && url.includes(secret)) {
    throw new WebSearchError(
      'secret_in_url',
      'Refusing to use an outbound URL that embeds a credential.',
      500,
    );
  }
  return url;
}
