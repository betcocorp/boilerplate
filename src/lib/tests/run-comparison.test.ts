import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/observability/logger', () => ({ logWarn: vi.fn() }));
vi.mock('./repository', () => ({
  createGeneratingRunComparison: vi.fn(),
  createNoBaselineRunComparison: vi.fn(),
  getPreviousCompletedTestResult: vi.fn(),
  getRunComparisonByResultId: vi.fn(),
  getTestResultById: vi.fn(),
  listAllResultItemsByResultId: vi.fn(),
  saveRunComparisonFailed: vi.fn(),
  saveRunComparisonReady: vi.fn(),
}));
vi.mock('./resolve-run-items', () => ({ resolveRunItems: vi.fn() }));
vi.mock('./run-comparison-analysis', () => ({ analyzeRunComparison: vi.fn() }));

import {
  createGeneratingRunComparison,
  createNoBaselineRunComparison,
  getPreviousCompletedTestResult,
  getRunComparisonByResultId,
  getTestResultById,
} from './repository';
import { PARTIAL_RUN_COMPARISON_NOTE, startRunComparison } from './run-comparison';

/**
 * B0-1110 — a partial run (`run_mode = 'partial'`) is never diffed against a full run: its scoped
 * subset is biased low by construction. What is pinned here is that `startRunComparison` writes the
 * explanatory `no_baseline` row for it WITHOUT ever looking up a baseline, while a full run's path
 * is unchanged.
 */

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const TEST_ID = '99999999-8888-7777-6666-555555555555';
const PREVIOUS_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function run(runMode: 'full' | 'partial') {
  return { id: RUN_ID, test_id: TEST_ID, run_mode: runMode } as never;
}

describe('startRunComparison (B0-1110 partial runs)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRunComparisonByResultId).mockResolvedValue(null as never);
    vi.mocked(createNoBaselineRunComparison).mockResolvedValue({ created: true });
    vi.mocked(createGeneratingRunComparison).mockResolvedValue({ created: true } as never);
  });

  it('writes an explanatory no_baseline row for a partial run and never looks for a baseline', async () => {
    vi.mocked(getTestResultById).mockResolvedValue(run('partial'));

    await expect(startRunComparison(RUN_ID)).resolves.toEqual({
      started: false,
      reason: 'partial_run',
    });

    expect(createNoBaselineRunComparison).toHaveBeenCalledWith(RUN_ID, PARTIAL_RUN_COMPARISON_NOTE);
    expect(getPreviousCompletedTestResult).not.toHaveBeenCalled();
    expect(createGeneratingRunComparison).not.toHaveBeenCalled();
  });

  it('stays idempotent for a partial run whose row already exists', async () => {
    vi.mocked(getTestResultById).mockResolvedValue(run('partial'));
    vi.mocked(createNoBaselineRunComparison).mockResolvedValue({ created: false });

    await expect(startRunComparison(RUN_ID)).resolves.toEqual({
      started: false,
      reason: 'already_exists',
    });
  });

  it('still starts a comparison for a full run with a baseline', async () => {
    vi.mocked(getTestResultById).mockResolvedValue(run('full'));
    vi.mocked(getPreviousCompletedTestResult).mockResolvedValue({ id: PREVIOUS_ID } as never);

    await expect(startRunComparison(RUN_ID)).resolves.toEqual({ started: true });

    expect(createGeneratingRunComparison).toHaveBeenCalledWith(RUN_ID, PREVIOUS_ID);
    expect(createNoBaselineRunComparison).not.toHaveBeenCalled();
  });

  it('writes a plain no_baseline row (no note) for a full run with no earlier completed run', async () => {
    vi.mocked(getTestResultById).mockResolvedValue(run('full'));
    vi.mocked(getPreviousCompletedTestResult).mockResolvedValue(null);

    await expect(startRunComparison(RUN_ID)).resolves.toEqual({
      started: false,
      reason: 'no_baseline',
    });

    expect(createNoBaselineRunComparison).toHaveBeenCalledWith(RUN_ID);
  });
});
