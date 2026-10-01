import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-1106 — the manual "Run Golden" ledger. What is pinned: the parent is written under the manual
 * sweep name with the dialog's mode/threshold, children are written `running` up front and then
 * linked or closed `skipped` per set, an all-skipped sweep closes `completed` (never "every golden
 * test failed to dispatch"), and no ledger failure ever escapes to the caller.
 */

const runInserts: Record<string, unknown>[] = [];
const itemInserts: Record<string, unknown>[] = [];
const itemWrites: { id: string; patch: Record<string, unknown> }[] = [];
const runWrites: { id: string; patch: Record<string, unknown> }[] = [];
const closeCalls: Record<string, unknown>[] = [];
const failures = { insertRun: false, insertItems: false, updateItem: false, close: false };

vi.mock('~/lib/observability/scheduled-test-repository', () => ({
  insertScheduledTestRun: vi.fn(async (input: Record<string, unknown>) => {
    if (failures.insertRun) throw new Error('insert run boom');
    runInserts.push(input);
    return { id: 'sweep-1' };
  }),
  insertScheduledTestItems: vi.fn(
    async (input: { scheduledRunId: string; tests: { id: string; name: string }[] }) => {
      if (failures.insertItems) throw new Error('insert items boom');
      itemInserts.push(input);
      return input.tests.map((test) => ({
        id: `child-${test.id}`,
        scheduled_run_id: input.scheduledRunId,
        test_id: test.id,
        test_name: test.name,
        test_run_id: null,
        status: 'running',
        elapsed_ms: null,
      }));
    },
  ),
  updateScheduledTestItem: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    if (failures.updateItem) throw new Error('update item boom');
    itemWrites.push({ id, patch });
  }),
  updateScheduledTestRun: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    runWrites.push({ id, patch });
  }),
  closeScheduledRunAfterDispatch: vi.fn(async (input: Record<string, unknown>) => {
    if (failures.close) throw new Error('close boom');
    closeCalls.push(input);
  }),
}));

const {
  closeManualSweepLedger,
  openManualSweepLedger,
  recordManualSweepRunCreated,
  recordManualSweepTestSkipped,
} = await import('~/lib/observability/manual-golden-sweep-ledger');

const GOLDEN = [
  { id: 'test-a', name: 'Golden — dilution' },
  { id: 'test-b', name: 'Golden — restroom' },
  { id: 'test-c', name: 'Golden — empty' },
];

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runInserts.length = 0;
  itemInserts.length = 0;
  itemWrites.length = 0;
  runWrites.length = 0;
  closeCalls.length = 0;
  failures.insertRun = false;
  failures.insertItems = false;
  failures.updateItem = false;
  failures.close = false;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openManualSweepLedger', () => {
  it('writes the parent under the manual sweep name with mode, threshold and actor, then running children', async () => {
    const ledger = await openManualSweepLedger({
      goldenTests: GOLDEN,
      runMode: 'partial',
      partialScoreThreshold: 75,
      triggeredBy: 'tbird@betco.com',
      metadata: { model_tag: 'gpt-4.1' },
    });

    expect(ledger).toMatchObject({ scheduledRunId: 'sweep-1' });
    expect(runInserts).toHaveLength(1);
    expect(runInserts[0]).toMatchObject({
      sweepName: 'manual_golden_sweep',
      runMode: 'partial',
      partialScoreThreshold: 75,
      totalTests: 3,
      metadata: { triggered_by: 'tbird@betco.com', model_tag: 'gpt-4.1' },
    });
    expect(itemInserts[0]).toMatchObject({ scheduledRunId: 'sweep-1', tests: GOLDEN });
    // Children carry no status of their own → the repository's default `running`.
    expect(
      (itemInserts[0] as { tests: { status?: string }[] }).tests.every((t) => t.status === undefined),
    ).toBe(true);
    expect(Array.from(ledger!.itemsByTestId.keys())).toEqual(['test-a', 'test-b', 'test-c']);
  });

  it('a full sweep records run_mode full and a null threshold', async () => {
    await openManualSweepLedger({
      goldenTests: GOLDEN,
      runMode: 'full',
      partialScoreThreshold: null,
      triggeredBy: 'tbird@betco.com',
    });

    expect(runInserts[0]).toMatchObject({ runMode: 'full', partialScoreThreshold: null });
  });

  it('returns null and logs when the parent insert fails — never throws', async () => {
    failures.insertRun = true;

    const ledger = await openManualSweepLedger({
      goldenTests: GOLDEN,
      runMode: 'full',
      partialScoreThreshold: null,
      triggeredBy: 'tbird@betco.com',
    });

    expect(ledger).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(itemInserts).toHaveLength(0);

    // Every later call is a silent no-op on a null ledger.
    await expect(recordManualSweepRunCreated(ledger, 'test-a', 'run-a')).resolves.toBeUndefined();
    await expect(
      recordManualSweepTestSkipped(ledger, 'test-c', { code: 'empty_set', message: 'x' }),
    ).resolves.toBeUndefined();
    await expect(closeManualSweepLedger(ledger)).resolves.toBeUndefined();
    expect(itemWrites).toHaveLength(0);
    expect(closeCalls).toHaveLength(0);
  });

  it('returns null and logs when the children insert fails', async () => {
    failures.insertItems = true;

    const ledger = await openManualSweepLedger({
      goldenTests: GOLDEN,
      runMode: 'full',
      partialScoreThreshold: null,
      triggeredBy: 'tbird@betco.com',
    });

    expect(ledger).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('record + close', () => {
  it('links created runs, closes skipped sets with a reason, and hands the in-memory state to the shared close', async () => {
    const ledger = await openManualSweepLedger({
      goldenTests: GOLDEN,
      runMode: 'partial',
      partialScoreThreshold: 70,
      triggeredBy: 'tbird@betco.com',
    });

    await recordManualSweepRunCreated(ledger, 'test-a', 'run-a');
    await recordManualSweepTestSkipped(ledger, 'test-b', {
      code: 'no_qualifying_items',
      message: 'No items scored below 70 on their latest graded run.',
    });
    await recordManualSweepTestSkipped(ledger, 'test-c', {
      code: 'empty_set',
      message: 'This golden set has no items.',
    });
    await closeManualSweepLedger(ledger);

    expect(itemWrites[0]).toEqual({ id: 'child-test-a', patch: { test_run_id: 'run-a' } });
    expect(itemWrites[1]).toMatchObject({
      id: 'child-test-b',
      patch: { status: 'skipped', error_code: 'no_qualifying_items' },
    });
    expect(typeof itemWrites[1].patch.completed_at).toBe('string');
    expect(itemWrites[2]).toMatchObject({
      id: 'child-test-c',
      patch: { status: 'skipped', error_code: 'empty_set' },
    });

    // One run is executing, so the parent goes through the shared close (stays in_progress).
    expect(closeCalls).toHaveLength(1);
    const items = closeCalls[0].items as { test_id: string; status: string; test_run_id: string | null }[];
    expect(items.map((i) => [i.test_id, i.status, i.test_run_id])).toEqual([
      ['test-a', 'running', 'run-a'],
      ['test-b', 'skipped', null],
      ['test-c', 'skipped', null],
    ]);
    expect(closeCalls[0]).toMatchObject({ scheduledRunId: 'sweep-1' });
    expect(runWrites).toHaveLength(0);
  });

  it('closes an all-skipped sweep as completed with no success rate, not as a dispatch failure', async () => {
    const ledger = await openManualSweepLedger({
      goldenTests: GOLDEN.slice(0, 2),
      runMode: 'partial',
      partialScoreThreshold: 10,
      triggeredBy: 'tbird@betco.com',
    });

    await recordManualSweepTestSkipped(ledger, 'test-a', { code: 'no_qualifying_items', message: 'n' });
    await recordManualSweepTestSkipped(ledger, 'test-b', { code: 'no_qualifying_items', message: 'n' });
    await closeManualSweepLedger(ledger);

    expect(closeCalls).toHaveLength(0);
    expect(runWrites).toHaveLength(1);
    expect(runWrites[0].id).toBe('sweep-1');
    expect(runWrites[0].patch).toMatchObject({
      status: 'completed',
      total_tests: 2,
      successful_tests: 0,
      failed_tests: 0,
      timed_out_tests: 0,
      success_rate: null,
      error_message: null,
    });
    expect(typeof runWrites[0].patch.completed_at).toBe('string');
  });

  it('a child write failure is logged, keeps the in-memory row unchanged, and never throws', async () => {
    const ledger = await openManualSweepLedger({
      goldenTests: GOLDEN.slice(0, 1),
      runMode: 'full',
      partialScoreThreshold: null,
      triggeredBy: 'tbird@betco.com',
    });
    failures.updateItem = true;

    await expect(recordManualSweepRunCreated(ledger, 'test-a', 'run-a')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(ledger!.itemsByTestId.get('test-a')?.test_run_id).toBeNull();
  });

  it('a close failure is logged and never throws', async () => {
    const ledger = await openManualSweepLedger({
      goldenTests: GOLDEN.slice(0, 1),
      runMode: 'full',
      partialScoreThreshold: null,
      triggeredBy: 'tbird@betco.com',
    });
    await recordManualSweepRunCreated(ledger, 'test-a', 'run-a');
    failures.close = true;

    await expect(closeManualSweepLedger(ledger)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('ignores a test id the ledger never had a child for', async () => {
    const ledger = await openManualSweepLedger({
      goldenTests: GOLDEN.slice(0, 1),
      runMode: 'full',
      partialScoreThreshold: null,
      triggeredBy: 'tbird@betco.com',
    });

    await recordManualSweepRunCreated(ledger, 'test-zzz', 'run-z');
    expect(itemWrites).toHaveLength(0);
  });
});
