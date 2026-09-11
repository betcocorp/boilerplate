import { describe, expect, it } from 'vitest';

import {
  SCHEDULED_ITEM_STALE_AFTER_MS,
  SCHEDULED_ITEM_TIMED_OUT_ERROR,
  buildScheduledRunPatch,
  reconcileScheduledTests,
  reconcileScheduledTestsResultSchema,
  resolveScheduledItemPatch,
  type ReconcilerTestRun,
  type ScheduledItemTally,
  type ScheduledTestReconcilerPort,
} from '~/lib/observability/reconcile-scheduled-tests';
import type {
  ScheduledTestItem,
  ScheduledTestRun,
} from '~/lib/observability/scheduled-test-types';
import type {
  ScheduledTestItemPatch,
  ScheduledTestRunPatch,
} from '~/lib/observability/scheduled-test-repository';

const NOW_ISO = '2026-09-11T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

function isoAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function item(overrides: Partial<ScheduledTestItem> = {}): ScheduledTestItem {
  return {
    id: 'item-1',
    scheduled_run_id: 'sweep-1',
    test_id: 'test-1',
    test_name: 'Golden — dilution',
    test_run_id: 'run-1',
    status: 'running',
    started_at: isoAgo(10 * 60 * 1000),
    completed_at: null,
    elapsed_ms: null,
    items_total: null,
    items_passed: null,
    items_failed: null,
    pass_rate: null,
    grade: null,
    confidence: null,
    error_code: null,
    error_message: null,
    error_details: null,
    retry_count: 0,
    last_retry_at: null,
    claimed_by: null,
    created_at: isoAgo(10 * 60 * 1000),
    updated_at: isoAgo(10 * 60 * 1000),
    ...overrides,
  };
}

function parentRun(overrides: Partial<ScheduledTestRun> = {}): ScheduledTestRun {
  return {
    id: 'sweep-1',
    sweep_name: 'golden_test_sweep',
    sweep_triggered_at: isoAgo(30 * 60 * 1000),
    status: 'in_progress',
    error_message: null,
    started_at: isoAgo(30 * 60 * 1000),
    completed_at: null,
    elapsed_ms: null,
    total_tests: 1,
    successful_tests: 0,
    failed_tests: 0,
    timed_out_tests: 0,
    success_rate: null,
    avg_elapsed_ms: null,
    metadata: { origin: 'https://bex.example.com' },
    created_at: isoAgo(30 * 60 * 1000),
    updated_at: isoAgo(30 * 60 * 1000),
    ...overrides,
  };
}

function testRun(overrides: Partial<ReconcilerTestRun> = {}): ReconcilerTestRun {
  return {
    id: 'run-1',
    status: 'completed',
    started_at: isoAgo(10 * 60 * 1000),
    completed_at: isoAgo(4 * 60 * 1000),
    elapsed_ms: 360_000,
    ...overrides,
  };
}

type Recorded = {
  itemUpdates: { id: string; patch: ScheduledTestItemPatch }[];
  runUpdates: { id: string; patch: ScheduledTestRunPatch }[];
};

function stubPort(options: {
  items?: ScheduledTestItem[];
  runs?: ReconcilerTestRun[];
  tallies?: ScheduledItemTally[];
  parents?: ScheduledTestRun[];
  /** Children the parent rollup sees (defaults to `items` with the recorded patches applied). */
  siblings?: ScheduledTestItem[];
  failItemIds?: Set<string>;
}): { port: ScheduledTestReconcilerPort; recorded: Recorded } {
  const recorded: Recorded = { itemUpdates: [], runUpdates: [] };
  const items = options.items ?? [];

  const port: ScheduledTestReconcilerPort = {
    async listNonTerminalItems() {
      return items;
    },
    async listTestRuns() {
      return options.runs ?? [];
    },
    async listItemTallies() {
      return options.tallies ?? [];
    },
    async updateItem(id, patch) {
      if (options.failItemIds?.has(id)) {
        throw new Error(`write rejected for ${id}`);
      }
      recorded.itemUpdates.push({ id, patch });
    },
    async listItemsForScheduledRuns() {
      if (options.siblings) {
        return options.siblings;
      }
      return items.map((row) => {
        const update = recorded.itemUpdates.find((entry) => entry.id === row.id);
        return update ? ({ ...row, ...update.patch } as ScheduledTestItem) : row;
      });
    },
    async listScheduledRuns() {
      return options.parents ?? [parentRun()];
    },
    async updateRun(id, patch) {
      recorded.runUpdates.push({ id, patch });
    },
  };

  return { port, recorded };
}

const deps = (port: ScheduledTestReconcilerPort) => ({ port, now: () => NOW_MS });

describe('resolveScheduledItemPatch', () => {
  it('maps a completed test run onto the child with its pass counts', () => {
    const patch = resolveScheduledItemPatch({
      item: item(),
      run: testRun({ status: 'completed' }),
      tally: { test_run_id: 'run-1', items_total: 20, items_passed: 15, items_failed: 5 },
      nowMs: NOW_MS,
      staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
    });

    expect(patch).toMatchObject({
      status: 'completed',
      completed_at: isoAgo(4 * 60 * 1000),
      items_total: 20,
      items_passed: 15,
      items_failed: 5,
      pass_rate: 0.75,
    });
    // started 10m before "now", finished 4m before "now" → 6 minutes.
    expect(patch?.elapsed_ms).toBe(6 * 60 * 1000);
  });

  it('treats `completed_with_failures` as a completed run', () => {
    const patch = resolveScheduledItemPatch({
      item: item(),
      run: testRun({ status: 'completed_with_failures' }),
      tally: null,
      nowMs: NOW_MS,
      staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
    });

    expect(patch?.status).toBe('completed');
  });

  it('maps a failed test run onto the child with an error code', () => {
    const patch = resolveScheduledItemPatch({
      item: item(),
      run: testRun({ status: 'failed' }),
      tally: null,
      nowMs: NOW_MS,
      staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
    });

    expect(patch).toMatchObject({ status: 'failed', error_code: 'run_failed' });
  });

  it('leaves a child alone while its run is still executing', () => {
    expect(
      resolveScheduledItemPatch({
        item: item(),
        run: testRun({ status: 'running', completed_at: null }),
        tally: null,
        nowMs: NOW_MS,
        staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
      }),
    ).toBeNull();
  });

  it('leaves a child with no `test_run_id` alone until it goes stale', () => {
    const fresh = item({ test_run_id: null, started_at: isoAgo(5 * 60 * 1000) });
    expect(
      resolveScheduledItemPatch({
        item: fresh,
        run: null,
        tally: null,
        nowMs: NOW_MS,
        staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
      }),
    ).toBeNull();

    const stale = item({
      test_run_id: null,
      started_at: isoAgo(SCHEDULED_ITEM_STALE_AFTER_MS + 60_000),
    });
    expect(
      resolveScheduledItemPatch({
        item: stale,
        run: null,
        tally: null,
        nowMs: NOW_MS,
        staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
      }),
    ).toMatchObject({
      status: 'timed_out',
      error_code: SCHEDULED_ITEM_TIMED_OUT_ERROR,
    });
  });

  it('never times out a child whose clock skew makes it look older than it is', () => {
    // `started_at` is Postgres `now()`, the caller's clock is Node's; a fresh row can read
    // "in the future". `stalledForMs` clamps at 0, so this must stay pending.
    const future = item({ started_at: new Date(NOW_MS + 13_500).toISOString() });
    expect(
      resolveScheduledItemPatch({
        item: future,
        run: null,
        tally: null,
        nowMs: NOW_MS,
        staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
      }),
    ).toBeNull();
  });
});

describe('buildScheduledRunPatch', () => {
  it('completes the parent once every child is terminal', () => {
    const { patch, completed } = buildScheduledRunPatch(
      parentRun({ total_tests: 2 }),
      [
        item({ id: 'a', status: 'completed', elapsed_ms: 1000 }),
        item({ id: 'b', status: 'failed', elapsed_ms: 3000 }),
      ],
      NOW_MS,
    );

    expect(completed).toBe(true);
    expect(patch).toMatchObject({
      status: 'completed',
      completed_at: NOW_ISO,
      total_tests: 2,
      successful_tests: 1,
      failed_tests: 1,
      timed_out_tests: 0,
      success_rate: 0.5,
      avg_elapsed_ms: 2000,
      elapsed_ms: 30 * 60 * 1000,
    });
  });

  it('leaves the parent in progress while any child is still running', () => {
    const { patch, completed } = buildScheduledRunPatch(
      parentRun({ total_tests: 2 }),
      [item({ id: 'a', status: 'completed' }), item({ id: 'b', status: 'running' })],
      NOW_MS,
    );

    expect(completed).toBe(false);
    expect(patch.status).toBeUndefined();
    expect(patch.completed_at).toBeUndefined();
    expect(patch.successful_tests).toBe(1);
  });
});

describe('reconcileScheduledTests', () => {
  it('closes children and rolls the parent up to completed', async () => {
    const { port, recorded } = stubPort({
      items: [
        item({ id: 'a', test_run_id: 'run-1' }),
        item({ id: 'b', test_run_id: 'run-2' }),
      ],
      runs: [
        testRun({ id: 'run-1', status: 'completed' }),
        testRun({ id: 'run-2', status: 'failed' }),
      ],
      tallies: [
        { test_run_id: 'run-1', items_total: 10, items_passed: 9, items_failed: 1 },
      ],
    });

    const result = await reconcileScheduledTests(deps(port));

    expect(reconcileScheduledTestsResultSchema.parse(result)).toBeTruthy();
    expect(result.itemsExamined).toBe(2);
    expect(result.itemsCompleted).toBe(1);
    expect(result.itemsFailed).toBe(1);
    expect(result.itemsPending).toBe(0);
    expect(recorded.itemUpdates.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(recorded.itemUpdates[0]?.patch).toMatchObject({
      status: 'completed',
      items_passed: 9,
      pass_rate: 0.9,
    });
    expect(result.runsCompleted).toBe(1);
    expect(recorded.runUpdates[0]?.patch).toMatchObject({
      status: 'completed',
      successful_tests: 1,
      failed_tests: 1,
    });
  });

  it('skips a child with no `test_run_id` and never touches the parent', async () => {
    const { port, recorded } = stubPort({
      items: [item({ id: 'a', test_run_id: null, started_at: isoAgo(60_000) })],
    });

    const result = await reconcileScheduledTests(deps(port));

    expect(result.itemsPending).toBe(1);
    expect(recorded.itemUpdates).toHaveLength(0);
    expect(recorded.runUpdates).toHaveLength(0);
    expect(result.runIds).toEqual([]);
  });

  it('counts a write failure and leaves the child for the next run', async () => {
    const { port, recorded } = stubPort({
      items: [item({ id: 'a', test_run_id: 'run-1' })],
      runs: [testRun({ id: 'run-1', status: 'completed' })],
      failItemIds: new Set(['a']),
    });

    const result = await reconcileScheduledTests(deps(port));

    expect(result.itemsWriteFailed).toBe(1);
    expect(result.itemsCompleted).toBe(0);
    expect(recorded.runUpdates).toHaveLength(0);
  });

  it('writes nothing on a dry run', async () => {
    const { port, recorded } = stubPort({
      items: [item({ id: 'a', test_run_id: 'run-1' })],
      runs: [testRun({ id: 'run-1', status: 'completed' })],
    });

    const result = await reconcileScheduledTests(deps(port), { dryRun: true });

    expect(result.itemsCompleted).toBe(1);
    expect(recorded.itemUpdates).toHaveLength(0);
    expect(recorded.runUpdates).toHaveLength(0);
  });
});
