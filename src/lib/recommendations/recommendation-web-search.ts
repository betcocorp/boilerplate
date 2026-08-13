import { normalizeSearchQuery } from '~/lib/websearch/cache';
import { WebSearchService } from '~/lib/websearch/web-search-service';
import { WebSearchError } from '~/lib/websearch/types';
import type { WebSearchRequest, WebSearchResponse } from '~/lib/websearch/websearch-schemas';

/**
 * B0-92 — cost/domain/rate guardrails for the web-search step of the cross-reference
 * recommendation. Wraps `WebSearchService` (which already caches + enforces the global WEB-5 rate
 * budget) with per-recommendation controls:
 *   - at most `maxSearches` provider queries (default 2), starting at `basic` depth and escalating
 *     to `advanced` only when the first pass is inconclusive (B0-325 tightened that gate, and adds an
 *     opt-in `XREF_PARALLEL_SEARCH_ESCALATION` mode that dispatches both tiers concurrently);
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
  /** B0-325: provider relevance score below which the basic pass counts as weak. */
  minTopScore: number;
  /**
   * B0-325: a weak top score alone no longer escalates — the pass must ALSO carry fewer than this
   * many results with usable content. Guards against paying a second round-trip when the basic pass
   * already returned plenty to ground a spec on.
   */
  minUsableResults: number;
  /**
   * B0-325: dispatch the basic and advanced passes concurrently instead of sequentially. Cuts
   * worst-case latency by one full provider round-trip at the cost of an advanced search that is
   * discarded whenever the basic pass turns out to be conclusive. OFF by default — enabling it
   * roughly doubles per-recommendation search spend.
   */
  parallelEscalation: boolean;
};

/** Minimum characters of content for a result to count as usable evidence. */
const USABLE_CONTENT_CHARS = 40;

/**
 * Projected spend of a parallel basic+advanced pair (Tavily: $0.008 + $0.016). Parallel escalation
 * commits to both searches up front, so it is only enabled when the per-recommendation cap can
 * actually absorb them.
 */
export const PARALLEL_PROJECTED_COST_USD = 0.024;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Non-negative (allows 0, unlike positiveNumber) — a 0 score floor disables score-based escalation. */
function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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
    minTopScore: nonNegativeNumber(env.XREF_SEARCH_MIN_TOP_SCORE, 0.3),
    minUsableResults: Math.max(
      1,
      Math.floor(positiveNumber(env.XREF_SEARCH_MIN_USABLE_RESULTS, 3)),
    ),
    parallelEscalation: env.XREF_PARALLEL_SEARCH_ESCALATION === 'true',
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

/** Boilerplate appended to every recommendation query to bias the provider toward spec pages. */
const RECOMMENDATION_QUERY_SUFFIX = 'product specifications disinfectant OR cleaner';

/**
 * Corporate-form tokens that carry no retrieval signal but do fragment the cache (B0-326): the
 * upstream competitor extraction emits the same manufacturer as both "Spartan" and
 * "Spartan Chemical" run to run, which minted two cache entries (and two provider bills) for one
 * product.
 */
const BRAND_CORPORATE_TOKENS = new Set([
  'chemical',
  'chemicals',
  'company',
  'co',
  'corp',
  'corporation',
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'group',
  'brands',
  'international',
  'intl',
]);

/** Drop corporate-form tokens, but never reduce a brand to nothing (e.g. "Chemical Co"). */
function normalizeBrandForQuery(brand: string): string {
  const tokens = brand.split(/\s+/).filter(Boolean);
  const kept = tokens.filter(
    (token) => !BRAND_CORPORATE_TOKENS.has(normalizeSearchQuery(token)),
  );
  return (kept.length > 0 ? kept : tokens).join(' ');
}

export function buildRecommendationQuery(input: { brand: string; product: string }): string {
  const brand = normalizeBrandForQuery(input.brand.trim());
  const product = input.product.trim();
  // Don't repeat the brand when the product name already leads with it ("Spartan" +
  // "Spartan Xtreme Blue" → one mention), which is another source of near-duplicate keys.
  const brandIsRedundant =
    brand.length > 0 &&
    normalizeSearchQuery(product).startsWith(`${normalizeSearchQuery(brand)} `);

  return [brandIsRedundant ? '' : brand, product, RECOMMENDATION_QUERY_SUFFIX]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A pass is inconclusive when it returns nothing usable to ground a spec on (B0-325).
 *
 * Previously a `topScore < 0.3` alone forced escalation. Measured against the live
 * `web_search_cache` corpus that was firing on passes that were already rich in evidence: every
 * escalation on record had 5/5 results carrying usable content (up to ~1.6KB), and the trigger was
 * purely a depressed relevance score — the appended `RECOMMENDATION_QUERY_SUFFIX` drags the
 * provider's score down (the same product scored 0.93 without the suffix vs 0.04 with it). So a weak
 * score now escalates only when the evidence set is ALSO thin, which is what "inconclusive" was
 * always meant to capture.
 */
export function isSearchInconclusive(
  response: WebSearchResponse,
  opts: { minTopScore?: number; minUsableResults?: number } = {},
): boolean {
  const minTopScore = opts.minTopScore ?? 0.3;
  const minUsableResults = opts.minUsableResults ?? 3;

  if (response.results.length === 0) return true;

  const usableResults = response.results.filter(
    (r) => (r.rawContent ?? r.snippet ?? '').trim().length > USABLE_CONTENT_CHARS,
  ).length;
  // Nothing substantive at all — always worth a deeper crawl.
  if (usableResults === 0) return true;

  const topScore = response.results[0]?.score ?? 0;
  return topScore < minTopScore && usableResults < minUsableResults;
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

/**
 * B0-325 concurrent variant. Semantics are deliberately identical to the sequential path — the
 * advanced pass is merged in only when the basic pass is inconclusive — so the flag changes latency
 * and cost, never which evidence a recommendation is grounded on.
 *
 * Reported telemetry stays truthful: `searchesUsed` / `estimatedCostUsd` count every search actually
 * dispatched and billed (2 whenever both resolve, even if the advanced result is discarded), while
 * `escalated` stays true only when advanced evidence was really used.
 */
async function runParallelEscalation(
  args: { query: string; domains: string[] | undefined },
  deps: RecommendationWebSearchDeps,
  policy: RecommendationSearchPolicy,
  inconclusive: (r: WebSearchResponse) => boolean,
): Promise<RecommendationSearchResult> {
  const { query, domains } = args;
  const [basic, advanced] = await Promise.allSettled([
    deps.search({ query, depth: 'basic', domains, maxResults: 5 }),
    deps.search({ query, depth: 'advanced', domains, maxResults: 5 }),
  ]);

  let searchesUsed = 0;
  let estimatedCostUsd = 0;
  for (const settled of [basic, advanced]) {
    if (settled.status === 'fulfilled') {
      searchesUsed += 1;
      estimatedCostUsd += settled.value.metrics.estimatedCostUsd;
      deps.recordDailySpendUsd(settled.value.metrics.estimatedCostUsd);
    }
  }

  const basicValue = basic.status === 'fulfilled' ? basic.value : null;
  const advancedValue = advanced.status === 'fulfilled' ? advanced.value : null;

  let response: WebSearchResponse | null = null;
  let escalated = false;
  if (basicValue && advancedValue) {
    if (inconclusive(basicValue)) {
      response = mergeResponses(basicValue, advancedValue);
      escalated = true;
    } else {
      response = basicValue;
    }
  } else if (basicValue) {
    response = basicValue;
  } else if (advancedValue) {
    // Basic failed; the advanced pass is strictly better evidence, so use it.
    response = advancedValue;
    escalated = true;
  }

  const rateLimited = [basic, advanced].some(
    (s) => s.status === 'rejected' && s.reason instanceof WebSearchError && s.reason.status === 429,
  );

  return {
    response,
    searchesUsed,
    estimatedCostUsd,
    budgetExceeded: response === null && rateLimited,
    escalated,
  };
}

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

  const inconclusive = (r: WebSearchResponse) =>
    isSearchInconclusive(r, {
      minTopScore: policy.minTopScore,
      minUsableResults: policy.minUsableResults,
    });

  // B0-325 opt-in: dispatch both tiers at once so the worst case is one round-trip instead of two.
  // Both searches are billed regardless of whether the advanced one ends up being used, so this is
  // only sound while the projected spend still fits the per-recommendation cap — otherwise fall back
  // to the sequential path rather than silently blowing the B0-92 budget.
  if (
    policy.parallelEscalation &&
    policy.maxSearches >= 2 &&
    policy.queryBudgetUsd >= PARALLEL_PROJECTED_COST_USD
  ) {
    return runParallelEscalation({ query, domains }, deps, policy, inconclusive);
  }

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
      inconclusive(first);

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
