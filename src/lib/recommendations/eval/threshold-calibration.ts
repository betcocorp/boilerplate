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
  /** correctAnswered / labeledAnswered. `null` when no answered case has a verdict yet. */
  precision: number | null;
  /** correctAnswered / (all cases labeled correct, regardless of threshold). `null` when no case has `correct: true`. */
  recall: number | null;
};

export const DEFAULT_CALIBRATION_THRESHOLDS = [0.7, 0.75, 0.8, 0.85, 0.9];

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
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

    return {
      threshold,
      totalCases: cases.length,
      answered: answeredCases.length,
      coverage: cases.length > 0 ? round3(answeredCases.length / cases.length) : 0,
      labeledAnswered: labeledAnswered.length,
      correctAnswered: correctAnswered.length,
      precision:
        labeledAnswered.length > 0
          ? round3(correctAnswered.length / labeledAnswered.length)
          : null,
      recall:
        totalCorrectKnown > 0 ? round3(correctAnswered.length / totalCorrectKnown) : null,
    };
  });
}
