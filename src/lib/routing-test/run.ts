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

/** Same reasoning as `ROUTING_TEST_SEMANTIC_CONCURRENCY` — one LLM classification call per item. */
export const ROUTING_TEST_LLM_CONCURRENCY = 4;

/**
 * B0-667 — the four result-builder functions below run before timing is known to their caller
 * (`runRoutingTest` measures the whole classification call, including the builder itself), so they
 * build everything except `elapsedMs`; each call site stamps that on afterward.
 */
type TimelessItemResult = Omit<RoutingTestItemResult, 'elapsedMs'>;

function keywordResult(item: RoutingTestItemRecord): TimelessItemResult {
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
): TimelessItemResult {
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
): TimelessItemResult {
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
 * B0-666 — `classifyUserIntent`'s own `source: 'keyword_fallback'` IS the degraded case (LLM
 * disabled, timed out, or errored) — it never throws, so unlike the semantic path there is no
 * separate "the never-throws contract broke" branch. `fallbackReason` becomes this item's `error`,
 * same "unavailable, not a routing failure" convention the semantic router uses.
 */
function llmResult(
  item: RoutingTestItemRecord,
  classification: Awaited<ReturnType<typeof import('~/lib/orchestrator/intent-classifier').classifyUserIntent>>,
): TimelessItemResult {
  const predicted = normalizeRoutedAgent(classification.intent);

  return {
    itemId: item.id,
    prompt: item.prompt,
    expectedAgent: item.expected_agent,
    predicted,
    passed: isRoutingTestItemPass(predicted, item.expected_agent),
    error: classification.source === 'keyword_fallback' ? classification.fallbackReason : null,
    detail: {
      kind: 'llm',
      source: classification.source,
      confidence: classification.confidence,
      fallbackReason: classification.fallbackReason,
      model: classification.model,
      suggestedTool: classification.suggestedTool,
    },
  };
}

/** Mirrors `degradedSemanticResult` for the llm path's own never-throws contract. */
function degradedLlmResult(
  item: RoutingTestItemRecord,
  error: string,
): TimelessItemResult {
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
 * B0-659 — score every routing-test item against one router. This function itself writes nothing
 * to the database — it is `runRoutingTestAction` (`./actions.ts`), not `runRoutingTest`, that
 * persists an `ok: true` result as a history row (B0-667). The live inline result stays the
 * caller's source of truth either way: a re-run simply replaces it.
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
  // B0-667 — wall-clock start for the whole run; `computeRoutingTestSummary`'s `durationMs` is
  // measured against this, not derived from the items (their work can overlap under
  // `mapWithConcurrency`).
  const runStartedAt = Date.now();

  if (items.length === 0) {
    return {
      ok: true,
      routerType,
      ranAt,
      items: [],
      summary: computeRoutingTestSummary([], Date.now() - runStartedAt),
      warning: 'No routing test items to run yet.',
    };
  }

  if (routerType === 'keyword') {
    const results = items.map((item) => {
      const itemStartedAt = Date.now();
      const result = keywordResult(item);
      return { ...result, elapsedMs: Date.now() - itemStartedAt };
    });
    return {
      ok: true,
      routerType,
      ranAt,
      items: results,
      summary: computeRoutingTestSummary(results, Date.now() - runStartedAt),
      warning: null,
    };
  }

  if (routerType === 'semantic') {
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
        const itemStartedAt = Date.now();
        // `classifyUserIntentSemantic` is contractually never-throwing, but this run is an admin
        // surface: a future regression that broke that contract would reject the whole
        // `Promise.all` and replace the page with an error boundary, losing every other item's
        // result. Degrading the single item keeps the run — and the AC's "clearly unavailable
        // rather than erroring" — intact.
        try {
          const result = semanticResult(item, await classify(item.prompt));
          return { ...result, elapsedMs: Date.now() - itemStartedAt };
        } catch (error) {
          const result = degradedSemanticResult(
            item,
            error instanceof Error ? error.message : String(error),
          );
          return { ...result, elapsedMs: Date.now() - itemStartedAt };
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
      summary: computeRoutingTestSummary(results, Date.now() - runStartedAt),
      warning:
        degradedCount === results.length
          ? `Semantic router degraded on every item (${firstError ?? 'unknown reason'}) — treat these results as unavailable, not as routing failures.`
          : degradedCount > 0
            ? `${degradedCount} of ${results.length} items degraded to the semantic fallback (${firstError ?? 'unknown reason'}).`
            : null,
    };
  }

  // routerType === 'llm' (B0-666) — same lazy-import capability check as semantic, so a broken
  // deploy of `intent-classifier.ts` reports "unavailable" instead of a 500.
  let classify: typeof import('~/lib/orchestrator/intent-classifier').classifyUserIntent;
  try {
    const llmModule = await import('~/lib/orchestrator/intent-classifier');
    classify = llmModule.classifyUserIntent;
    if (typeof classify !== 'function') {
      throw new Error('classifyUserIntent export is missing');
    }
  } catch (error) {
    return {
      ok: false,
      routerType,
      error: `LLM router is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const results = await mapWithConcurrency(
    items,
    ROUTING_TEST_LLM_CONCURRENCY,
    async (item) => {
      const itemStartedAt = Date.now();
      // `classifyUserIntent` is also contractually never-throwing (it has its own internal
      // fallback), but the same admin-surface defense applies as the semantic path above.
      try {
        const result = llmResult(item, await classify(item.prompt));
        return { ...result, elapsedMs: Date.now() - itemStartedAt };
      } catch (error) {
        const result = degradedLlmResult(
          item,
          error instanceof Error ? error.message : String(error),
        );
        return { ...result, elapsedMs: Date.now() - itemStartedAt };
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
    summary: computeRoutingTestSummary(results, Date.now() - runStartedAt),
    warning:
      degradedCount === results.length
        ? `LLM router degraded on every item (${firstError ?? 'unknown reason'}) — treat these results as unavailable, not as routing failures.`
        : degradedCount > 0
          ? `${degradedCount} of ${results.length} items degraded to the keyword fallback (${firstError ?? 'unknown reason'}).`
          : null,
  };
}
