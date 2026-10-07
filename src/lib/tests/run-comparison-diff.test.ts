import { describe, expect, it } from 'vitest';

import { computeRunComparisonDiff, type ComparisonResultItem } from './run-comparison-diff';

function item(overrides: Partial<ComparisonResultItem> & { test_item_id: string }): ComparisonResultItem {
  return {
    id: `result-${overrides.test_item_id}`,
    row_index: 0,
    passed: true,
    error_message: null,
    ...overrides,
  };
}

describe('computeRunComparisonDiff', () => {
  it('classifies a passed-then-failed item as a new failure', () => {
    const diff = computeRunComparisonDiff({
      previousItems: [item({ test_item_id: 'a', passed: true })],
      currentItems: [item({ test_item_id: 'a', passed: false, error_message: 'timeout' })],
      promptByTestItemId: new Map([['a', 'What is the dilution ratio?']]),
    });

    expect(diff.newFailures).toHaveLength(1);
    expect(diff.newFailures[0]).toMatchObject({
      testItemId: 'a',
      prompt: 'What is the dilution ratio?',
      errorMessage: 'timeout',
    });
    expect(diff.fixes).toHaveLength(0);
  });

  it('classifies a failed-then-passed item as a fix', () => {
    const diff = computeRunComparisonDiff({
      previousItems: [item({ test_item_id: 'b', passed: false })],
      currentItems: [item({ test_item_id: 'b', passed: true })],
      promptByTestItemId: new Map([['b', 'prompt b']]),
    });

    expect(diff.fixes).toHaveLength(1);
    expect(diff.fixes[0].testItemId).toBe('b');
    expect(diff.newFailures).toHaveLength(0);
  });

  it('does not count items whose pass state is unchanged', () => {
    const diff = computeRunComparisonDiff({
      previousItems: [item({ test_item_id: 'c', passed: true }), item({ test_item_id: 'd', passed: false })],
      currentItems: [item({ test_item_id: 'c', passed: true }), item({ test_item_id: 'd', passed: false })],
      promptByTestItemId: new Map(),
    });

    expect(diff.newFailures).toHaveLength(0);
    expect(diff.fixes).toHaveLength(0);
    expect(diff.scoreDelta).toBe(0);
  });

  it('skips test items absent from one of the two runs', () => {
    const diff = computeRunComparisonDiff({
      previousItems: [item({ test_item_id: 'only-previous', passed: true })],
      currentItems: [item({ test_item_id: 'only-current', passed: false })],
      promptByTestItemId: new Map(),
    });

    expect(diff.newFailures).toHaveLength(0);
    expect(diff.fixes).toHaveLength(0);
  });

  it('computes pass rates and score delta correctly', () => {
    const diff = computeRunComparisonDiff({
      previousItems: [
        item({ test_item_id: '1', passed: true }),
        item({ test_item_id: '2', passed: false }),
      ],
      currentItems: [
        item({ test_item_id: '1', passed: true }),
        item({ test_item_id: '2', passed: true }),
      ],
      promptByTestItemId: new Map(),
    });

    expect(diff.previousPassRate).toBe(0.5);
    expect(diff.currentPassRate).toBe(1);
    expect(diff.scoreDelta).toBeCloseTo(0.5);
  });

  it('returns 0 pass rates for an empty run rather than dividing by zero', () => {
    const diff = computeRunComparisonDiff({
      previousItems: [],
      currentItems: [],
      promptByTestItemId: new Map(),
    });

    expect(diff.previousPassRate).toBe(0);
    expect(diff.currentPassRate).toBe(0);
    expect(diff.scoreDelta).toBe(0);
  });
});
