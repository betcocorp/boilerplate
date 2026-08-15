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

export type RoutingComparisonFields = {
  keyword_route: RoutingLabel;
  llm_route: RoutingLabel;
  routing_confidence: number;
  intended_agent_label: string | null;
};

/**
 * Builds the four B0-501-computed `test_result_items` columns (`routing_decision` is not among
 * them — it is generated from `response_payload`, not written by this instrumentation) from one
 * keyword decision + one LLM classification + the resolved ground-truth label.
 */
export function buildRoutingComparisonFields(params: {
  keywordDecision: Pick<SmeRouteDecision, 'agent'>;
  llmClassification: Pick<IntentClassification, 'intent' | 'confidence'>;
  intendedAgentLabel: string | null;
}): RoutingComparisonFields {
  return {
    keyword_route: normalizeKeywordRoute(params.keywordDecision),
    llm_route: params.llmClassification.intent,
    routing_confidence: params.llmClassification.confidence,
    intended_agent_label: params.intendedAgentLabel,
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
};

export type RoutingComparisonReport = {
  /** Items with `intendedAgentLabel` set — the denominator for every accuracy figure below. */
  scoredItemCount: number;
  keywordMatchedCount: number;
  llmMatchedCount: number;
  actualMatchedCount: number;
  /** `keywordMatchedCount / scoredItemCount`, or null when nothing in the run has ground truth. */
  keywordAccuracy: number | null;
  llmAccuracy: number | null;
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

    if (!keywordMatch || !llmMatch) {
      mismatches.push({
        resultItemId: item.resultItemId,
        testItemId: item.testItemId,
        rowIndex: item.rowIndex,
        prompt: item.prompt,
        intendedAgentLabel: label,
        keywordRoute: item.keywordRoute,
        llmRoute: item.llmRoute,
        routingDecision: item.routingDecision,
      });
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

export type RouterKey = 'keyword' | 'llm';

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
  items: Pick<RoutingComparisonReportInput, 'intendedAgentLabel' | 'keywordRoute' | 'llmRoute'>[],
  router: RouterKey,
): ConfusionMatrix {
  const counts: Record<string, Record<string, number>> = {};
  const groundTruthLabels = new Set<string>();
  const predictedLabels = new Set<string>();
  let totalCount = 0;

  for (const item of items) {
    const groundTruth = item.intendedAgentLabel;
    const predicted = router === 'keyword' ? item.keywordRoute : item.llmRoute;
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

export type RoutingComparisonSummaryInput = {
  intendedAgentLabel: string | null;
  routingDecision: string | null;
  keywordRoute: string | null;
  llmRoute: string | null;
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
  };
}
