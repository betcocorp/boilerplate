import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/tests/repository', () => ({
  createTestResult: vi.fn(),
  getTestById: vi.fn(),
  getTestItemsByTestId: vi.fn(),
  updateTestRecord: vi.fn(),
}));

import { createModelComparisonRun } from '~/lib/tests/model-comparison';
import {
  createTestResult,
  getTestById,
  getTestItemsByTestId,
  updateTestRecord,
} from '~/lib/tests/repository';

const TEST_ID = '0a4f1a4a-6b1e-4a4c-9c0f-9b2f5b6d7e81';

type Test = Awaited<ReturnType<typeof getTestById>>;
type Items = Awaited<ReturnType<typeof getTestItemsByTestId>>;
type Result = Awaited<ReturnType<typeof createTestResult>>;

describe('createModelComparisonRun (B0-600)', () => {
  beforeEach(() => {
    vi.mocked(createTestResult).mockReset();
    vi.mocked(getTestById).mockReset();
    vi.mocked(getTestItemsByTestId).mockReset();
    vi.mocked(updateTestRecord).mockReset();

    vi.mocked(getTestById).mockResolvedValue({
      id: TEST_ID,
      suite_version: 'v7',
    } as unknown as Test);
    vi.mocked(getTestItemsByTestId).mockResolvedValue([
      { id: 'i1' },
      { id: 'i2' },
      { id: 'i3' },
    ] as unknown as Items);
    let n = 0;
    vi.mocked(createTestResult).mockImplementation(
      async () => ({ id: `run-${++n}` }) as unknown as Result,
    );
    vi.mocked(updateTestRecord).mockResolvedValue(undefined as never);
  });

  it('creates one queued run per model against the same suite', async () => {
    const result = await createModelComparisonRun({
      testId: TEST_ID,
      models: ['gpt-5.6', 'preview'],
    });

    expect(result).toMatchObject({
      testId: TEST_ID,
      suiteVersion: 'v7',
      totalItems: 3,
      runs: [
        { modelTag: 'gpt-5.6', runId: 'run-1' },
        { modelTag: 'preview', runId: 'run-2' },
      ],
    });
    expect(createTestResult).toHaveBeenCalledTimes(2);
  });

  it('seeds each arm with the shape both executors read', async () => {
    await createModelComparisonRun({
      testId: TEST_ID,
      models: ['gpt-5.5', 'gpt-4.1'],
      useValidator: true,
    });

    for (const [index, modelTag] of ['gpt-5.5', 'gpt-4.1'].entries()) {
      expect(createTestResult).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          test_id: TEST_ID,
          status: 'queued',
          run_mode: 'full',
          total_items: 3,
          passed_items: 0,
          failed_items: 0,
          // Both arms carry the SAME useValidator, or the comparison is not like-for-like.
          run_options: { modelTag, useValidator: true },
          summary: {
            completed_items: 0,
            total_items: 3,
            progress_percent: 0,
            runner_state: 'queued',
          },
        }),
      );
    }
    expect(updateTestRecord).toHaveBeenCalledWith(TEST_ID, { status: 'running' });
  });

  it('defaults the validator off so an A/B costs no more than a normal run unless asked', async () => {
    await createModelComparisonRun({ testId: TEST_ID, models: ['gpt-5.5', 'preview'] });

    expect(createTestResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ run_options: { modelTag: 'gpt-5.5', useValidator: false } }),
    );
  });

  it('refuses a single-arm comparison', async () => {
    await expect(
      createModelComparisonRun({ testId: TEST_ID, models: ['gpt-5.5'] }),
    ).rejects.toThrow(/at least two models/);
    expect(createTestResult).not.toHaveBeenCalled();
  });

  it('refuses duplicate arms, which would produce two identical runs', async () => {
    await expect(
      createModelComparisonRun({ testId: TEST_ID, models: ['gpt-5.5', 'gpt-5.5'] }),
    ).rejects.toThrow(/distinct models/);
    expect(createTestResult).not.toHaveBeenCalled();
  });

  it('refuses a suite with no items rather than creating empty runs', async () => {
    vi.mocked(getTestItemsByTestId).mockResolvedValue([] as unknown as Items);

    await expect(
      createModelComparisonRun({ testId: TEST_ID, models: ['gpt-5.5', 'preview'] }),
    ).rejects.toThrow(/no items to run/);
    expect(createTestResult).not.toHaveBeenCalled();
  });
});
