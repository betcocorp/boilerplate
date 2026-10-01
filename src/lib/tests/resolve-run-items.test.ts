import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/observability/logger', () => ({ logWarn: vi.fn() }));
vi.mock('~/lib/tests/repository', () => ({ getTestItemsByTestId: vi.fn() }));

import { logWarn } from '~/lib/observability/logger';
import { getTestItemsByTestId } from '~/lib/tests/repository';
import type { TestItemRecord } from '~/lib/tests/types';

import { resolveRunItems } from './resolve-run-items';

/**
 * B0-1110 — the single item resolver behind the executor, the report grader, the report assembler
 * and the run comparison. What is pinned: a null scope is today's behaviour untouched, a scope is
 * honoured in dataset order regardless of the order the ids were stored in, and a scope id that no
 * longer exists is dropped and logged rather than thrown.
 */

const TEST_ID = '99999999-8888-7777-6666-555555555555';
const RUN_ID = '11111111-2222-3333-4444-555555555555';

const ITEMS = ['a', 'b', 'c', 'd'].map(
  (id, row_index) => ({ id, row_index, test_id: TEST_ID }) as unknown as TestItemRecord,
);

describe('resolveRunItems (B0-1110)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTestItemsByTestId).mockResolvedValue(ITEMS);
  });

  it('returns every item on the test, untouched, when item_scope is null', async () => {
    const items = await resolveRunItems({ id: RUN_ID, test_id: TEST_ID, item_scope: null });

    expect(items).toBe(ITEMS);
    expect(getTestItemsByTestId).toHaveBeenCalledWith(TEST_ID);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('returns only the scoped subset, in dataset order rather than scope order', async () => {
    const items = await resolveRunItems({ id: RUN_ID, test_id: TEST_ID, item_scope: ['d', 'b'] });

    expect(items.map((item) => item.id)).toEqual(['b', 'd']);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('drops scope ids that no longer exist on the test and logs them', async () => {
    const items = await resolveRunItems({
      id: RUN_ID,
      test_id: TEST_ID,
      item_scope: ['c', 'gone-1', 'a', 'gone-2'],
    });

    expect(items.map((item) => item.id)).toEqual(['a', 'c']);
    expect(logWarn).toHaveBeenCalledWith('test_run_item_scope_missing_items', {
      testResultId: RUN_ID,
      testId: TEST_ID,
      scopeSize: 4,
      resolvedCount: 2,
      missingItemIds: ['gone-1', 'gone-2'],
    });
  });

  it('resolves an empty scope to no items (never the whole set)', async () => {
    const items = await resolveRunItems({ id: RUN_ID, test_id: TEST_ID, item_scope: [] });

    expect(items).toEqual([]);
    expect(logWarn).not.toHaveBeenCalled();
  });
});
