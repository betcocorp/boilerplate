import { resolveCategory, type TaxonomyNode } from '~/lib/category/category-resolver';
import { classifyCategoryRoute } from '~/lib/category/category-router';
import type { RoutingEvalCase } from '~/lib/category/eval/routing-eval-dataset';

/**
 * B0-32 — Pure precision/recall eval for the category-first routing decision.
 *
 * Treats "category" as the positive class: a query the router should short-circuit to the
 * deterministic taxonomy. Runs the real `resolveCategory` (name/alias matching) + the real
 * `classifyCategoryRoute` gate against a labeled set, so it exercises production routing logic with
 * no DB. Deterministic → runnable in CI.
 */

export type RoutingMetrics = {
  threshold: number;
  total: number;
  truePositives: number; // expected category, routed category
  falsePositives: number; // expected semantic, routed category
  falseNegatives: number; // expected category, routed semantic
  trueNegatives: number; // expected semantic, routed semantic
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
};

export type RoutingCaseResult = {
  query: string;
  expectedPath: 'category' | 'semantic';
  routedPath: 'category' | 'semantic';
  confidence: number | null;
  correct: boolean;
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 1000;
}

export function evaluateRoutingCases(
  dataset: RoutingEvalCase[],
  nodes: TaxonomyNode[],
  threshold: number,
): RoutingCaseResult[] {
  return dataset.map((item) => {
    const matches = resolveCategory(item.query, nodes, { limit: 3 });
    const decision = classifyCategoryRoute(matches, threshold);
    const routedPath = decision.decision === 'category' ? 'category' : 'semantic';
    const confidence =
      decision.decision === 'category' ? decision.match.confidence : decision.top?.confidence ?? null;
    return {
      query: item.query,
      expectedPath: item.expectedPath,
      routedPath,
      confidence,
      correct: routedPath === item.expectedPath,
    };
  });
}

export function evaluateRouting(
  dataset: RoutingEvalCase[],
  nodes: TaxonomyNode[],
  threshold: number,
): RoutingMetrics {
  const results = evaluateRoutingCases(dataset, nodes, threshold);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const r of results) {
    if (r.expectedPath === 'category' && r.routedPath === 'category') tp += 1;
    else if (r.expectedPath === 'semantic' && r.routedPath === 'category') fp += 1;
    else if (r.expectedPath === 'category' && r.routedPath === 'semantic') fn += 1;
    else tn += 1;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision + recall === 0 ? 0 : ratio(2 * precision * recall, precision + recall);
  return {
    threshold,
    total: results.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision,
    recall,
    f1,
    accuracy: ratio(tp + tn, results.length),
  };
}

/** Sweep a set of thresholds to show the precision/recall trade-off. */
export function sweepRoutingThresholds(
  dataset: RoutingEvalCase[],
  nodes: TaxonomyNode[],
  thresholds: number[],
): RoutingMetrics[] {
  return thresholds.map((t) => evaluateRouting(dataset, nodes, t));
}
