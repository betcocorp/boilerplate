import type { IntentClassification, IntentValue } from '~/lib/orchestrator/intent-classifier';
import type { SmeRouteDecision } from '~/lib/orchestrator/sme-routing';

/**
 * B0-500/B0-501 — dual-router instrumentation for the eval harness (see
 * `~/lib/training/orchestrator-intent-labels.ts`, whose header names this module explicitly). Same
 * spirit as `tool-routing.ts`'s per-tool routing accuracy (B0-383): a pure reducer half here, an I/O
 * half (`insertTestResultItems` writing the five `test_result_items` columns this feature adds —
 * `routing_decision`, `keyword_route`, `llm_route`, `routing_confidence`, `intended_agent_label`,
 * B0-500 migration) in `repository.ts`/`run-executor.ts`.
 *
 * `run-executor.ts` calls BOTH `routeUserMessageToSme` (keyword) and `classifyUserIntent` (LLM) for
 * every chat-style eval item, regardless of which one actually routed the real answer
 * (`routing_decision`, a generated column reusing the `response_payload.routingDecision` the
 * workflow already stamps) — this module turns those raw router outputs plus ground truth into the
 * typed row fields the DB stores, and (the report half) into a per-router accuracy score.
 */

/** Same value space as `IntentValue` (`SmeAgentId | 'ambiguous'`) — kept as a local alias so this
 * module's own vocabulary (ground truth, keyword route, llm route) doesn't have to reach into
 * `intent-classifier.ts` for a name every time. */
export type RoutingLabel = IntentValue;

/**
 * Normalizes the keyword router's decision into the same value space the LLM classifier reports
 * (`SmeAgentId | 'ambiguous'`). `agent: null` (empty message or zero keyword hits — see
 * `SmeRouteDecisionPath`) collapses to `'ambiguous'`, matching `classifyUserIntent`'s own
 * `fallbackClassification` convention exactly, so the two columns are always directly comparable.
 */
export function normalizeKeywordRoute(decision: Pick<SmeRouteDecision, 'agent'>): RoutingLabel {
  return decision.agent ?? 'ambiguous';
}

/**
 * Ground-truth precedence for `intended_agent_label`: the per-item `test_items.intended_agent_item`
 * (B0-498) wins when set; otherwise fall back to the parent suite's `tests.intended_agent`
 * (coarser, suite-level tag); otherwise null (unlabeled — excluded from accuracy scoring downstream).
 */
export function resolveIntendedAgentLabel(params: {
  itemIntendedAgent: string | null | undefined;
  testIntendedAgent: string | null | undefined;
}): string | null {
  const itemLabel = params.itemIntendedAgent?.trim();
  if (itemLabel) {
    return itemLabel;
  }
  const testLabel = params.testIntendedAgent?.trim();
  return testLabel ? testLabel : null;
}

/**
 * B0-652 — the plain-field slice of `SemanticRouteDecision` (`~/lib/orchestrator/semantic-router`)
 * this module needs. Deliberately a LOCAL structural type rather than an import: every reducer
 * below then stays unit-testable without the router module (and without an embedding call), exactly
 * as `normalizeKeywordRoute` takes a `Pick<SmeRouteDecision, 'agent'>` instead of the whole
 * decision. The run-executor call site is the only place that touches the real decision object.
 */
export type SemanticRouteInstrumentation = {
  /** `SmeAgentId | 'ambiguous'` — `'ambiguous'` whenever the router took the fallback path. */
  route: string;
  confidence: number;
  margin: number;
  /** `'semantic'` = BOTH thresholds passed and the router committed; `'fallback'` = it gave up. */
  path: string;
  /** Total ms the caller waited (embedding round-trip + scoring). */
  latencyMs?: number | null;
  /** The embedding-call portion of `latencyMs` — network-bound, and the reason a cold route can
   * never meet a 10ms budget. */
  embeddingMs?: number | null;
  /** The cosine-scoring portion of `latencyMs` — no I/O; the only part a ≤10ms budget applies to. */
  scoringMs?: number | null;
};

/**
 * B0-652 — categorical three-way agreement label. Not a boolean: with three routers, WHICH pair
 * agreed is the informative part during a cutover ("semantic already tracks the LLM classifier" is
 * a very different story from "semantic tracks the keyword router the LLM disagrees with").
 */
export const ROUTING_AGREEMENT_VALUES = [
  'all_agree',
  'keyword_llm',
  'keyword_semantic',
  'llm_semantic',
  'all_differ',
] as const;

export type RoutingAgreement = (typeof ROUTING_AGREEMENT_VALUES)[number];

/**
 * Reduces the three router routes to one agreement label. Returns `null` when fewer than two of the
 * three are present — with one route there is nothing to agree about, and calling that `'all_differ'`
 * would inflate the disagreement count with items that were never compared.
 */
export function computeRoutingAgreement(params: {
  keywordRoute: string | null | undefined;
  llmRoute: string | null | undefined;
  semanticRoute: string | null | undefined;
}): RoutingAgreement | null {
  const keyword = params.keywordRoute ?? null;
  const llm = params.llmRoute ?? null;
  const semantic = params.semanticRoute ?? null;
  const presentCount = [keyword, llm, semantic].filter((route) => route !== null).length;
  if (presentCount < 2) {
    return null;
  }

  const keywordLlm = keyword !== null && llm !== null && keyword === llm;
  const keywordSemantic = keyword !== null && semantic !== null && keyword === semantic;
  const llmSemantic = llm !== null && semantic !== null && llm === semantic;

  if (presentCount === 3 && keywordLlm && keywordSemantic) {
    return 'all_agree';
  }
  // With only two routes present, the pair matching IS total agreement for this item.
  if (presentCount === 2 && (keywordLlm || keywordSemantic || llmSemantic)) {
    return 'all_agree';
  }
  if (keywordLlm) return 'keyword_llm';
  if (keywordSemantic) return 'keyword_semantic';
  if (llmSemantic) return 'llm_semantic';
  return 'all_differ';
}

export type RoutingComparisonFields = {
  keyword_route: RoutingLabel;
  llm_route: RoutingLabel;
  routing_confidence: number;
  intended_agent_label: string | null;
  /** B0-524 — wall-clock ms for the `routeUserMessageToSme` call, measured at the run-executor.ts
   * call site. Optional so callers that can't/don't measure (e.g. existing unit tests) still typecheck. */
  keyword_route_latency_ms?: number | null;
  /** B0-524 — wall-clock ms for the `classifyUserIntent` call, including cache-hit and
   * keyword-fallback paths (both still measured — a fast fallback is a real, informative data point). */
  llm_route_latency_ms?: number | null;
  /**
   * B0-652 — semantic-router columns. Optional in the same spirit as B0-524's latency fields, and
   * OMITTED ENTIRELY (not set to null) when no semantic decision was passed, so an eval run made
   * before the semantic router existed inserts exactly the rows it used to.
   */
  semantic_route?: string | null;
  semantic_confidence?: number | null;
  semantic_margin?: number | null;
  semantic_path?: string | null;
  semantic_route_latency_ms?: number | null;
  semantic_embedding_ms?: number | null;
  semantic_scoring_ms?: number | null;
  routing_agreement?: RoutingAgreement | null;
  /**
   * B0-911 — WHY this item's routing pipeline degraded, or `null` on the happy path. Always
   * written (never omitted), because "no fallback" is a real, positive fact worth recording on a
   * row that has the rest of the routing instrumentation: `routing_confidence is not null and
   * routing_fallback_reason is null` is how a healthy item is told apart from a pre-B0-911 row.
   */
  routing_fallback_reason?: string | null;
};

/**
 * B0-911 — composes the persisted `routing_fallback_reason` from the two passes that can silently
 * degrade a turn's routing. Both `classifyUserIntent` and `analyzeTurnSignals` are contracted never
 * to throw: on any provider failure they log, return `source: 'keyword_fallback'`, and carry the
 * reason (the full provider error body, e.g. a 400) on `fallbackReason`. Nothing read that, so a
 * run could 400 on every item and still report a letter grade (the 2026-09-08 vendor comparison).
 *
 * The pass is named in the stored string because the two are different facts: `signals` is the LIVE
 * pass on the answer path (it decided how the item was actually answered), while `llm_router` is
 * the harness's own instrumentation call — the one `routing_confidence`/`llm_route` come from. When
 * both fell back, `signals` wins: the live pass is the one that shaped the graded answer.
 *
 * Returns `null` when neither pass fell back, so the happy path stores nothing. A fallback with an
 * empty/absent reason still returns a string — the fact that it fell back must survive even when
 * the reason did not.
 */
export function describeRoutingFallback(params: {
  /** The live `analyzeTurnSignals` result for this item's answer, when it could be read. */
  signals?: Pick<IntentClassification, 'source' | 'fallbackReason'> | null;
  /** The harness's own `classifyUserIntent` instrumentation result. */
  llmRouter?: Pick<IntentClassification, 'source' | 'fallbackReason'> | null;
}): string | null {
  const passes: ReadonlyArray<[string, Pick<IntentClassification, 'source' | 'fallbackReason'> | null | undefined]> = [
    ['signals', params.signals],
    ['llm_router', params.llmRouter],
  ];

  for (const [label, pass] of passes) {
    if (!pass || pass.source !== 'keyword_fallback') {
      continue;
    }
    const reason = pass.fallbackReason?.trim();
    return `${label}: ${reason || 'unknown reason'}`;
  }

  return null;
}

/**
 * Builds the B0-501-computed `test_result_items` columns (`routing_decision` is not among
 * them — it is generated from `response_payload`, not written by this instrumentation) from one
 * keyword decision + one LLM classification + the resolved ground-truth label, plus the B0-524
 * per-router latencies measured at the call site and (B0-652) an optional semantic-router decision.
 */
export function buildRoutingComparisonFields(params: {
  keywordDecision: Pick<SmeRouteDecision, 'agent'>;
  llmClassification: Pick<IntentClassification, 'intent' | 'confidence'>;
  intendedAgentLabel: string | null;
  keywordRouteLatencyMs?: number | null;
  llmRouteLatencyMs?: number | null;
  /** B0-652 — omit (or pass null) when the semantic router was not consulted for this item. */
  semanticDecision?: SemanticRouteInstrumentation | null;
  /**
   * B0-911 — from `describeRoutingFallback`. Passed in rather than derived here so this reducer
   * stays a pure field-builder and the call site keeps ownership of reading BOTH passes (the live
   * signals gate is only reachable there, via the item's workflow run).
   */
  routingFallbackReason?: string | null;
}): RoutingComparisonFields {
  const fields: RoutingComparisonFields = {
    keyword_route: normalizeKeywordRoute(params.keywordDecision),
    llm_route: params.llmClassification.intent,
    routing_confidence: params.llmClassification.confidence,
    intended_agent_label: params.intendedAgentLabel,
    keyword_route_latency_ms: params.keywordRouteLatencyMs ?? null,
    llm_route_latency_ms: params.llmRouteLatencyMs ?? null,
    routing_fallback_reason: params.routingFallbackReason ?? null,
  };

  const semantic = params.semanticDecision;
  if (!semantic) {
    return fields;
  }

  return {
    ...fields,
    semantic_route: semantic.route,
    semantic_confidence: semantic.confidence,
    semantic_margin: semantic.margin,
    semantic_path: semantic.path,
    semantic_route_latency_ms: semantic.latencyMs ?? null,
    semantic_embedding_ms: semantic.embeddingMs ?? null,
    semantic_scoring_ms: semantic.scoringMs ?? null,
    routing_agreement: computeRoutingAgreement({
      keywordRoute: fields.keyword_route,
      llmRoute: fields.llm_route,
      semanticRoute: semantic.route,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Report reducer — per-router accuracy against ground truth, plus a keyword/LLM agreement rate.
// Mirrors `computeToolRoutingReport`'s shape (scored count / matched count / accuracy / mismatches).
// ---------------------------------------------------------------------------------------------

export type RoutingComparisonReportInput = {
  resultItemId: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
  /** From `resolveIntendedAgentLabel`; null = this item has no ground truth to score against. */
  intendedAgentLabel: string | null;
  /** The REAL routing decision that produced this item's answer (`routing_decision` column). */
  routingDecision: string | null;
  keywordRoute: string | null;
  llmRoute: string | null;
  /** B0-652 — `undefined` means "the semantic router was never consulted for this item", which is
   * scored differently from `null`/`'ambiguous'`: an un-consulted router is excluded, not wrong. */
  semanticRoute?: string | null;
};

export type RoutingComparisonMismatch = {
  resultItemId: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
  intendedAgentLabel: string;
  keywordRoute: string | null;
  llmRoute: string | null;
  routingDecision: string | null;
  /** B0-652 — undefined on items with no semantic instrumentation. */
  semanticRoute?: string | null;
};

export type RoutingComparisonReport = {
  /** Items with `intendedAgentLabel` set — the denominator for every accuracy figure below. */
  scoredItemCount: number;
  keywordMatchedCount: number;
  llmMatchedCount: number;
  actualMatchedCount: number;
  /** B0-652 — scored items that ALSO carry a semantic route; the denominator for `semanticAccuracy`
   * (smaller than `scoredItemCount` on runs where only some items were instrumented). */
  semanticScoredItemCount: number;
  semanticMatchedCount: number;
  /** `keywordMatchedCount / scoredItemCount`, or null when nothing in the run has ground truth. */
  keywordAccuracy: number | null;
  llmAccuracy: number | null;
  /** B0-652 — `semanticMatchedCount / semanticScoredItemCount`; null when no item was instrumented. */
  semanticAccuracy: number | null;
  /** How often the REAL routing decision (whatever generated the answer) matched ground truth. */
  actualAccuracy: number | null;
  /** Items where keyword_route and llm_route were both present and agreed with each other
   * (independent of ground truth — this is a router/router agreement rate, not an accuracy figure). */
  agreementCount: number;
  agreementRate: number | null;
  /** Scored items where keyword_route OR llm_route missed ground truth, sorted by row_index. */
  mismatches: RoutingComparisonMismatch[];
};

export function computeRoutingComparisonReport(
  items: RoutingComparisonReportInput[],
): RoutingComparisonReport {
  let scoredItemCount = 0;
  let keywordMatchedCount = 0;
  let llmMatchedCount = 0;
  let actualMatchedCount = 0;
  let semanticScoredItemCount = 0;
  let semanticMatchedCount = 0;
  let agreementCount = 0;
  let comparableCount = 0;
  const mismatches: RoutingComparisonMismatch[] = [];

  for (const item of items) {
    if (item.keywordRoute !== null && item.llmRoute !== null) {
      comparableCount += 1;
      if (item.keywordRoute === item.llmRoute) {
        agreementCount += 1;
      }
    }

    const label = item.intendedAgentLabel;
    if (!label) {
      continue;
    }

    scoredItemCount += 1;
    const keywordMatch = item.keywordRoute === label;
    const llmMatch = item.llmRoute === label;
    const actualMatch = item.routingDecision === label;
    if (keywordMatch) keywordMatchedCount += 1;
    if (llmMatch) llmMatchedCount += 1;
    if (actualMatch) actualMatchedCount += 1;

    // B0-652 — an item with no semantic instrumentation is neither a hit nor a miss; it is out of
    // the semantic denominator entirely, and it cannot make the item a mismatch.
    const semanticEvaluated =
      item.semanticRoute !== undefined && item.semanticRoute !== null;
    let semanticMatch = true;
    if (semanticEvaluated) {
      semanticScoredItemCount += 1;
      semanticMatch = item.semanticRoute === label;
      if (semanticMatch) semanticMatchedCount += 1;
    }

    if (!keywordMatch || !llmMatch || !semanticMatch) {
      mismatches.push({
        resultItemId: item.resultItemId,
        testItemId: item.testItemId,
        rowIndex: item.rowIndex,
        prompt: item.prompt,
        intendedAgentLabel: label,
        keywordRoute: item.keywordRoute,
        llmRoute: item.llmRoute,
        routingDecision: item.routingDecision,
        semanticRoute: item.semanticRoute,
      });
    }
  }

  return {
    scoredItemCount,
    keywordMatchedCount,
    llmMatchedCount,
    actualMatchedCount,
    semanticScoredItemCount,
    semanticMatchedCount,
    keywordAccuracy: scoredItemCount > 0 ? keywordMatchedCount / scoredItemCount : null,
    llmAccuracy: scoredItemCount > 0 ? llmMatchedCount / scoredItemCount : null,
    semanticAccuracy:
      semanticScoredItemCount > 0 ? semanticMatchedCount / semanticScoredItemCount : null,
    actualAccuracy: scoredItemCount > 0 ? actualMatchedCount / scoredItemCount : null,
    agreementCount,
    agreementRate: comparableCount > 0 ? agreementCount / comparableCount : null,
    mismatches: mismatches.sort((a, b) => a.rowIndex - b.rowIndex),
  };
}

// ---------------------------------------------------------------------------------------------
// B0-502 — RoutingAccuracyBoard (per-run): confusion matrix, ambiguous/tie rate, confidence
// distribution. Reads the same instrumentation fields as `computeRoutingComparisonReport` above,
// just reduced a different way — this file stays the one place that knows the shape of a
// `test_result_items` routing row.
// ---------------------------------------------------------------------------------------------

/** B0-652 added `'semantic'`; existing `'keyword'`/`'llm'` callers are unaffected. */
export type RouterKey = 'keyword' | 'llm' | 'semantic';

export type ConfusionMatrix = {
  /** Distinct `intended_agent_label` values seen among scored items — the matrix rows. */
  groundTruthLabels: string[];
  /** Distinct predicted route values seen for this router — the matrix columns. */
  predictedLabels: string[];
  /** `counts[groundTruthLabel][predictedLabel]` — undefined entries mean zero, not missing data. */
  counts: Record<string, Record<string, number>>;
  /** Sum of every cell — the number of items with BOTH a ground-truth label and this router's route. */
  totalCount: number;
};

/**
 * Ground truth (`intended_agent_label`) rows vs. one router's predicted route columns. Built
 * per-router (call twice, once per `RouterKey`) rather than as one three-way table, so the keyword
 * and LLM confusion matrices can be rendered side by side and diffed at a glance — which is the
 * whole point of comparing the two routers in the first place.
 */
export function buildConfusionMatrix(
  items: Pick<
    RoutingComparisonReportInput,
    'intendedAgentLabel' | 'keywordRoute' | 'llmRoute' | 'semanticRoute'
  >[],
  router: RouterKey,
): ConfusionMatrix {
  const counts: Record<string, Record<string, number>> = {};
  const groundTruthLabels = new Set<string>();
  const predictedLabels = new Set<string>();
  let totalCount = 0;

  for (const item of items) {
    const groundTruth = item.intendedAgentLabel;
    const predicted =
      router === 'keyword'
        ? item.keywordRoute
        : router === 'llm'
          ? item.llmRoute
          : (item.semanticRoute ?? null);
    if (!groundTruth || predicted === null) {
      continue;
    }
    groundTruthLabels.add(groundTruth);
    predictedLabels.add(predicted);
    const row = counts[groundTruth] ?? {};
    row[predicted] = (row[predicted] ?? 0) + 1;
    counts[groundTruth] = row;
    totalCount += 1;
  }

  return {
    groundTruthLabels: [...groundTruthLabels].sort((a, b) => a.localeCompare(b)),
    predictedLabels: [...predictedLabels].sort((a, b) => a.localeCompare(b)),
    counts,
    totalCount,
  };
}

export type AmbiguousRateReport = {
  /** Items where `keyword_route`/`llm_route` was present at all (present = the column has been
   * backfilled for that item, not merely non-null-checked twice). */
  keywordPresentCount: number;
  llmPresentCount: number;
  keywordAmbiguousCount: number;
  llmAmbiguousCount: number;
  keywordAmbiguousRate: number | null;
  llmAmbiguousRate: number | null;
};

/**
 * Rate at which each router gave up and reported `'ambiguous'` instead of a specialist. This is the
 * only "tie" signal recoverable from stored data: the keyword router's real tie-break detail
 * (`SmeRouteDecision.decisionPath`/`tiedCategories`, see `sme-routing.ts`) is never persisted onto
 * `test_result_items` — only the already-collapsed `keyword_route` label is. So "ambiguous rate"
 * is reported here, not a true tie rate; do not read more into it than that.
 */
export function computeAmbiguousRouteRate(
  items: Pick<RoutingComparisonReportInput, 'keywordRoute' | 'llmRoute'>[],
): AmbiguousRateReport {
  let keywordPresentCount = 0;
  let llmPresentCount = 0;
  let keywordAmbiguousCount = 0;
  let llmAmbiguousCount = 0;

  for (const item of items) {
    if (item.keywordRoute !== null) {
      keywordPresentCount += 1;
      if (item.keywordRoute === 'ambiguous') keywordAmbiguousCount += 1;
    }
    if (item.llmRoute !== null) {
      llmPresentCount += 1;
      if (item.llmRoute === 'ambiguous') llmAmbiguousCount += 1;
    }
  }

  return {
    keywordPresentCount,
    llmPresentCount,
    keywordAmbiguousCount,
    llmAmbiguousCount,
    keywordAmbiguousRate: keywordPresentCount > 0 ? keywordAmbiguousCount / keywordPresentCount : null,
    llmAmbiguousRate: llmPresentCount > 0 ? llmAmbiguousCount / llmPresentCount : null,
  };
}

/** Fixed-width buckets over `routing_confidence` (`llmClassification.confidence`, always 0–1). */
export const CONFIDENCE_DISTRIBUTION_BUCKET_LABELS = [
  '0.0–0.2',
  '0.2–0.4',
  '0.4–0.6',
  '0.6–0.8',
  '0.8–1.0',
] as const;

export type ConfidenceDistributionBucket = {
  label: (typeof CONFIDENCE_DISTRIBUTION_BUCKET_LABELS)[number];
  count: number;
};

export type ConfidenceDistribution = {
  buckets: ConfidenceDistributionBucket[];
  /** Items with no `routing_confidence` at all (pre-instrumentation rows) — excluded from buckets. */
  missingCount: number;
  totalCount: number;
};

/**
 * Buckets `routing_confidence` values into 5 fixed 0.2-wide bins. Only the LLM classifier reports a
 * confidence (`buildRoutingComparisonFields` always sets it from `llmClassification.confidence`) —
 * the keyword router has no analogous score, so this distribution is inherently LLM-only.
 */
export function computeConfidenceDistribution(
  confidences: Array<number | null | undefined>,
): ConfidenceDistribution {
  const counts = CONFIDENCE_DISTRIBUTION_BUCKET_LABELS.map(() => 0);
  let missingCount = 0;

  for (const raw of confidences) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      missingCount += 1;
      continue;
    }
    const clamped = Math.min(1, Math.max(0, raw));
    const index = Math.min(counts.length - 1, Math.floor(clamped / 0.2));
    counts[index] += 1;
  }

  return {
    buckets: CONFIDENCE_DISTRIBUTION_BUCKET_LABELS.map((label, index) => ({
      label,
      count: counts[index],
    })),
    missingCount,
    totalCount: confidences.length,
  };
}

// ---------------------------------------------------------------------------------------------
// B0-509 — RoutingComparisonDashboard (aggregate, cross-run): disagreement matrix + cutover-
// readiness. Cutover-readiness reuses `computeRoutingComparisonReport` above (fed cross-run items
// instead of one run's) — agreement rate / keyword accuracy / LLM accuracy are exactly the honest
// "is the LLM router ready" signals asked for, with nothing extra invented on top.
// ---------------------------------------------------------------------------------------------

export type RouterDisagreementMatrix = {
  /** Distinct `keyword_route` values seen among comparable items — the matrix rows. */
  keywordLabels: string[];
  /** Distinct `llm_route` values seen among comparable items — the matrix columns. */
  llmLabels: string[];
  /** `counts[keywordRoute][llmRoute]` across every item where both routers reported a route. */
  counts: Record<string, Record<string, number>>;
  /** Items where both `keyword_route` and `llm_route` are present — the denominator below. */
  comparableCount: number;
  /** Off-diagonal cells: `keyword_route !== llm_route`. */
  disagreementCount: number;
  disagreementRate: number | null;
};

/**
 * `keyword_route` (rows) vs. `llm_route` (columns) across every comparable item, independent of
 * ground truth — this is a router/router diff, not an accuracy figure (see
 * `computeRoutingComparisonReport`'s `agreementRate` for the single-number version of the same
 * comparison).
 */
export function buildRouterDisagreementMatrix(
  items: Pick<RoutingComparisonReportInput, 'keywordRoute' | 'llmRoute'>[],
): RouterDisagreementMatrix {
  const counts: Record<string, Record<string, number>> = {};
  const keywordLabels = new Set<string>();
  const llmLabels = new Set<string>();
  let comparableCount = 0;
  let disagreementCount = 0;

  for (const item of items) {
    if (item.keywordRoute === null || item.llmRoute === null) {
      continue;
    }
    comparableCount += 1;
    keywordLabels.add(item.keywordRoute);
    llmLabels.add(item.llmRoute);
    const row = counts[item.keywordRoute] ?? {};
    row[item.llmRoute] = (row[item.llmRoute] ?? 0) + 1;
    counts[item.keywordRoute] = row;
    if (item.keywordRoute !== item.llmRoute) {
      disagreementCount += 1;
    }
  }

  return {
    keywordLabels: [...keywordLabels].sort((a, b) => a.localeCompare(b)),
    llmLabels: [...llmLabels].sort((a, b) => a.localeCompare(b)),
    counts,
    comparableCount,
    disagreementCount,
    disagreementRate: comparableCount > 0 ? disagreementCount / comparableCount : null,
  };
}

/**
 * B0-668 — sibling of `RouterDisagreementMatrix` for the semantic/LLM pair (semantic router rows,
 * LLM classifier columns). A separate type + function rather than generalizing
 * `buildRouterDisagreementMatrix` itself: the keyword-vs-LLM shape (`keywordLabels`/`llmLabels`) is
 * already relied on by this file's own tests and by `page.tsx`/the dashboard, so keeping it in place
 * and adding this alongside is the least-invasive way to lead the dashboard with LLM vs. semantic
 * without touching the keyword comparison at all.
 */
export type SemanticLlmDisagreementMatrix = {
  /** Distinct `semantic_route` values seen among comparable items — the matrix rows. */
  semanticLabels: string[];
  /** Distinct `llm_route` values seen among comparable items — the matrix columns. */
  llmLabels: string[];
  /** `counts[semanticRoute][llmRoute]` across every item where both routers reported a route. */
  counts: Record<string, Record<string, number>>;
  /** Items where both `semantic_route` and `llm_route` are present — the denominator below. */
  comparableCount: number;
  /** Off-diagonal cells: `semantic_route !== llm_route`. */
  disagreementCount: number;
  disagreementRate: number | null;
};

/**
 * `semantic_route` (rows) vs. `llm_route` (columns) across every comparable item, independent of
 * ground truth — the LLM-vs-semantic counterpart to `buildRouterDisagreementMatrix`'s
 * keyword-vs-LLM matrix, now the pair the dashboard leads with.
 */
export function buildSemanticLlmDisagreementMatrix(
  items: Array<{ semanticRoute: string | null | undefined; llmRoute: string | null | undefined }>,
): SemanticLlmDisagreementMatrix {
  const counts: Record<string, Record<string, number>> = {};
  const semanticLabels = new Set<string>();
  const llmLabels = new Set<string>();
  let comparableCount = 0;
  let disagreementCount = 0;

  for (const item of items) {
    const semantic = item.semanticRoute ?? null;
    const llm = item.llmRoute ?? null;
    if (semantic === null || llm === null) {
      continue;
    }
    comparableCount += 1;
    semanticLabels.add(semantic);
    llmLabels.add(llm);
    const row = counts[semantic] ?? {};
    row[llm] = (row[llm] ?? 0) + 1;
    counts[semantic] = row;
    if (semantic !== llm) {
      disagreementCount += 1;
    }
  }

  return {
    semanticLabels: [...semanticLabels].sort((a, b) => a.localeCompare(b)),
    llmLabels: [...llmLabels].sort((a, b) => a.localeCompare(b)),
    counts,
    comparableCount,
    disagreementCount,
    disagreementRate: comparableCount > 0 ? disagreementCount / comparableCount : null,
  };
}

export type RoutingComparisonSummaryInput = {
  intendedAgentLabel: string | null;
  routingDecision: string | null;
  keywordRoute: string | null;
  llmRoute: string | null;
  /** B0-652 — undefined/null = the semantic router was not consulted for this row. */
  semanticRoute?: string | null;
};

export type RoutingComparisonSummary = {
  scoredItemCount: number;
  keywordMatchedCount: number;
  llmMatchedCount: number;
  actualMatchedCount: number;
  keywordAccuracy: number | null;
  llmAccuracy: number | null;
  actualAccuracy: number | null;
  comparableCount: number;
  agreementCount: number;
  agreementRate: number | null;
  /** B0-652 — semantic-router figures over their own (usually smaller) denominator. */
  semanticScoredItemCount: number;
  semanticMatchedCount: number;
  semanticAccuracy: number | null;
};

/**
 * Cutover-readiness summary: the same accuracy/agreement math as `computeRoutingComparisonReport`,
 * reduced from a cross-run row shape instead of one run's items. Deliberately a separate, leaner
 * input/output pair (no `resultItemId`/`testItemId`/`rowIndex`/`prompt`, no `mismatches`) rather than
 * reusing `RoutingComparisonReportInput` with faked-out identifiers — the aggregate dashboard never
 * drills into individual items, so there is nothing honest to put in those fields.
 */
export function computeRoutingComparisonSummary(
  items: RoutingComparisonSummaryInput[],
): RoutingComparisonSummary {
  let scoredItemCount = 0;
  let keywordMatchedCount = 0;
  let llmMatchedCount = 0;
  let actualMatchedCount = 0;
  let comparableCount = 0;
  let agreementCount = 0;
  let semanticScoredItemCount = 0;
  let semanticMatchedCount = 0;

  for (const item of items) {
    if (item.keywordRoute !== null && item.llmRoute !== null) {
      comparableCount += 1;
      if (item.keywordRoute === item.llmRoute) {
        agreementCount += 1;
      }
    }

    const label = item.intendedAgentLabel;
    if (!label) {
      continue;
    }

    scoredItemCount += 1;
    if (item.keywordRoute === label) keywordMatchedCount += 1;
    if (item.llmRoute === label) llmMatchedCount += 1;
    if (item.routingDecision === label) actualMatchedCount += 1;
    if (item.semanticRoute !== undefined && item.semanticRoute !== null) {
      semanticScoredItemCount += 1;
      if (item.semanticRoute === label) semanticMatchedCount += 1;
    }
  }

  return {
    scoredItemCount,
    keywordMatchedCount,
    llmMatchedCount,
    actualMatchedCount,
    keywordAccuracy: scoredItemCount > 0 ? keywordMatchedCount / scoredItemCount : null,
    llmAccuracy: scoredItemCount > 0 ? llmMatchedCount / scoredItemCount : null,
    actualAccuracy: scoredItemCount > 0 ? actualMatchedCount / scoredItemCount : null,
    comparableCount,
    agreementCount,
    agreementRate: comparableCount > 0 ? agreementCount / comparableCount : null,
    semanticScoredItemCount,
    semanticMatchedCount,
    semanticAccuracy:
      semanticScoredItemCount > 0 ? semanticMatchedCount / semanticScoredItemCount : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Latency profile — B0-524. Measured at the run-executor.ts call sites into
// keyword_route_latency_ms/llm_route_latency_ms; this reduces a set of rows into per-router
// median/p95, so the dashboard has a real comparison instead of the "not available yet" placeholder.
// ---------------------------------------------------------------------------------------------

export type RouterLatencyStats = {
  sampleCount: number;
  medianMs: number | null;
  p95Ms: number | null;
};

export type RouterLatencyProfile = {
  keyword: RouterLatencyStats;
  llm: RouterLatencyStats;
};

/**
 * B0-652 — p50/p95/p99 (plus min/max) over one latency sample set. The percentile formula is the
 * one `computeLatencyStats` has always used (nearest-rank, `floor(p * n)` clamped to the last
 * index); this is the single implementation both the B0-524 two-router profile and the B0-652
 * semantic distribution now go through, so a keyword p95 and a semantic p95 mean the same thing.
 */
export type LatencyDistribution = {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
};

export function computeLatencyDistribution(samples: number[]): LatencyDistribution {
  if (samples.length === 0) {
    return { sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    sampleCount: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

/** Kept at its original three-field shape so B0-509's dashboard and its tests are untouched. */
function computeLatencyStats(samples: number[]): RouterLatencyStats {
  const distribution = computeLatencyDistribution(samples);
  return {
    sampleCount: distribution.sampleCount,
    medianMs: distribution.p50Ms,
    p95Ms: distribution.p95Ms,
  };
}

/** Keeps only real, finite measurements — a missing measurement is not a fast one. */
function finiteSamples(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

/**
 * Reduces a set of `test_result_items` rows into a per-router latency profile. Rows predating
 * B0-524 (or where a call site couldn't measure) have `null` latency and are excluded from the
 * sample rather than treated as zero — a missing measurement is not a fast one.
 */
export function computeRouterLatencyProfile(
  items: Array<{ keywordRouteLatencyMs: number | null; llmRouteLatencyMs: number | null }>,
): RouterLatencyProfile {
  return {
    keyword: computeLatencyStats(finiteSamples(items.map((item) => item.keywordRouteLatencyMs))),
    llm: computeLatencyStats(finiteSamples(items.map((item) => item.llmRouteLatencyMs))),
  };
}

/** B0-668 — sibling of `RouterLatencyProfile` for the semantic/LLM pair. */
export type SemanticLlmLatencyProfile = {
  semantic: RouterLatencyStats;
  llm: RouterLatencyStats;
};

/**
 * Reduces a set of `test_result_items` rows into a semantic-vs-LLM latency profile, mirroring
 * `computeRouterLatencyProfile`'s keyword-vs-LLM one exactly (same median/p95 shape, same
 * missing-measurement handling) so the two profiles read the same way on the dashboard.
 */
export function computeSemanticLlmLatencyProfile(
  items: Array<{
    semanticRouteLatencyMs: number | null | undefined;
    llmRouteLatencyMs: number | null | undefined;
  }>,
): SemanticLlmLatencyProfile {
  return {
    semantic: computeLatencyStats(finiteSamples(items.map((item) => item.semanticRouteLatencyMs))),
    llm: computeLatencyStats(finiteSamples(items.map((item) => item.llmRouteLatencyMs))),
  };
}

// ---------------------------------------------------------------------------------------------
// B0-652 — semantic-router accuracy / false-positive / fallback / latency reducers.
//
// Everything below is a pure reducer over already-measured rows, in the same spirit as the B0-502
// and B0-509 blocks above: the semantic router is called once per item at the run-executor.ts call
// site (or by the golden-set harness), and its raw output plus ground truth is reduced here. No
// reducer in this block imports the router module, so all of it is testable without an embedding
// call.
// ---------------------------------------------------------------------------------------------

export type SemanticRoutingItem = {
  /** Ground truth (`intended_agent_label`); null = unlabeled, excluded from every accuracy figure. */
  intendedAgentLabel: string | null;
  /**
   * Golden-set lenient grading: every label a reasonable router could pick for this prompt without
   * being wrong (`orchestrator-intent-labels.json`'s `plausible_agents`, always containing
   * `intended_agent`). Null/omitted = no lenient grading available for this item, in which case it
   * is graded strictly in BOTH modes rather than being silently credited or dropped.
   */
  plausibleAgentLabels?: string[] | null;
  semanticRoute: string | null;
  /** `'semantic'` = both thresholds passed; `'fallback'` = the router declined. */
  semanticPath?: string | null;
  semanticRouteLatencyMs?: number | null;
  semanticEmbeddingMs?: number | null;
  semanticScoringMs?: number | null;
};

export type SemanticRoutingAccuracy = {
  /** Items with ground truth AND a semantic route — the denominator for both accuracies. */
  scoredItemCount: number;
  /** `semanticRoute === intendedAgentLabel`. */
  strictMatchedCount: number;
  /** `plausibleAgentLabels.includes(semanticRoute)` — falls back to the strict test when the item
   * carries no plausible list, so lenient is never *lower* than strict but is also never invented. */
  lenientMatchedCount: number;
  strictAccuracy: number | null;
  lenientAccuracy: number | null;
};

function matchesStrict(item: SemanticRoutingItem, label: string): boolean {
  return item.semanticRoute === label;
}

function matchesLenient(item: SemanticRoutingItem, label: string): boolean {
  const plausible = item.plausibleAgentLabels;
  if (!plausible || plausible.length === 0) {
    return matchesStrict(item, label);
  }
  return item.semanticRoute !== null && plausible.includes(item.semanticRoute);
}

/** Scored items = ground truth present AND the semantic router actually reported a route. */
function scorableSemanticItems(items: SemanticRoutingItem[]): Array<SemanticRoutingItem & { label: string }> {
  return items.flatMap((item) =>
    item.intendedAgentLabel && item.semanticRoute !== null
      ? [{ ...item, label: item.intendedAgentLabel }]
      : [],
  );
}

export function computeSemanticRoutingAccuracy(items: SemanticRoutingItem[]): SemanticRoutingAccuracy {
  const scored = scorableSemanticItems(items);
  let strictMatchedCount = 0;
  let lenientMatchedCount = 0;

  for (const item of scored) {
    if (matchesStrict(item, item.label)) strictMatchedCount += 1;
    if (matchesLenient(item, item.label)) lenientMatchedCount += 1;
  }

  return {
    scoredItemCount: scored.length,
    strictMatchedCount,
    lenientMatchedCount,
    strictAccuracy: scored.length > 0 ? strictMatchedCount / scored.length : null,
    lenientAccuracy: scored.length > 0 ? lenientMatchedCount / scored.length : null,
  };
}

export type SemanticRoutePerRouteAccuracy = {
  /** The ground-truth route these items belong to (a row of the confusion matrix). */
  groundTruthLabel: string;
  itemCount: number;
  strictMatchedCount: number;
  lenientMatchedCount: number;
  strictAccuracy: number;
  lenientAccuracy: number;
};

/**
 * Per-ground-truth-route accuracy ("accuracy reported per route", B0-652 DoD). Sorted by label so
 * two runs' tables line up. Routes with zero scored items are absent rather than shown as 0% —
 * "no data" and "always wrong" must not render identically.
 */
export function computeSemanticRoutingAccuracyByRoute(
  items: SemanticRoutingItem[],
): SemanticRoutePerRouteAccuracy[] {
  const byLabel = new Map<string, Array<SemanticRoutingItem & { label: string }>>();
  for (const item of scorableSemanticItems(items)) {
    const list = byLabel.get(item.label) ?? [];
    list.push(item);
    byLabel.set(item.label, list);
  }

  return [...byLabel.entries()]
    .map(([groundTruthLabel, group]) => {
      const strictMatchedCount = group.filter((item) => matchesStrict(item, item.label)).length;
      const lenientMatchedCount = group.filter((item) => matchesLenient(item, item.label)).length;
      return {
        groundTruthLabel,
        itemCount: group.length,
        strictMatchedCount,
        lenientMatchedCount,
        strictAccuracy: strictMatchedCount / group.length,
        lenientAccuracy: lenientMatchedCount / group.length,
      };
    })
    .sort((a, b) => a.groundTruthLabel.localeCompare(b.groundTruthLabel));
}

export type SemanticFalsePositiveReport = {
  /**
   * Items with ground truth where `semanticPath === 'semantic'` — i.e. BOTH the confidence and
   * margin thresholds passed, so the router committed to a route instead of declining. This is the
   * denominator of `falsePositiveRate`.
   */
  confidentItemCount: number;
  /**
   * FALSE POSITIVE, defined exactly: `semanticPath === 'semantic'` (the router was confident) AND
   * `semanticRoute !== intendedAgentLabel` (it was wrong). A wrong route on the `'fallback'` path is
   * NOT a false positive — the router already reported low confidence, so downstream code is free to
   * distrust it; that case is counted by the fallback rate instead. "Confidently wrong" is
   * meaningless without pinning down which of those two populations you mean, so both are reported.
   */
  falsePositiveCount: number;
  /** `falsePositiveCount / confidentItemCount` — wrongness among the routes the router stood behind. */
  falsePositiveRate: number | null;
  /** Items with ground truth and a path, confident or not — the denominator below. */
  scoredItemCount: number;
  /** `falsePositiveCount / scoredItemCount` — the same numerator over ALL scored items, which is a
   * different (always lower or equal) number. Reported so a "<5%" target can't be read off the
   * denominator that happens to flatter it. */
  falsePositiveRateOfScored: number | null;
};

export function computeSemanticFalsePositiveRate(
  items: SemanticRoutingItem[],
): SemanticFalsePositiveReport {
  let confidentItemCount = 0;
  let falsePositiveCount = 0;
  let scoredItemCount = 0;

  for (const item of items) {
    const label = item.intendedAgentLabel;
    if (!label || !item.semanticPath) {
      continue;
    }
    scoredItemCount += 1;
    if (item.semanticPath !== 'semantic') {
      continue;
    }
    confidentItemCount += 1;
    if (item.semanticRoute !== label) {
      falsePositiveCount += 1;
    }
  }

  return {
    confidentItemCount,
    falsePositiveCount,
    falsePositiveRate: confidentItemCount > 0 ? falsePositiveCount / confidentItemCount : null,
    scoredItemCount,
    falsePositiveRateOfScored: scoredItemCount > 0 ? falsePositiveCount / scoredItemCount : null,
  };
}

export type SemanticFallbackReport = {
  /** Items where the semantic router reported a path at all (it was consulted and returned). */
  pathPresentCount: number;
  /** `semanticPath === 'fallback'` — one or both thresholds failed, or the router errored out. */
  fallbackCount: number;
  fallbackRate: number | null;
};

/**
 * How often the router declined rather than committing. Deliberately independent of ground truth:
 * a fallback is a fallback whether or not the item happens to be labeled, and mixing the two would
 * make the rate move when the golden set's labeling changes.
 */
export function computeSemanticFallbackRate(items: SemanticRoutingItem[]): SemanticFallbackReport {
  let pathPresentCount = 0;
  let fallbackCount = 0;

  for (const item of items) {
    if (!item.semanticPath) continue;
    pathPresentCount += 1;
    if (item.semanticPath === 'fallback') fallbackCount += 1;
  }

  return {
    pathPresentCount,
    fallbackCount,
    fallbackRate: pathPresentCount > 0 ? fallbackCount / pathPresentCount : null,
  };
}

export type SemanticLatencyProfile = {
  /** End-to-end wait: embedding round-trip + scoring. Cold routes are network-bound (~80-400ms). */
  total: LatencyDistribution;
  /** The embedding round-trip alone. */
  embedding: LatencyDistribution;
  /** Cosine scoring alone — no I/O. The only component a single-digit-ms budget applies to. */
  scoring: LatencyDistribution;
};

/**
 * Splits the latency distribution three ways on purpose. B0-652's "≤10ms p95" target is only
 * meaningful against `scoring` (or a warm embedding cache); quoting it against `total` would either
 * look like a failure or require pretending the OpenAI call didn't happen.
 */
export function computeSemanticLatencyProfile(items: SemanticRoutingItem[]): SemanticLatencyProfile {
  return {
    total: computeLatencyDistribution(finiteSamples(items.map((item) => item.semanticRouteLatencyMs))),
    embedding: computeLatencyDistribution(finiteSamples(items.map((item) => item.semanticEmbeddingMs))),
    scoring: computeLatencyDistribution(finiteSamples(items.map((item) => item.semanticScoringMs))),
  };
}

export type ThreeWayAgreementReport = {
  /** Items where at least two of the three routers reported a route (the denominator). */
  comparableCount: number;
  /** Counts per `RoutingAgreement` label; every label is present, zero-filled. */
  counts: Record<RoutingAgreement, number>;
  /** `counts.all_agree / comparableCount`. */
  allAgreeRate: number | null;
};

/**
 * Three-way keyword/LLM/semantic agreement, alongside (not replacing) the existing two-way
 * `agreementRate` in `computeRoutingComparisonReport`. Uses `computeRoutingAgreement`, so an item
 * with fewer than two routes present is excluded rather than counted as a disagreement.
 */
export function computeThreeWayAgreement(
  items: Array<{
    keywordRoute: string | null | undefined;
    llmRoute: string | null | undefined;
    semanticRoute: string | null | undefined;
  }>,
): ThreeWayAgreementReport {
  const counts = Object.fromEntries(ROUTING_AGREEMENT_VALUES.map((value) => [value, 0])) as Record<
    RoutingAgreement,
    number
  >;
  let comparableCount = 0;

  for (const item of items) {
    const agreement = computeRoutingAgreement(item);
    if (!agreement) continue;
    comparableCount += 1;
    counts[agreement] += 1;
  }

  return {
    comparableCount,
    counts,
    allAgreeRate: comparableCount > 0 ? counts.all_agree / comparableCount : null,
  };
}

export type SemanticRoutingReport = {
  accuracy: SemanticRoutingAccuracy;
  accuracyByRoute: SemanticRoutePerRouteAccuracy[];
  falsePositives: SemanticFalsePositiveReport;
  fallback: SemanticFallbackReport;
  latency: SemanticLatencyProfile;
};

/** One call for the whole B0-652 measurement set, so callers can't accidentally report a subset. */
export function computeSemanticRoutingReport(items: SemanticRoutingItem[]): SemanticRoutingReport {
  return {
    accuracy: computeSemanticRoutingAccuracy(items),
    accuracyByRoute: computeSemanticRoutingAccuracyByRoute(items),
    falsePositives: computeSemanticFalsePositiveRate(items),
    fallback: computeSemanticFallbackRate(items),
    latency: computeSemanticLatencyProfile(items),
  };
}
