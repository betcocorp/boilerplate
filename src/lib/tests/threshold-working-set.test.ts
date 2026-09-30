import { describe, expect, it } from 'vitest';

import type { LatestItemScores } from '~/lib/tests/latest-item-scores';
import {
  itemQualifiesForThreshold,
  parseScoreThresholdField,
  SCORE_THRESHOLD_FIELD_ERROR,
  selectThresholdWorkingSet,
} from '~/lib/tests/threshold-working-set';

describe('parseScoreThresholdField (B0-1102)', () => {
  it.each([null, '', '   '])('blank/absent (%j) means no threshold — a full run', (value) => {
    expect(parseScoreThresholdField(value)).toEqual({ ok: true, threshold: undefined });
  });

  it.each([
    ['0', 0],
    ['75', 75],
    [' 75 ', 75],
    ['100', 100],
  ])('accepts %j as %d', (value, expected) => {
    expect(parseScoreThresholdField(value)).toEqual({ ok: true, threshold: expected });
  });

  it.each(['101', '-1', '7.5', 'abc', '1e2x'])('rejects %j with the field message', (value) => {
    expect(parseScoreThresholdField(value)).toEqual({
      ok: false,
      error: SCORE_THRESHOLD_FIELD_ERROR,
    });
  });

  it('rejects a file entry rather than treating it as blank', () => {
    const file = new File(['75'], 'threshold.txt');
    expect(parseScoreThresholdField(file)).toEqual({ ok: true, threshold: undefined });
  });
});

describe('itemQualifiesForThreshold', () => {
  it('is strictly below: a score equal to the threshold does not qualify', () => {
    expect(itemQualifiesForThreshold({ overall: 75, asOfRunId: 'r' }, 75)).toBe(false);
    expect(itemQualifiesForThreshold({ overall: 74, asOfRunId: 'r' }, 75)).toBe(true);
    expect(itemQualifiesForThreshold({ overall: 76, asOfRunId: 'r' }, 75)).toBe(false);
  });

  it('always includes an item with no number — never run, or Unable to Evaluate', () => {
    expect(itemQualifiesForThreshold(undefined, 0)).toBe(true);
    expect(itemQualifiesForThreshold({ overall: null, asOfRunId: 'r' }, 0)).toBe(true);
  });
});

describe('selectThresholdWorkingSet', () => {
  const items = [
    { id: 'high', prompt: 'scored 90' },
    { id: 'low', prompt: 'scored 40' },
    { id: 'edge', prompt: 'scored exactly 75' },
    { id: 'ute', prompt: 'unable to evaluate' },
    { id: 'never', prompt: 'never run' },
  ];
  const scores: LatestItemScores = new Map([
    ['high', { overall: 90, asOfRunId: 'run-1' }],
    ['low', { overall: 40, asOfRunId: 'run-1' }],
    ['edge', { overall: 75, asOfRunId: 'run-2' }],
    ['ute', { overall: null, asOfRunId: 'run-1' }],
  ]);

  it('keeps sub-threshold, UTE and never-run items, in row order, and drops the rest', () => {
    expect(selectThresholdWorkingSet(items, scores, 75).map((i) => i.id)).toEqual([
      'low',
      'ute',
      'never',
    ]);
  });

  it('threshold 0 keeps only items with no number', () => {
    expect(selectThresholdWorkingSet(items, scores, 0).map((i) => i.id)).toEqual(['ute', 'never']);
  });

  it('a set with no scores at all qualifies in full (Tom: still a partial run)', () => {
    expect(selectThresholdWorkingSet(items, new Map(), 50)).toEqual(items);
  });

  it('returns the same item objects it was given', () => {
    const [first] = selectThresholdWorkingSet(items, scores, 75);
    expect(first).toBe(items[1]);
  });
});
