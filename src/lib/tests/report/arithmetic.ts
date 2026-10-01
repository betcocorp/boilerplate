import { DEFAULT_PASS_MARK } from './scoring-config';

/**
 * B0-835 — the report's pure arithmetic primitives, extracted from `./metrics` so the concept
 * scoring rules (`./scoring-rules`) can reach the weighting, the grade bands and the rounding
 * convention without a runtime import cycle back through the metrics module that consumes them.
 *
 * Nothing here knows about concepts, gates, floors or ceilings: it is the weighting, the two
 * lookup tables (grade bands, the Pass/Fail line) and the rounding helpers, and that is all.
 * `./metrics` re-exports every symbol in this file, so no existing importer changed.
 */

/**
 * Sub-score weighting for the 0-100 roll-up. Exported (B0-591) so the report UI can state the
 * weighting from the same constant the computation uses, rather than restating it as prose.
 */
export const WEIGHTS = {
  accuracy: 0.4,
  completeness: 0.3,
  relevance: 0.2,
  clarity: 0.1,
} as const;

/** The shape of `WEIGHTS`, so `./invariants` can be handed them without importing this module. */
export type SubScoreWeights = typeof WEIGHTS;

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
/** Binary by design (methodology §2): a middle category invites "is that good or bad?". */
export type CaseStatus = 'Pass' | 'Fail';

/**
 * Letter-grade bands, highest first, each as the inclusive minimum weighted score that earns it.
 * Exported (B0-591) so the report's stated methodology reads the same numbers `gradeFromScore`
 * applies and the two can never drift apart. The last band is the 0 floor.
 */
export const GRADE_BANDS: ReadonlyArray<{ grade: Grade; min: number }> = [
  { grade: 'A', min: 90 },
  { grade: 'B', min: 80 },
  { grade: 'C', min: 70 },
  { grade: 'D', min: 60 },
  { grade: 'F', min: 0 },
];

export function gradeFromScore(score: number): Grade {
  for (const band of GRADE_BANDS) {
    if (score >= band.min) return band.grade;
  }
  return 'F';
}

/** Pass at the mark or above, Fail below. The one place the Result is decided. */
export function statusFromScore(score: number, passMark: number = DEFAULT_PASS_MARK): CaseStatus {
  return score >= passMark ? 'Pass' : 'Fail';
}

/**
 * B0-814 — the rounding convention, in one place: **half-up, as JS `Math.round`**, applied once at
 * the end of each computation. Bex is the spec; the reference skill's Python (whose built-in
 * `round()` is half-to-even) is to adopt this, not the other way round (B0-827).
 *
 * Precision by kind of number — every rounding in this folder goes through one of these:
 * - `roundScore` (integer): sub-scores, `overall`, Completeness, consolidated evaluator confidence.
 * - `round1` (one decimal): averages, medians, pass/fail percentages, seconds.
 * - `round2` (two decimals): similarity (0–1), Pearson r, renormalized speed weights.
 *
 * **Python port** (`decimal`, `ROUND_HALF_UP`). Each helper scales in binary floating point, rounds
 * the *scaled double* half-up to an integer, then divides — so the exact equivalent does the same,
 * in the same order:
 *
 *     from decimal import Decimal, ROUND_HALF_UP
 *     def round_to(x: float, digits: int) -> float:
 *         factor = 10 ** digits
 *         scaled = Decimal(str(x * factor)).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
 *         return float(scaled) / factor
 *
 * For integers there is no scaling, so `Decimal(str(x)).quantize(Decimal('1'), ROUND_HALF_UP)` is
 * exact for x ≥ 0. For one/two decimals, quantizing the *unscaled* value
 * (`Decimal(str(x)).quantize(Decimal('0.01'))`) is NOT equivalent: it rounds the shortest decimal
 * spelling of `x`, not the double that `x * factor` produces. The two agree wherever the scaled
 * value is an exact half (2.45 → 2.5, 2.55 → 2.6, 0.665 → 0.67, 0.125 → 0.13) and disagree
 * wherever it is not: `1.005 * 100` is `100.49999999999999` in IEEE-754, so Bex gives 1.00 where
 * `Decimal('1.005')` gives 1.01 (checked: 0 mismatches across 7,000 sampled values for the scaled
 * form, 116 for the unscaled form at two decimals). No epsilon is added here to "fix" that — Bex is
 * the spec, and an epsilon would put the two out of step in the other direction.
 *
 * **Sign.** `Math.round` rounds a negative half toward +∞ (−12.5 → −12, −0.4 → −0), whereas
 * `ROUND_HALF_UP` rounds away from zero (−12.5 → −13). Every value routed here is ≥ 0 — scores,
 * coverage shares, percentages, similarity, seconds, weights — with one exception: the
 * similarity-vs-score Pearson r (`round2`) can be negative. That divergence is accepted and named
 * rather than patched: it can only move r by 0.01, only on an exact negative half. A Python port
 * that wants Bex's sign handling too uses `math.floor(x * factor + 0.5) / factor`, which matched
 * `Math.round` on every sampled value of either sign. A `-0` result serialises as `0` in JSON.
 */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Integer scores: sub-scores, `overall`, Completeness, consolidated evaluator confidence. */
export function roundScore(value: number): number {
  return roundTo(value, 0);
}

/** One decimal: averages, medians, percentages, seconds. */
export function round1(value: number): number {
  return roundTo(value, 1);
}

/** Two decimals: similarity, Pearson r, speed weights. */
export function round2(value: number): number {
  return roundTo(value, 2);
}

export type SubScores = {
  accuracy: number;
  completeness: number;
  relevance: number;
  clarity: number;
};

/** `0.40·A + 0.30·C + 0.20·R + 0.10·Cl`, rounded once. The whole of the content score. */
export function computeOverall(subs: SubScores): number {
  return roundScore(
    WEIGHTS.accuracy * subs.accuracy +
      WEIGHTS.completeness * subs.completeness +
      WEIGHTS.relevance * subs.relevance +
      WEIGHTS.clarity * subs.clarity,
  );
}