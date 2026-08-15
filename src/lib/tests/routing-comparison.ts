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
