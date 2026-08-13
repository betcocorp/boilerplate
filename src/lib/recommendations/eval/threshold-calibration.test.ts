import { describe, expect, it } from 'vitest';

import {
  computeThresholdCalibration,
  DEFAULT_CALIBRATION_THRESHOLDS,
  type ThresholdCalibrationCase,
} from '~/lib/recommendations/eval/threshold-calibration';

// Synthetic confidence/verdict fixtures — these are NOT product identity claims (no competitor
// or Betco product names), purely numeric inputs to exercise the calibration math.
const LABELED_CASES: ThresholdCalibrationCase[] = [
  { id: 'a', overallConfidence: 0.95, correct: true },
  { id: 'b', overallConfidence: 0.88, correct: true },
  { id: 'c', overallConfidence: 0.82, correct: false }, // confidently wrong — should hurt precision at low thresholds
  { id: 'd', overallConfidence: 0.79, correct: true }, // correct but just below 0.80 — hurts recall at 0.80
  { id: 'e', overallConfidence: 0.72, correct: false },
  { id: 'f', overallConfidence: 0.6, correct: null }, // no verdict yet — coverage-only
];

describe('computeThresholdCalibration', () => {
  it('sweeps the default 0.70–0.90 range', () => {
    const rows = computeThresholdCalibration(LABELED_CASES);
    expect(rows.map((r) => r.threshold)).toEqual(DEFAULT_CALIBRATION_THRESHOLDS);
  });

  it('computes coverage as answered/total regardless of labeling', () => {
    const rows = computeThresholdCalibration(LABELED_CASES, [0.7]);
    // >= 0.70: a, b, c, d, e = 5 of 6
    expect(rows[0]).toMatchObject({ totalCases: 6, answered: 5, coverage: round(5 / 6) });
  });

  it('precision excludes unlabeled cases and recall is relative to all known-correct cases', () => {
    const rows = computeThresholdCalibration(LABELED_CASES, [0.8]);
    const row = rows[0]!;
    // >= 0.80: a (true), b (true), c (false) — d (0.79) falls below.
    expect(row.answered).toBe(3);
    expect(row.labeledAnswered).toBe(3);
    expect(row.correctAnswered).toBe(2);
    expect(row.precision).toBeCloseTo(2 / 3, 3);
    // totalCorrectKnown = a, b, d = 3; only a, b answered at 0.80 → recall 2/3.
    expect(row.recall).toBeCloseTo(2 / 3, 3);
  });

  it('raising the threshold trades recall for precision here (drops the confidently-wrong case)', () => {
    const at80 = computeThresholdCalibration(LABELED_CASES, [0.8])[0]!;
    const at85 = computeThresholdCalibration(LABELED_CASES, [0.85])[0]!;
    expect(at85.answered).toBeLessThan(at80.answered);
    expect(at85.precision).toBe(1); // only a, b remain — both correct
    expect(at85.recall).toBeLessThanOrEqual(at80.recall!);
  });

  it('returns null precision/recall when no case has a verdict', () => {
    const rows = computeThresholdCalibration(
      [
        { id: 'x', overallConfidence: 0.9, correct: null },
        { id: 'y', overallConfidence: 0.6, correct: null },
      ],
      [0.8],
    );
    expect(rows[0]).toMatchObject({ answered: 1, precision: null, recall: null });
  });

  it('handles an empty case list without dividing by zero', () => {
    const rows = computeThresholdCalibration([], [0.8]);
    expect(rows[0]).toMatchObject({
      totalCases: 0,
      answered: 0,
      coverage: 0,
      precision: null,
      recall: null,
    });
  });
});

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
