import { describe, expect, it } from 'vitest';

import { planPromptMerge, type MergeSourceItem } from './merge-prompts';

const source = (id: string, prompt: string): MergeSourceItem => ({ id, prompt });

describe('planPromptMerge', () => {
  it('keeps selected items in selection order, not source order', () => {
    const plan = planPromptMerge({
      selectedIds: ['c', 'a'],
      sourceItems: [source('a', 'Alpha'), source('b', 'Bravo'), source('c', 'Charlie')],
      targetItems: [],
      nextRowIndex: 1,
    });

    expect(plan.toInsert.map((row) => row.item.id)).toEqual(['c', 'a']);
    expect(plan.skippedDuplicateCount).toBe(0);
    expect(plan.missingCount).toBe(0);
  });

  it('continues row_index from nextRowIndex consecutively', () => {
    const plan = planPromptMerge({
      selectedIds: ['a', 'b', 'c'],
      sourceItems: [source('a', 'Alpha'), source('b', 'Bravo'), source('c', 'Charlie')],
      targetItems: [],
      nextRowIndex: 42,
    });

    expect(plan.toInsert.map((row) => row.row_index)).toEqual([42, 43, 44]);
  });

  it('skips prompts that already exist in the target', () => {
    const plan = planPromptMerge({
      selectedIds: ['a', 'b'],
      sourceItems: [source('a', 'Alpha'), source('b', 'Bravo')],
      targetItems: [{ prompt: 'Alpha' }],
      nextRowIndex: 5,
    });

    expect(plan.toInsert.map((row) => row.item.id)).toEqual(['b']);
    expect(plan.toInsert[0]?.row_index).toBe(5);
    expect(plan.skippedDuplicateCount).toBe(1);
  });

  it('collapses duplicate prompts within the selection itself', () => {
    const plan = planPromptMerge({
      selectedIds: ['a', 'a2', 'b'],
      sourceItems: [source('a', 'Alpha'), source('a2', 'Alpha'), source('b', 'Bravo')],
      targetItems: [],
      nextRowIndex: 1,
    });

    expect(plan.toInsert.map((row) => row.item.id)).toEqual(['a', 'b']);
    expect(plan.toInsert.map((row) => row.row_index)).toEqual([1, 2]);
    expect(plan.skippedDuplicateCount).toBe(1);
  });

  it('counts selected ids that are not in the source as missing', () => {
    const plan = planPromptMerge({
      selectedIds: ['a', 'ghost', 'other-test-item'],
      sourceItems: [source('a', 'Alpha')],
      targetItems: [],
      nextRowIndex: 1,
    });

    expect(plan.toInsert.map((row) => row.item.id)).toEqual(['a']);
    expect(plan.missingCount).toBe(2);
    expect(plan.skippedDuplicateCount).toBe(0);
  });

  it('treats duplicates as whitespace- and case-insensitive', () => {
    const plan = planPromptMerge({
      selectedIds: ['a', 'b', 'c'],
      sourceItems: [
        source('a', '  How do I dilute Green Earth?  '),
        source('b', 'how do i dilute green earth?'),
        source('c', 'Something else'),
      ],
      targetItems: [{ prompt: 'HOW DO I DILUTE GREEN EARTH?' }],
      nextRowIndex: 3,
    });

    expect(plan.toInsert.map((row) => row.item.id)).toEqual(['c']);
    expect(plan.toInsert[0]?.row_index).toBe(3);
    expect(plan.skippedDuplicateCount).toBe(2);
  });

  it('returns an empty plan when everything is a duplicate, without touching counts elsewhere', () => {
    const plan = planPromptMerge({
      selectedIds: ['a'],
      sourceItems: [source('a', 'Alpha')],
      targetItems: [{ prompt: 'alpha' }],
      nextRowIndex: 1,
    });

    expect(plan.toInsert).toEqual([]);
    expect(plan.skippedDuplicateCount).toBe(1);
    expect(plan.missingCount).toBe(0);
  });
});
