import { WebSearchService } from '~/lib/websearch/web-search-service';
import { WebSearchError } from '~/lib/websearch/types';
import type { WebSearchRequest, WebSearchResponse } from '~/lib/websearch/websearch-schemas';

/**
 * B0-92 — cost/domain/rate guardrails for the web-search step of the cross-reference
 * recommendation. Wraps `WebSearchService` (which already caches + enforces the global WEB-5 rate
 * budget) with per-recommendation controls:
 *   - at most `maxSearches` provider queries (default 2), starting at `basic` depth and escalating
 *     to `advanced` only when the first pass is inconclusive;
 *   - an optional domain allowlist applied via the service's `domains` param;
 *   - a per-recommendation cost cap and a process-wide daily cap that short-circuits to a decline;
 *   - accurate per-recommendation cost/telemetry the caller records to the audit log.
 * Cache reuse is inherited from `WebSearchService`: an identical query+depth+domains within the TTL
 * costs $0 and makes no provider call.
 */

export type RecommendationSearchPolicy = {
  maxSearches: number;
  /** Cost cap (USD) for a single recommendation's searches. */
  queryBudgetUsd: number;
  /** Cost cap (USD) across all recommendations for the current process/day. */
  dailyBudgetUsd: number;
  /** Optional domain allowlist (competitor / manufacturer / EPA). Empty = unrestricted. */
  domainAllowlist: string[];
};

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadRecommendationSearchPolicy(
  env: NodeJS.ProcessEnv = process.env,
): RecommendationSearchPolicy {
  const rawDomains = env.XREF_SEARCH_DOMAIN_ALLOWLIST?.trim();
  return {
    maxSearches: Math.max(1, Math.floor(positiveNumber(env.XREF_MAX_SEARCHES_PER_RECOMMENDATION, 2))),
    queryBudgetUsd: positiveNumber(env.XREF_WEB_QUERY_BUDGET_USD, 0.05),
    dailyBudgetUsd: positiveNumber(env.XREF_WEB_DAILY_BUDGET_USD, 5),
    domainAllowlist: rawDomains
      ? rawDomains
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean)
      : [],
  };
}

export type RecommendationSearchResult = {
  /** Merged evidence; null when the budget short-circuited or every search failed. */
  response: WebSearchResponse | null;
  searchesUsed: number;
  estimatedCostUsd: number;
  /** True when a budget cap (daily pre-check or a provider 429) prevented getting any evidence. */
  budgetExceeded: boolean;
  escalated: boolean;
};

export function buildRecommendationQuery(input: { brand: string; product: string }): string {
  return [input.brand, input.product, 'product specifications disinfectant OR cleaner']
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** A pass is inconclusive when it returns nothing usable to ground a spec on. */
export function isSearchInconclusive(response: WebSearchResponse): boolean {
  if (response.results.length === 0) return true;
  const hasContent = response.results.some(
    (r) => (r.rawContent ?? r.snippet ?? '').trim().length > 40,
  );
  const topScore = response.results[0]?.score ?? 0;
  return !hasContent || topScore < 0.3;
}

/** Union the two passes' results (dedupe by url); costs and latency accumulate. */
function mergeResponses(a: WebSearchResponse, b: WebSearchResponse): WebSearchResponse {
  const byUrl = new Map<string, WebSearchResponse['results'][number]>();
  for (const r of [...a.results, ...b.results]) {
    if (!byUrl.has(r.url)) byUrl.set(r.url, r);
  }
  const results = [...byUrl.values()];
  return {
    query: b.query,
    provider: b.provider,
    answer: b.answer ?? a.answer,
    results,
    metrics: {
      latencyMs: a.metrics.latencyMs + b.metrics.latencyMs,
      resultCount: results.length,
      estimatedCostUsd: a.metrics.estimatedCostUsd + b.metrics.estimatedCostUsd,
      cached: a.metrics.cached && b.metrics.cached,
    },
  };
}

// Process-wide daily spend accumulator (like WebSearchGuardrails: bounds spend within an instance).
const dailySpend = { day: '', usd: 0 };
function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
function rollDay(now: number): void {
  const day = dayKey(now);
  if (dailySpend.day !== day) {
    dailySpend.day = day;
    dailySpend.usd = 0;
  }
}
export function getRecommendationDailySpendUsd(now: number = Date.now()): number {
  rollDay(now);
  return dailySpend.usd;
}
export function recordRecommendationDailySpendUsd(usd: number, now: number = Date.now()): void {
  rollDay(now);
  dailySpend.usd += Math.max(0, usd);
}
/** Test helper: reset the process daily accumulator. */
export function resetRecommendationDailySpend(): void {
  dailySpend.day = '';
  dailySpend.usd = 0;
}

export type RecommendationWebSearchDeps = {
  search: (request: WebSearchRequest) => Promise<WebSearchResponse>;
  getDailySpendUsd: () => number;
  recordDailySpendUsd: (usd: number) => void;
};

const defaultDeps: RecommendationWebSearchDeps = {
  search: (request) => new WebSearchService().search(request),
  getDailySpendUsd: () => getRecommendationDailySpendUsd(),
  recordDailySpendUsd: (usd) => recordRecommendationDailySpendUsd(usd),
};

export async function runRecommendationWebSearch(
  input: { brand: string; product: string },
  deps: RecommendationWebSearchDeps = defaultDeps,
  policy: RecommendationSearchPolicy = loadRecommendationSearchPolicy(),
): Promise<RecommendationSearchResult> {
  const domains = policy.domainAllowlist.length > 0 ? policy.domainAllowlist : undefined;
  const query = buildRecommendationQuery(input);

  // Daily budget short-circuit — before any spend.
  if (deps.getDailySpendUsd() >= policy.dailyBudgetUsd) {
    return { response: null, searchesUsed: 0, estimatedCostUsd: 0, budgetExceeded: true, escalated: false };
  }

  let searchesUsed = 0;
  let estimatedCostUsd = 0;
  let response: WebSearchResponse | null = null;
  let escalated = false;

  try {
    const first = await deps.search({ query, depth: 'basic', domains, maxResults: 5 });
    searchesUsed += 1;
    estimatedCostUsd += first.metrics.estimatedCostUsd;
    deps.recordDailySpendUsd(first.metrics.estimatedCostUsd);
    response = first;

    const canEscalate =
      searchesUsed < policy.maxSearches &&
      estimatedCostUsd < policy.queryBudgetUsd &&
      deps.getDailySpendUsd() < policy.dailyBudgetUsd &&
      isSearchInconclusive(first);

    if (canEscalate) {
      const second = await deps.search({ query, depth: 'advanced', domains, maxResults: 5 });
      searchesUsed += 1;
      estimatedCostUsd += second.metrics.estimatedCostUsd;
      deps.recordDailySpendUsd(second.metrics.estimatedCostUsd);
      response = mergeResponses(first, second);
      escalated = true;
    }
  } catch (err) {
    // A provider/guardrail failure (incl. the global WEB-5 429 rate/cost cap): decline only if we
    // got no usable evidence at all; otherwise fall through with what the first pass returned.
    const rateLimited = err instanceof WebSearchError && err.status === 429;
    return {
      response,
      searchesUsed,
      estimatedCostUsd,
      budgetExceeded: response === null && rateLimited,
      escalated,
    };
  }

  return { response, searchesUsed, estimatedCostUsd, budgetExceeded: false, escalated };
}
