import type { SemanticRouteDecision } from '~/lib/orchestrator/semantic-router';
import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';

import {
  computeRoutingTestSummary,
  isRoutingTestItemPass,
  mapWithConcurrency,
  normalizeRoutedAgent,
} from './scoring';
import type {
  RoutingTestItemRecord,
  RoutingTestItemResult,
  RoutingTestRouterType,
  RoutingTestRunResult,
} from './types';

/**
 * One embedding round-trip per item on a cold cache, so a 50-item list must not fan out 50
 * concurrent OpenAI calls. The keyword router is synchronous and ignores this entirely.
 */
export const ROUTING_TEST_SEMANTIC_CONCURRENCY = 4;

function keywordResult(item: RoutingTestItemRecord): RoutingTestItemResult {
  const decision = routeUserMessageToSme(item.prompt);
  // `agent` is `SmeAgentId | null`; `null` collapses to 'ambiguous' (see `normalizeRoutedAgent`).
  const predicted = normalizeRoutedAgent(decision.agent);

  return {
    itemId: item.id,
    prompt: item.prompt,
    expectedAgent: item.expected_agent,
    predicted,
    passed: isRoutingTestItemPass(predicted, item.expected_agent),
    // The keyword router cannot degrade — it is pure and never throws.
    error: null,
    detail: {
      kind: 'keyword',
      decisionPath: decision.decisionPath,
      rationale: decision.rationale,
      matchedPhrases: decision.matchedPhrases,
      scores: {
        product: decision.productScore,
        bathroom: decision.bathroomScore,
        dilution: decision.dilutionScore,
        floor: decision.floorScore,
        recommendations: decision.recommendationScore,
      },
    },
  };
}

function semanticResult(
  item: RoutingTestItemRecord,
  decision: SemanticRouteDecision,
): RoutingTestItemResult {
  const predicted = normalizeRoutedAgent(decision.route);

  return {
    itemId: item.id,
    prompt: item.prompt,
    expectedAgent: item.expected_agent,
    predicted,
    passed: isRoutingTestItemPass(predicted, item.expected_agent),
    // Non-null `error` means the router degraded to `path: 'fallback'` — surfaced, not swallowed.
    error: decision.error,
    detail: {
      kind: 'semantic',
      confidence: decision.confidence,
      similarity: decision.similarity,
      margin: decision.margin,
      path: decision.path,
      scores: decision.scores.map((score) => ({
        route: score.route,
        similarity: score.similarity,
      })),
      thresholds: decision.thresholds,
      thresholdsPassed: decision.thresholdsPassed,
      latencyMs: decision.latencyMs,
      examplesVersion: decision.examplesVersion,
      embeddingModel: decision.embeddingModel,
    },
  };
}

/**
 * A semantic item that could not produce a decision at all (the never-throws contract broke). Scored
 * as `'ambiguous'` — a fail — with the reason attached and no `detail`, so the run still reports the
 * item instead of the whole page disappearing behind an error boundary.
 */
function degradedSemanticResult(
  item: RoutingTestItemRecord,
  error: string,
): RoutingTestItemResult {
  return {
    itemId: item.id,
    prompt: item.prompt,
    expectedAgent: item.expected_agent,
    predicted: 'ambiguous',
    passed: false,
    error,
    detail: null,
  };
}

/**
 * B0-659 — score every routing-test item against one router. Results are EPHEMERAL: nothing here
 * writes to the database, and a re-run simply replaces the caller's previous result.
 *
 * "Semantic unavailable" is a real runtime capability check rather than a hardcoded flag: the
 * semantic module is imported lazily, and a failure to load (or a per-item degradation reported via
 * `SemanticRouteDecision.error`) is reported back to the UI instead of throwing.
 */
export async function runRoutingTest(
  items: readonly RoutingTestItemRecord[],
  routerType: RoutingTestRouterType,
): Promise<RoutingTestRunResult> {
  const ranAt = new Date().toISOString();

  if (items.length === 0) {
    return {
      ok: true,
      routerType,
      ranAt,
      items: [],
      summary: computeRoutingTestSummary([]),
      warning: 'No routing test items to run yet.',
    };
  }

  if (routerType === 'keyword') {
    const results = items.map(keywordResult);
    return {
      ok: true,
      routerType,
      ranAt,
      items: results,
      summary: computeRoutingTestSummary(results),
      warning: null,
    };
  }

  let classify: typeof import('~/lib/orchestrator/semantic-router').classifyUserIntentSemantic;
  try {
    const semanticModule = await import('~/lib/orchestrator/semantic-router');
    classify = semanticModule.classifyUserIntentSemantic;
    if (typeof classify !== 'function') {
      throw new Error('classifyUserIntentSemantic export is missing');
    }
  } catch (error) {
    return {
      ok: false,
      routerType,
      error: `Semantic router is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const results = await mapWithConcurrency(
    items,
    ROUTING_TEST_SEMANTIC_CONCURRENCY,
    async (item) => {
      // `classifyUserIntentSemantic` is contractually never-throwing, but this run is an admin
      // surface: a future regression that broke that contract would reject the whole
      // `Promise.all` and replace the page with an error boundary, losing every other item's
      // result. Degrading the single item keeps the run — and the AC's "clearly unavailable
      // rather than erroring" — intact.
      try {
        return semanticResult(item, await classify(item.prompt));
      } catch (error) {
        return degradedSemanticResult(
          item,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  const degradedCount = results.filter((result) => result.error !== null).length;
  const firstError = results.find((result) => result.error !== null)?.error;

  return {
    ok: true,
    routerType,
    ranAt,
    items: results,
    summary: computeRoutingTestSummary(results),
    warning:
      degradedCount === results.length
        ? `Semantic router degraded on every item (${firstError ?? 'unknown reason'}) — treat these results as unavailable, not as routing failures.`
        : degradedCount > 0
          ? `${degradedCount} of ${results.length} items degraded to the semantic fallback (${firstError ?? 'unknown reason'}).`
          : null,
  };
}
