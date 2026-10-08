import { describe, expect, it } from 'vitest';

import {
  GRADE_BACKFILL_WINDOW_MS,
  SCHEDULED_ITEM_PROVIDER_FAULT_ERROR,
  SCHEDULED_ITEM_PROVIDER_FAULT_RATE_THRESHOLD,
  SCHEDULED_ITEM_STALE_AFTER_MS,
  SCHEDULED_ITEM_TIMED_OUT_ERROR,
  ORPHAN_BACKFILL_WINDOW_MS,
  buildScheduledRunPatch,
  describeProviderFault,
  isProviderFaultedTally,
  matchOrphanToSweepRun,
  reconcileScheduledTests,
  reconcileScheduledTestsResultSchema,
  resolveScheduledItemPatch,
  type ReconcilerSweepRun,
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
    run_mode: 'full',
    partial_score_threshold: null,
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
    report_overall_grade: null,
    ...overrides,
  };
}

function sweepRun(overrides: Partial<ReconcilerSweepRun> = {}): ReconcilerSweepRun {
  return {
    ...testRun(),
    test_id: 'test-1',
    created_at: isoAgo(10 * 60 * 1000 - 2_000),
    ...overrides,
  };
}

function tally(overrides: Partial<ScheduledItemTally> = {}): ScheduledItemTally {
  return {
    test_run_id: 'run-1',
    items_total: 20,
    items_passed: 15,
    items_failed: 5,
    items_provider_faulted: 0,
    provider_fault_kind: null,
    ...overrides,
  };
}

type Recorded = {
  itemUpdates: { id: string; patch: ScheduledTestItemPatch }[];
  runUpdates: { id: string; patch: ScheduledTestRunPatch }[];
  backfillQueries: { testIds: string[]; sinceIso: string }[];
  /** B0-1169 — every call to the revisit reader. */
  ungradedQueries: { sinceIso: string; limit: number }[];
};

function stubPort(options: {
  items?: ScheduledTestItem[];
  /** B0-1169 — already-`completed` children with no grade that the revisit pass should see. */
  ungraded?: ScheduledTestItem[];
  runs?: ReconcilerTestRun[];
  sweepRuns?: ReconcilerSweepRun[];
  tallies?: ScheduledItemTally[];
  parents?: ScheduledTestRun[];
  /** Children the parent rollup sees (defaults to `items` with the recorded patches applied). */
  siblings?: ScheduledTestItem[];
  failItemIds?: Set<string>;
}): { port: ScheduledTestReconcilerPort; recorded: Recorded } {
  const recorded: Recorded = {
    itemUpdates: [],
    runUpdates: [],
    backfillQueries: [],
    ungradedQueries: [],
  };
  const items = options.items ?? [];

  const port: ScheduledTestReconcilerPort = {
    async listNonTerminalItems() {
      return items;
    },
    async listCompletedUngradedItems(sinceIso, limit) {
      recorded.ungradedQueries.push({ sinceIso, limit });
      return options.ungraded ?? [];
    },
    async listTestRuns(testRunIds) {
      // Backfilled ids are only known to the sweep-run list; serve those rows here too so a
      // relinked child is folded exactly as the repository would.
      const known = options.runs ?? [];
      const fromSweep = (options.sweepRuns ?? []).filter(
        (run) => testRunIds.includes(run.id) && !known.some((k) => k.id === run.id),
      );
      return [...known, ...fromSweep];
    },
    async listSweepTestRunsForTests(testIds, sinceIso) {
      recorded.backfillQueries.push({ testIds, sinceIso });
      return options.sweepRuns ?? [];
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
      tally: tally(),
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

// B0-1014 — the 2026-09-15 00:00 UTC sweep: the OpenAI org had run out of credits the evening
// before, so all five runs ended `completed` having answered nothing, every child closed
// `completed` with a 0% pass rate, and the parent recorded `success_rate: 1`.
describe('provider-faulted runs (B0-1014)', () => {
  describe('isProviderFaultedTally', () => {
    it('trips at the threshold, not above it', () => {
      // 1/20 is exactly 0.05 — the same `>=` boundary as run-provider-health.ts, because a
      // provider refusal is a hard zero for that item with no partial answer to grade.
      expect(isProviderFaultedTally(tally({ items_total: 20, items_provider_faulted: 1 }))).toBe(
        true,
      );
      expect(SCHEDULED_ITEM_PROVIDER_FAULT_RATE_THRESHOLD).toBe(0.05);
    });

    it('leaves a run below the threshold alone', () => {
      // 1/21 ≈ 0.0476 — one transient blip on a long run is noise, not an outage.
      expect(isProviderFaultedTally(tally({ items_total: 21, items_provider_faulted: 1 }))).toBe(
        false,
      );
      expect(isProviderFaultedTally(tally({ items_total: 20, items_provider_faulted: 0 }))).toBe(
        false,
      );
    });

    it('never calls an empty run provider-faulted', () => {
      expect(
        isProviderFaultedTally(tally({ items_total: 0, items_passed: 0, items_provider_faulted: 0 })),
      ).toBe(false);
    });
  });

  describe('describeProviderFault', () => {
    it('names the known kind in the operator wording and both counts', () => {
      expect(
        describeProviderFault(
          tally({
            items_total: 20,
            items_provider_faulted: 18,
            provider_fault_kind: 'insufficient_quota',
          }),
        ),
      ).toBe(
        '18 of 20 items got no answer: the model provider refused the request ' +
          '(Out of credits / quota exhausted). This run measured nothing and must be re-run.',
      );
    });

    it('quotes an unrecognized kind verbatim — the column is free text', () => {
      expect(
        describeProviderFault(
          tally({ items_total: 20, items_provider_faulted: 20, provider_fault_kind: 'gremlins' }),
        ),
      ).toContain('(gremlins)');
    });
  });

  it('closes a fully provider-faulted run as failed while still writing its counts', () => {
    const patch = resolveScheduledItemPatch({
      item: item(),
      run: testRun({ status: 'completed' }),
      tally: tally({
        items_total: 20,
        items_passed: 0,
        items_failed: 20,
        items_provider_faulted: 20,
        provider_fault_kind: 'insufficient_quota',
      }),
      nowMs: NOW_MS,
      staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
    });

    expect(patch).toMatchObject({
      status: 'failed',
      error_code: SCHEDULED_ITEM_PROVIDER_FAULT_ERROR,
      // The counts are not hidden — `status` and `error_code` tell the truth alongside them.
      items_total: 20,
      items_passed: 0,
      items_failed: 20,
      pass_rate: 0,
    });
    expect(patch?.error_message).toContain('20 of 20 items got no answer');
  });

  it('is byte-identical to today for a run with zero provider faults', () => {
    const patch = resolveScheduledItemPatch({
      item: item(),
      run: testRun({ status: 'completed' }),
      tally: tally({ items_total: 20, items_passed: 15, items_failed: 5 }),
      nowMs: NOW_MS,
      staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
    });

    expect(patch).toEqual({
      status: 'completed',
      completed_at: isoAgo(4 * 60 * 1000),
      elapsed_ms: 6 * 60 * 1000,
      items_total: 20,
      items_passed: 15,
      items_failed: 5,
      pass_rate: 0.75,
    });
  });

  it('leaves an ordinarily failed run with its own error code', () => {
    const patch = resolveScheduledItemPatch({
      item: item(),
      run: testRun({ status: 'failed' }),
      tally: tally({ items_total: 20, items_provider_faulted: 20 }),
      nowMs: NOW_MS,
      staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
    });

    expect(patch).toMatchObject({ status: 'failed', error_code: 'run_failed' });
  });

  it('stops the parent reporting success_rate 1 when a child measured nothing', async () => {
    const { port, recorded } = stubPort({
      items: [item({ id: 'a', test_run_id: 'run-1' }), item({ id: 'b', test_run_id: 'run-2' })],
      runs: [
        testRun({ id: 'run-1', status: 'completed' }),
        testRun({ id: 'run-2', status: 'completed' }),
      ],
      tallies: [
        tally({ test_run_id: 'run-1', items_total: 20, items_passed: 18, items_failed: 2 }),
        tally({
          test_run_id: 'run-2',
          items_total: 20,
          items_passed: 0,
          items_failed: 20,
          items_provider_faulted: 20,
          provider_fault_kind: 'insufficient_quota',
        }),
      ],
    });

    const result = await reconcileScheduledTests(deps(port));

    expect(result.itemsCompleted).toBe(1);
    expect(result.itemsFailed).toBe(1);
    expect(recorded.itemUpdates[1]?.patch).toMatchObject({
      status: 'failed',
      error_code: SCHEDULED_ITEM_PROVIDER_FAULT_ERROR,
    });
    expect(recorded.runUpdates[0]?.patch).toMatchObject({
      status: 'completed',
      successful_tests: 1,
      failed_tests: 1,
      success_rate: 0.5,
    });
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

  it('ends the sweep when its last child ended, not when the reconciler ran', () => {
    // Regression: the parent used to stamp the reconciliation time, so a sweep whose runs finished
    // in 5 minutes read as hours whenever the cron came round late (7.96h observed locally, where
    // no cron fires at all).
    const { patch } = buildScheduledRunPatch(
      parentRun({ total_tests: 2 }),
      [
        item({ id: 'a', status: 'completed', completed_at: isoAgo(26 * 60 * 1000) }),
        item({ id: 'b', status: 'completed', completed_at: isoAgo(25 * 60 * 1000) }),
      ],
      NOW_MS,
    );

    // Sweep was triggered 30 minutes ago and its last child finished 25 minutes ago.
    expect(patch.completed_at).toBe(isoAgo(25 * 60 * 1000));
    expect(patch.elapsed_ms).toBe(5 * 60 * 1000);
  });

  it('falls back to the reconciliation time when no child carries a completion stamp', () => {
    const { patch } = buildScheduledRunPatch(
      parentRun({ total_tests: 1 }),
      [item({ id: 'a', status: 'failed', completed_at: null })],
      NOW_MS,
    );

    expect(patch.completed_at).toBe(NOW_ISO);
    expect(patch.elapsed_ms).toBe(30 * 60 * 1000);
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
      tallies: [tally({ test_run_id: 'run-1', items_total: 10, items_passed: 9, items_failed: 1 })],
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

  it('skips a child with no `test_run_id` and no matching sweep run, never touching the parent', async () => {
    const { port, recorded } = stubPort({
      items: [item({ id: 'a', test_run_id: null, started_at: isoAgo(60_000) })],
    });

    const result = await reconcileScheduledTests(deps(port));

    expect(result.itemsPending).toBe(1);
    expect(result.itemsBackfilled).toBe(0);
    expect(recorded.backfillQueries).toHaveLength(1);
    expect(recorded.itemUpdates).toHaveLength(0);
    expect(recorded.runUpdates).toHaveLength(0);
    expect(result.runIds).toEqual([]);
  });

  // B0-989 — the 2026-09-14 sweep: four children never got a `test_run_id` because the sweep
  // invocation was killed while the runs were still executing, and three of those runs completed.
  it('backfills an orphaned child from the sweep run and closes it as completed', async () => {
    const { port, recorded } = stubPort({
      items: [item({ id: 'a', test_run_id: null })],
      sweepRuns: [sweepRun({ id: 'run-created-by-sweep', status: 'completed_with_failures' })],
      tallies: [
        tally({
          test_run_id: 'run-created-by-sweep',
          items_total: 20,
          items_passed: 18,
          items_failed: 2,
        }),
      ],
    });

    const result = await reconcileScheduledTests(deps(port));

    expect(result.itemsBackfilled).toBe(1);
    expect(result.itemsCompleted).toBe(1);
    expect(recorded.itemUpdates[0]?.patch).toMatchObject({
      test_run_id: 'run-created-by-sweep',
      status: 'completed',
      items_passed: 18,
    });
    expect(result.runsCompleted).toBe(1);
  });

  it('links an orphaned child to a still-running sweep run without closing it', async () => {
    const { port, recorded } = stubPort({
      items: [item({ id: 'a', test_run_id: null })],
      sweepRuns: [sweepRun({ id: 'run-still-going', status: 'running', completed_at: null })],
    });

    const result = await reconcileScheduledTests(deps(port));

    expect(result.itemsBackfilled).toBe(1);
    expect(result.itemsPending).toBe(1);
    expect(recorded.itemUpdates).toEqual([
      { id: 'a', patch: { test_run_id: 'run-still-going' } },
    ]);
    // A link-only write changes nothing the parent aggregates read.
    expect(recorded.runUpdates).toHaveLength(0);
  });

  it('does not write the backfilled link on a dry run', async () => {
    const { port, recorded } = stubPort({
      items: [item({ id: 'a', test_run_id: null })],
      sweepRuns: [sweepRun({ id: 'run-still-going', status: 'running', completed_at: null })],
    });

    const result = await reconcileScheduledTests(deps(port), { dryRun: true });

    expect(result.itemsBackfilled).toBe(1);
    expect(recorded.itemUpdates).toHaveLength(0);
  });
});

describe('matchOrphanToSweepRun (B0-989)', () => {
  const orphan = item({ test_run_id: null, started_at: isoAgo(10 * 60 * 1000) });

  it('picks the earliest run for the same test created just after the child started', () => {
    const later = sweepRun({ id: 'later', created_at: isoAgo(10 * 60 * 1000 - 30_000) });
    const earlier = sweepRun({ id: 'earlier', created_at: isoAgo(10 * 60 * 1000 - 2_000) });

    expect(matchOrphanToSweepRun(orphan, [later, earlier])?.id).toBe('earlier');
  });

  it('ignores runs for another test, runs created before the child, and runs outside the window', () => {
    expect(
      matchOrphanToSweepRun(orphan, [
        sweepRun({ id: 'other-test', test_id: 'test-2' }),
        sweepRun({ id: 'too-early', created_at: isoAgo(12 * 60 * 1000) }),
        sweepRun({
          id: 'too-late',
          created_at: isoAgo(10 * 60 * 1000 - ORPHAN_BACKFILL_WINDOW_MS - 1_000),
        }),
      ]),
    ).toBeNull();
  });

  it('tolerates clock skew: a run stamped a few seconds before the child still matches', () => {
    expect(
      matchOrphanToSweepRun(orphan, [
        sweepRun({ id: 'skewed', created_at: isoAgo(10 * 60 * 1000 + 13_500) }),
      ])?.id,
    ).toBe('skewed');
  });

  it('never hands one run to two children', () => {
    const consumed = new Set<string>();
    const runs = [sweepRun({ id: 'only' })];

    expect(matchOrphanToSweepRun(orphan, runs, consumed)?.id).toBe('only');
    expect(matchOrphanToSweepRun(item({ id: 'b', test_run_id: null }), runs, consumed)).toBeNull();
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

// B0-1169 — every one of the 240 sweep-linked children had `grade = null`: nothing copied the
// run's report grade in, and the child closes the hour its run ends, which is before the report
// sweeper has generated `test_results.report_overall_grade` (190/190 graded children had
// `completed_at < report_generated_at`).
describe('grade denormalization (B0-1169)', () => {
  describe('resolveScheduledItemPatch', () => {
    it('copies the report grade onto a completed child when the report already exists', () => {
      const patch = resolveScheduledItemPatch({
        item: item(),
        run: testRun({ status: 'completed', report_overall_grade: 'B' }),
        tally: tally(),
        nowMs: NOW_MS,
        staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
      });

      expect(patch).toMatchObject({ status: 'completed', grade: 'B' });
    });

    it('leaves `grade` out of the patch (not null) when the run has no report yet', () => {
      const patch = resolveScheduledItemPatch({
        item: item(),
        run: testRun({ status: 'completed', report_overall_grade: null }),
        tally: tally(),
        nowMs: NOW_MS,
        staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
      });

      expect(patch?.status).toBe('completed');
      expect(patch).not.toHaveProperty('grade');
    });

    it('never grades a provider-faulted child, even when its report carries a grade', () => {
      const patch = resolveScheduledItemPatch({
        item: item(),
        run: testRun({ status: 'completed', report_overall_grade: 'F' }),
        tally: tally({
          items_total: 20,
          items_passed: 0,
          items_failed: 20,
          items_provider_faulted: 20,
          provider_fault_kind: 'insufficient_quota',
        }),
        nowMs: NOW_MS,
        staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
      });

      expect(patch).toMatchObject({ status: 'failed', error_code: SCHEDULED_ITEM_PROVIDER_FAULT_ERROR });
      expect(patch).not.toHaveProperty('grade');
    });

    it('never grades a child whose run failed', () => {
      const patch = resolveScheduledItemPatch({
        item: item(),
        run: testRun({ status: 'failed', report_overall_grade: 'F' }),
        tally: null,
        nowMs: NOW_MS,
        staleAfterMs: SCHEDULED_ITEM_STALE_AFTER_MS,
      });

      expect(patch).toMatchObject({ status: 'failed', error_code: 'run_failed' });
      expect(patch).not.toHaveProperty('grade');
    });
  });

  describe('revisit pass', () => {
    const closedUngraded = item({
      id: 'closed',
      status: 'completed',
      test_run_id: 'run-closed',
      completed_at: isoAgo(3 * 60 * 60 * 1000),
      pass_rate: 0.9,
      grade: null,
    });

    it('grades a previously closed child once its report exists, touching nothing else', async () => {
      const { port, recorded } = stubPort({
        ungraded: [closedUngraded],
        runs: [testRun({ id: 'run-closed', status: 'completed', report_overall_grade: 'A' })],
      });

      const result = await reconcileScheduledTests(deps(port));

      expect(reconcileScheduledTestsResultSchema.parse(result)).toBeTruthy();
      expect(result.gradeBackfillExamined).toBe(1);
      expect(result.itemsGraded).toBe(1);
      // Exactly the grade: no status, no completed_at, nothing the parent aggregates read.
      expect(recorded.itemUpdates).toEqual([{ id: 'closed', patch: { grade: 'A' } }]);
      expect(recorded.runUpdates).toHaveLength(0);
      expect(result.runIds).toEqual([]);
      // The first pass had nothing to do and must not have double-counted the revisit.
      expect(result.itemsExamined).toBe(0);
      expect(result.itemsCompleted).toBe(0);
    });

    it('looks back exactly GRADE_BACKFILL_WINDOW_MS, bounded by the invocation limit', async () => {
      const { port, recorded } = stubPort({});

      await reconcileScheduledTests(deps(port), { limit: 50 });

      expect(GRADE_BACKFILL_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
      expect(recorded.ungradedQueries).toEqual([
        { sinceIso: isoAgo(GRADE_BACKFILL_WINDOW_MS), limit: 50 },
      ]);
    });

    it('skips a child whose run still has no report and re-examines it next hour', async () => {
      const { port, recorded } = stubPort({
        ungraded: [closedUngraded],
        runs: [testRun({ id: 'run-closed', status: 'completed', report_overall_grade: null })],
      });

      const result = await reconcileScheduledTests(deps(port));

      expect(result.gradeBackfillExamined).toBe(1);
      expect(result.itemsGraded).toBe(0);
      expect(recorded.itemUpdates).toHaveLength(0);
    });

    it('runs after the non-terminal pass in the same invocation', async () => {
      const { port, recorded } = stubPort({
        items: [item({ id: 'open', test_run_id: 'run-open' })],
        ungraded: [closedUngraded],
        runs: [
          testRun({ id: 'run-open', status: 'completed', report_overall_grade: null }),
          testRun({ id: 'run-closed', status: 'completed', report_overall_grade: 'A' }),
        ],
        tallies: [tally({ test_run_id: 'run-open' })],
      });

      const result = await reconcileScheduledTests(deps(port));

      expect(result.itemsCompleted).toBe(1);
      expect(result.itemsGraded).toBe(1);
      expect(recorded.itemUpdates.map((entry) => entry.id)).toEqual(['open', 'closed']);
      expect(recorded.itemUpdates[0]?.patch).not.toHaveProperty('grade');
      expect(recorded.itemUpdates[1]?.patch).toEqual({ grade: 'A' });
      // Only the open child's parent is recomputed; the revisit never touches a parent.
      expect(recorded.runUpdates).toHaveLength(1);
    });

    it('writes nothing on a dry run but still reports what it would grade', async () => {
      const { port, recorded } = stubPort({
        ungraded: [closedUngraded],
        runs: [testRun({ id: 'run-closed', status: 'completed', report_overall_grade: 'A' })],
      });

      const result = await reconcileScheduledTests(deps(port), { dryRun: true });

      expect(result.itemsGraded).toBe(1);
      expect(recorded.itemUpdates).toHaveLength(0);
    });

    it('counts a failed grade write into itemsWriteFailed and leaves the child for next hour', async () => {
      const { port, recorded } = stubPort({
        ungraded: [closedUngraded],
        runs: [testRun({ id: 'run-closed', status: 'completed', report_overall_grade: 'A' })],
        failItemIds: new Set(['closed']),
      });

      const result = await reconcileScheduledTests(deps(port));

      expect(result.itemsWriteFailed).toBe(1);
      expect(result.itemsGraded).toBe(0);
      expect(recorded.itemUpdates).toHaveLength(0);
      expect(recorded.runUpdates).toHaveLength(0);
    });
  });
});
