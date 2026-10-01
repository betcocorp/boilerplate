import { z } from 'zod';

import type { LatestItemScore, LatestItemScores } from '~/lib/tests/latest-item-scores';

/**
 * B0-1102 — which items a threshold-filtered ("partial") golden run re-runs.
 *
 * Pure: the server action (`runGoldenTestsAction`) hands it the set's items and the per-item
 * latest scores from `getLatestItemScores` (B0-1101); the fold rules live there, the qualifying
 * rule lives here, and neither touches the database.
 */

/**
 * The dialog's optional "Only re-run items scoring below" field: an integer on the 0–100 report
 * scale. Blank means "no threshold" and is handled before this schema is consulted.
 */
export const scoreThresholdSchema = z.coerce.number().int().min(0).max(100);

export const SCORE_THRESHOLD_FIELD_ERROR =
  'The score threshold must be a whole number from 0 to 100, or left blank.';

export type ParsedScoreThresholdField =
  | { ok: true; threshold: number | undefined }
  | { ok: false; error: string };

/**
 * Blank / absent → `undefined` (a full run, exactly as before the field existed). Anything else
 * must parse as a 0–100 integer; a hand-crafted POST with garbage gets a message, never a 500 and
 * never a silent full run.
 */
export function parseScoreThresholdField(
  value: FormDataEntryValue | null,
): ParsedScoreThresholdField {
  if (value === null || typeof value !== 'string' || value.trim() === '') {
    return { ok: true, threshold: undefined };
  }

  const parsed = scoreThresholdSchema.safeParse(value.trim());
  return parsed.success
    ? { ok: true, threshold: parsed.data }
    : { ok: false, error: SCORE_THRESHOLD_FIELD_ERROR };
}

/**
 * Tom's rule (B0-1099 grill): an item qualifies when its latest displayed `overall` is strictly
 * below the threshold, OR it has no number at all — never run, or Unable to Evaluate on its latest
 * grading. Absent and `overall: null` are treated alike.
 */
export function itemQualifiesForThreshold(
  score: LatestItemScore | undefined,
  threshold: number,
): boolean {
  if (!score || score.overall === null) {
    return true;
  }
  return score.overall < threshold;
}

/** The items to dispatch, in the order they were given (row order). */
export function selectThresholdWorkingSet<T extends { id: string }>(
  items: readonly T[],
  scores: LatestItemScores,
  threshold: number,
): T[] {
  return items.filter((item) => itemQualifiesForThreshold(scores.get(item.id), threshold));
}
