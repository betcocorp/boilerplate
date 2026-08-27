/**
 * B0-313 — pure diff between a run and its previous completed run, for the post-mortem comparison
 * feature (Phase 1 of epic B0-310). Same split as `routing-comparison.ts` / `tool-routing.ts`: a
 * pure reducer here, I/O (fetching both runs' items, persisting the result) in
 * `~/lib/tests/run-comparison.ts` / `repository.ts`.
 *
 * Deliberately narrow, structural input types (not the full `TestResultItemRecord`) so this stays
 * unit-testable with plain object literals — mirrors `SemanticRouteInstrumentation` in
 * `routing-comparison.ts`.
 *
 * Shape is intentionally flat and stays that way: a future category/agent breakdown (out of scope
 * here, tracked separately) can add optional fields without touching what's already persisted.
 */
import type { TestResultItemRecord } from './types';

export type ComparisonResultItem = Pick<
  TestResultItemRecord,
  'id' | 'test_item_id' | 'row_index' | 'passed' | 'error_message'
>;

export type ComparisonCaseRef = {
  resultItemId: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
  errorMessage: string | null;
};

export type RunComparisonDiff = {
  currentPassRate: number;
  previousPassRate: number;
  /** currentPassRate - previousPassRate, in the same 0-1 fraction space as both rates. */
  scoreDelta: number;
  /** Passed in the previous run, failing now. */
  newFailures: ComparisonCaseRef[];
  /** Failed in the previous run, passing now. */
  fixes: ComparisonCaseRef[];
};

function passRate(items: ComparisonResultItem[]): number {
  return items.length > 0 ? items.filter((item) => item.passed).length / items.length : 0;
}

function toCaseRef(item: ComparisonResultItem, promptByTestItemId: Map<string, string>): ComparisonCaseRef {
  return {
    resultItemId: item.id,
    testItemId: item.test_item_id,
    rowIndex: item.row_index,
    prompt: promptByTestItemId.get(item.test_item_id) ?? '',
    errorMessage: item.error_message ?? null,
  };
}

/**
 * Diffs `currentItems` against `previousItems`, matched by `test_item_id` (the stable identity of a
 * prompt across runs — `test_result_items.id` is per-run). A test item present in one run but not
 * the other (dataset edited between runs) is skipped rather than counted as a failure or fix — there
 * is nothing to compare it against.
 */
export function computeRunComparisonDiff(params: {
  currentItems: ComparisonResultItem[];
  previousItems: ComparisonResultItem[];
  promptByTestItemId: Map<string, string>;
}): RunComparisonDiff {
  const { currentItems, previousItems, promptByTestItemId } = params;
  const previousByTestItemId = new Map(previousItems.map((item) => [item.test_item_id, item]));

  const newFailures: ComparisonCaseRef[] = [];
  const fixes: ComparisonCaseRef[] = [];

  for (const current of currentItems) {
    const previous = previousByTestItemId.get(current.test_item_id);
    if (!previous) {
      continue;
    }

    if (previous.passed && !current.passed) {
      newFailures.push(toCaseRef(current, promptByTestItemId));
    } else if (!previous.passed && current.passed) {
      fixes.push(toCaseRef(current, promptByTestItemId));
    }
  }

  return {
    currentPassRate: passRate(currentItems),
    previousPassRate: passRate(previousItems),
    scoreDelta: passRate(currentItems) - passRate(previousItems),
    newFailures,
    fixes,
  };
}
