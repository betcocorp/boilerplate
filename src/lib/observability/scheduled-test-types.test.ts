import { describe, expect, it } from 'vitest';

import {
  CRON_SWEEP_NAME,
  MANUAL_SWEEP_NAME,
  formatRate,
  getRunDisplayCounts,
  getRunDisplayStatus,
  getSweepSourceLabel,
  type ScheduledTestItem,
  type ScheduledTestRunWithItems,
} from '~/lib/observability/scheduled-test-types';

const NOW_ISO = '2026-09-29T12:00:00.000Z';

function makeItem(
  overrides: Partial<ScheduledTestItem> = {},
): ScheduledTestItem {
  return {
    id: 'item-1',
    scheduled_run_id: 'run-1',
    test_id: 'test-1',
    test_name: 'Golden — Dilution',
    test_run_id: 'result-1',
    status: 'completed',
    started_at: NOW_ISO,
    completed_at: NOW_ISO,
    elapsed_ms: 1000,
    items_total: 10,
    items_passed: 8,
    items_failed: 2,
    pass_rate: 0.8,
    grade: 'B',
    confidence: null,
    error_code: null,
    error_message: null,
    error_details: null,
    retry_count: 0,
    last_retry_at: null,
    claimed_by: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<ScheduledTestRunWithItems> = {},
): ScheduledTestRunWithItems {
  return {
    id: 'run-1',
    sweep_name: CRON_SWEEP_NAME,
    run_mode: 'full',
    partial_score_threshold: null,
    sweep_triggered_at: NOW_ISO,
    status: 'completed',
    error_message: null,
    started_at: NOW_ISO,
    completed_at: NOW_ISO,
    elapsed_ms: 5000,
    total_tests: 3,
    successful_tests: 3,
    failed_tests: 0,
    timed_out_tests: 0,
    success_rate: 1,
    avg_elapsed_ms: 1000,
    metadata: {},
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    items: [],
    ...overrides,
  };
}

describe('getRunDisplayStatus (B0-1107)', () => {
  it('reports in_progress while any child is non-terminal, even if the parent says completed', () => {
    const run = makeRun({
      status: 'completed',
      items: [makeItem(), makeItem({ id: 'item-2', status: 'running' })],
    });
    expect(getRunDisplayStatus(run)).toBe('in_progress');
  });

  it('falls through to the parent status once every child is terminal', () => {
    const run = makeRun({
      status: 'completed',
      items: [makeItem(), makeItem({ id: 'item-2', status: 'timed_out' })],
    });
    expect(getRunDisplayStatus(run)).toBe('completed');
  });

  it('keeps a failed sweep failed regardless of its children', () => {
    const run = makeRun({
      status: 'failed',
      items: [makeItem({ status: 'running' })],
    });
    expect(getRunDisplayStatus(run)).toBe('failed');
  });
});

describe('getRunDisplayCounts (B0-1107)', () => {
  it('derives counts from the children, not the lagging parent columns', () => {
    const run = makeRun({
      successful_tests: 3,
      failed_tests: 0,
      timed_out_tests: 0,
      success_rate: 1,
      items: [
        makeItem(),
        makeItem({ id: 'item-2', status: 'failed' }),
        makeItem({ id: 'item-3', status: 'timed_out' }),
        makeItem({ id: 'item-4', status: 'running' }),
      ],
    });
    expect(getRunDisplayCounts(run)).toEqual({
      successful: 1,
      failed: 1,
      timedOut: 1,
      successRate: 1 / 3,
    });
  });

  it('falls back to the stored parent columns when no children were written', () => {
    const run = makeRun({
      successful_tests: 2,
      failed_tests: 1,
      timed_out_tests: 0,
      success_rate: 2 / 3,
      items: [],
    });
    expect(getRunDisplayCounts(run)).toEqual({
      successful: 2,
      failed: 1,
      timedOut: 0,
      successRate: 2 / 3,
    });
  });

  it('reports a null success rate when nothing is terminal yet', () => {
    const run = makeRun({ items: [makeItem({ status: 'queued' })] });
    expect(getRunDisplayCounts(run).successRate).toBeNull();
  });
});

describe('formatRate / getSweepSourceLabel (B0-1107)', () => {
  it('renders null as a dash and never as 0%', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.876)).toBe('88%');
  });

  it('labels the cron and manual sweep names', () => {
    expect(getSweepSourceLabel(CRON_SWEEP_NAME)).toBe('Nightly');
    expect(getSweepSourceLabel(MANUAL_SWEEP_NAME)).toBe('Manual');
    expect(getSweepSourceLabel('something_else')).toBe('something_else');
  });
});
