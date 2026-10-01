/**
 * B0-1110 — the ONE way a run's items are loaded for execution, grading, report assembly and run
 * comparison.
 *
 * `test_results.item_scope` (B0-1100) is `null` for every full run — the run covers every item on
 * the test, exactly as before — and a `test_items.id[]` for a partial run (B0-1102), which covers
 * only those rows. Loading by `test_id` alone on any of those paths would execute, grade or diff
 * the whole set, so those callers go through here and nowhere else.
 */
import { logWarn } from '~/lib/observability/logger';
import { getTestItemsByTestId } from '~/lib/tests/repository';
import type { TestItemRecord, TestResultRecord } from '~/lib/tests/types';

export type RunItemScopeSource = Pick<TestResultRecord, 'id' | 'test_id' | 'item_scope'>;

/**
 * Every item on the run's test when `item_scope` is null; otherwise the scoped subset, in dataset
 * (`row_index`) order as `getTestItemsByTestId` returns it. Scope ids that no longer exist on the
 * test (deleted or moved since the run was created) are dropped and logged, never thrown — a run
 * must still complete over whatever remains.
 */
export async function resolveRunItems(run: RunItemScopeSource): Promise<TestItemRecord[]> {
  const items = await getTestItemsByTestId(run.test_id);
  if (run.item_scope === null || run.item_scope === undefined) {
    return items;
  }

  const scope = new Set(run.item_scope);
  const scoped = items.filter((item) => scope.has(item.id));

  if (scoped.length !== scope.size) {
    const found = new Set(scoped.map((item) => item.id));
    const missingItemIds = [...scope].filter((id) => !found.has(id));
    logWarn('test_run_item_scope_missing_items', {
      testResultId: run.id,
      testId: run.test_id,
      scopeSize: scope.size,
      resolvedCount: scoped.length,
      missingItemIds,
    });
  }

  return scoped;
}
