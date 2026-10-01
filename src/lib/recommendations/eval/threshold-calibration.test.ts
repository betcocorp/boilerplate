import { describe, expect, it } from 'vitest';

import {
  buildThresholdSweep,
  computeDiscrimination,
  computeThresholdCalibration,
  DEFAULT_CALIBRATION_THRESHOLDS,
  selectThreshold,
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

describe('buildThresholdSweep', () => {
  it('is inclusive of both ends and free of float drift', () => {
    const sweep = buildThresholdSweep(0.7, 0.9, 0.01);
    expect(sweep).toHaveLength(21);
    expect(sweep[0]).toBe(0.7);
    expect(sweep.at(-1)).toBe(0.9);
    // 0.7 + 3*0.01 accumulates to 0.7300000000000001 without rounding.
    expect(sweep[3]).toBe(0.73);
  });

  it('returns an empty sweep for a non-positive step or inverted range', () => {
    expect(buildThresholdSweep(0.7, 0.9, 0)).toEqual([]);
    expect(buildThresholdSweep(0.9, 0.7, 0.01)).toEqual([]);
  });
});

describe('falsePositives / falseNegatives / f1', () => {
  it('counts an answered-but-wrong case as a false positive', () => {
    const row = computeThresholdCalibration(LABELED_CASES, [0.8])[0]!;
    expect(row.falsePositives).toBe(1); // c: 0.82, correct false
    expect(row.falseNegatives).toBe(1); // d: 0.79, correct true but declined
    expect(row.f1).toBeCloseTo(2 / 3, 3);
  });

  it('reports no false positives once the confidently-wrong case is gated out', () => {
    const row = computeThresholdCalibration(LABELED_CASES, [0.85])[0]!;
    expect(row.falsePositives).toBe(0);
  });

  it('leaves f1 null when precision is unknown', () => {
    const rows = computeThresholdCalibration([{ id: 'x', overallConfidence: 0.9, correct: null }], [
      0.8,
    ]);
    expect(rows[0]!.f1).toBeNull();
  });
});

describe('selectThreshold', () => {
  const rows = computeThresholdCalibration(LABELED_CASES, buildThresholdSweep(0.7, 0.9, 0.01));

  it('picks the LOWEST threshold clearing the precision bar, to maximise coverage', () => {
    const selection = selectThreshold(rows, { minPrecision: 1, minLabeledAnswered: 1 });
    expect(selection.chosen).toBe(true);
    // c (0.82, wrong) is the last false positive, so precision hits 1.0 at 0.83.
    if (selection.chosen) expect(selection.threshold).toBe(0.83);
  });

  it('refuses to recommend when the winning row rests on too few labeled cases', () => {
    const selection = selectThreshold(rows, { minPrecision: 1, minLabeledAnswered: 20 });
    expect(selection.chosen).toBe(false);
    if (!selection.chosen) expect(selection.reason).toMatch(/Insufficient evidence/);
  });

  it('refuses when no threshold reaches the target precision', () => {
    const selection = selectThreshold(
      computeThresholdCalibration(
        [
          { id: 'w1', overallConfidence: 0.95, correct: false },
          { id: 'w2', overallConfidence: 0.85, correct: false },
        ],
        [0.8, 0.9],
      ),
      { minPrecision: 0.9 },
    );
    expect(selection.chosen).toBe(false);
    if (!selection.chosen) expect(selection.reason).toMatch(/No threshold/);
  });

  it('never selects a row whose precision is unknown', () => {
    const unlabeled = computeThresholdCalibration(
      [{ id: 'u', overallConfidence: 0.9, correct: null }],
      [0.8, 0.9],
    );
    expect(selectThreshold(unlabeled, { minPrecision: 0.5 }).chosen).toBe(false);
  });
});

describe('computeDiscrimination (B0-795)', () => {
  it('reports AUC 1 when every correct case outranks every wrong one', () => {
    const d = computeDiscrimination([
      { id: 'a', overallConfidence: 0.9, correct: true },
      { id: 'b', overallConfidence: 0.8, correct: true },
      { id: 'c', overallConfidence: 0.4, correct: false },
      { id: 'd', overallConfidence: 0.3, correct: false },
    ]);
    expect(d).toMatchObject({ auc: 1, positives: 2, negatives: 2, labeled: 4 });
    expect(d.meanConfidenceCorrect).toBe(0.85);
    expect(d.meanConfidenceWrong).toBe(0.35);
  });

  it('reports AUC 0 when the ranking is exactly inverted', () => {
    expect(
      computeDiscrimination([
        { id: 'a', overallConfidence: 0.1, correct: true },
        { id: 'b', overallConfidence: 0.9, correct: false },
      ]).auc,
    ).toBe(0);
  });

  it('counts ties as half, so an all-tied score reads as coin-flip', () => {
    expect(
      computeDiscrimination([
        { id: 'a', overallConfidence: 0.5, correct: true },
        { id: 'b', overallConfidence: 0.5, correct: false },
        { id: 'c', overallConfidence: 0.5, correct: false },
      ]).auc,
    ).toBe(0.5);
  });

  it('handles partial ties via midranks', () => {
    // One positive at 0.6 against negatives at 0.6 and 0.4: beats one outright, ties the other.
    expect(
      computeDiscrimination([
        { id: 'a', overallConfidence: 0.6, correct: true },
        { id: 'b', overallConfidence: 0.6, correct: false },
        { id: 'c', overallConfidence: 0.4, correct: false },
      ]).auc,
    ).toBe(0.75);
  });

  it('excludes unlabeled cases and returns null AUC when a class is empty', () => {
    const d = computeDiscrimination([
      { id: 'a', overallConfidence: 0.9, correct: true },
      { id: 'u', overallConfidence: 0.5, correct: null },
    ]);
    expect(d).toMatchObject({ labeled: 1, positives: 1, negatives: 0, auc: null });
    expect(d.meanConfidenceWrong).toBeNull();
  });

  it('returns null AUC for an entirely unlabeled set rather than implying a result', () => {
    expect(
      computeDiscrimination([{ id: 'u', overallConfidence: 0.5, correct: null }]),
    ).toMatchObject({ labeled: 0, auc: null });
  });
});

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
