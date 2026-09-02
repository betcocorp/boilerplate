/**
 * B0-97 — threshold calibration for the cross-reference recommendation answer gate.
 *
 * Pure, data-agnostic sweep over candidate `XREF_RECOMMENDATION_MIN_CONFIDENCE` values: for each
 * threshold, computes how many cases would be answered (coverage) and, where a correctness verdict
 * is known, precision (of answered cases, how many were actually correct) and recall (of all cases
 * known to have a correct Betco equivalent, how many are answered at this threshold).
 *
 * Deliberately does NOT ship with any embedded "known correct equivalent" product data — callers
 * supply `cases` from a labeled source (harness `test_items` + human-reviewed results, or a
 * DB export of `rag.cross_reference_recommendations` once reviewer verdicts exist). A case with
 * `correct: null` (no verdict yet) still counts toward coverage but is excluded from precision/recall
 * — see `src/docs/cross-reference-recommendations.md` (B0-97 section) for why that distinction
 * matters for this dataset today.
 */

export type ThresholdCalibrationCase = {
  id: string;
  /** overallConfidence produced by `scoreRecommendation` (or the legacy match confidence). */
  overallConfidence: number;
  /**
   * Whether the top-ranked recommendation is actually the correct Betco equivalent.
   * `null` means no ground-truth verdict is available yet (coverage-only case).
   */
  correct: boolean | null;
};

export type ThresholdCalibrationRow = {
  threshold: number;
  totalCases: number;
  answered: number;
  /** answered / totalCases. */
  coverage: number;
  /** Answered cases that also carry a known correct/incorrect verdict. */
  labeledAnswered: number;
  correctAnswered: number;
  /**
   * Answered AND labeled incorrect — a wrong Betco equivalent that reached the user. This is the
   * failure mode the precision target exists to bound; surfaced as a raw count because at small n
   * a single one moves precision by tens of points.
   */
  falsePositives: number;
  /** Declined despite being labeled correct — a good answer withheld (the recall cost). */
  falseNegatives: number;
  /** correctAnswered / labeledAnswered. `null` when no answered case has a verdict yet. */
  precision: number | null;
  /** correctAnswered / (all cases labeled correct, regardless of threshold). `null` when no case has `correct: true`. */
  recall: number | null;
  /** Harmonic mean of precision and recall. `null` when either is null or both are 0. */
  f1: number | null;
};

export const DEFAULT_CALIBRATION_THRESHOLDS = [0.7, 0.75, 0.8, 0.85, 0.9];

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Inclusive sweep, e.g. `buildThresholdSweep(0.7, 0.9, 0.01)` → 21 thresholds. Values are rounded
 * to 3dp so floating-point accumulation cannot produce `0.7300000000000001` as a table label.
 */
export function buildThresholdSweep(min: number, max: number, step: number): number[] {
  if (!(step > 0) || max < min) return [];
  const out: number[] = [];
  for (let i = 0; ; i += 1) {
    const value = round3(min + i * step);
    if (value > round3(max) + Number.EPSILON) break;
    out.push(value);
  }
  return out;
}

export function computeThresholdCalibration(
  cases: ThresholdCalibrationCase[],
  thresholds: number[] = DEFAULT_CALIBRATION_THRESHOLDS,
): ThresholdCalibrationRow[] {
  const totalCorrectKnown = cases.filter((c) => c.correct === true).length;

  return thresholds.map((threshold) => {
    const answeredCases = cases.filter((c) => c.overallConfidence >= threshold);
    const labeledAnswered = answeredCases.filter((c) => c.correct !== null);
    const correctAnswered = answeredCases.filter((c) => c.correct === true);
    const falsePositives = answeredCases.filter((c) => c.correct === false).length;

    const precision =
      labeledAnswered.length > 0 ? round3(correctAnswered.length / labeledAnswered.length) : null;
    const recall =
      totalCorrectKnown > 0 ? round3(correctAnswered.length / totalCorrectKnown) : null;

    return {
      threshold,
      totalCases: cases.length,
      answered: answeredCases.length,
      coverage: cases.length > 0 ? round3(answeredCases.length / cases.length) : 0,
      labeledAnswered: labeledAnswered.length,
      correctAnswered: correctAnswered.length,
      falsePositives,
      falseNegatives: totalCorrectKnown - correctAnswered.length,
      precision,
      recall,
      f1:
        precision !== null && recall !== null && precision + recall > 0
          ? round3((2 * precision * recall) / (precision + recall))
          : null,
    };
  });
}

export type ThresholdSelection =
  | {
      chosen: true;
      threshold: number;
      row: ThresholdCalibrationRow;
      /** How many labeled-answered cases backed the winning row — the honesty check on `threshold`. */
      labeledAnswered: number;
    }
  | { chosen: false; reason: string };

/**
 * Pick the operating threshold from a computed curve: the LOWEST threshold whose precision meets
 * `minPrecision`, because among thresholds that clear the precision bar the lowest one answers the
 * most questions (highest coverage/recall). Rows whose precision is `null` (no labeled answered
 * case) are never eligible — an unlabeled row cannot clear a precision bar.
 *
 * `minLabeledAnswered` guards the small-n trap: at n=1 a single correct answer reads as precision
 * 1.0, which is not evidence. Callers that cannot meet it get `chosen: false` and must say so
 * rather than quoting the number.
 */
export function selectThreshold(
  rows: ThresholdCalibrationRow[],
  options: { minPrecision: number; minLabeledAnswered?: number },
): ThresholdSelection {
  const minLabeledAnswered = options.minLabeledAnswered ?? 1;
  const eligible = rows
    .filter((r) => r.precision !== null && r.precision >= options.minPrecision)
    .sort((a, b) => a.threshold - b.threshold);

  if (eligible.length === 0) {
    return {
      chosen: false,
      reason: `No threshold in the sweep reached precision >= ${options.minPrecision}.`,
    };
  }

  const row = eligible[0]!;
  if (row.labeledAnswered < minLabeledAnswered) {
    return {
      chosen: false,
      reason:
        `Threshold ${row.threshold} met precision >= ${options.minPrecision}, but on only ` +
        `${row.labeledAnswered} labeled answered case(s) (need >= ${minLabeledAnswered}). ` +
        `Insufficient evidence to set the gate from this data.`,
    };
  }

  return { chosen: true, threshold: row.threshold, row, labeledAnswered: row.labeledAnswered };
}
