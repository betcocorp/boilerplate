/**
 * B0-812 / B0-813 — the scoring model's one configurable number, and the stricter line every
 * report measures itself against.
 *
 * The Result is binary and derived from the weighted score alone: Pass at `passMark` or above,
 * Fail below. Nothing else moves a Result — no concept gate, no floor, no ceiling, no automatic
 * Pass (Tom Bird, 2026-09-03: "No capping period, just pure numbers and calculations"). A missing
 * must-have concept is *reported* on the case; it lowers Completeness through coverage like any
 * other expected concept and cannot by itself fail a case.
 *
 * `STRICT_PASS_MARK` is not a second gate. It is the line the reference methodology used to fail D
 * grades on, and every report lists the cases that pass only under the current mark — the exact
 * population that would flip to Fail the day the mark is raised — so the cost of tightening is
 * visible before anyone tightens.
 */

/** Settings row, per B0-638 (never an env var). */
export const PASS_MARK_SETTING_KEY = 'REPORT_PASS_MARK';

/** Pass at 60 or above: A/B/C/D pass, only an F fails. */
export const DEFAULT_PASS_MARK = 60;

/** The stricter line reports measure against (D would fail). Reported, never applied. */
export const STRICT_PASS_MARK = 70;

/** A pass mark is a 0–100 score; anything else falls back to the shipped default. */
export function clampPassMark(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PASS_MARK;
  return Math.min(100, Math.max(0, value));
}

/**
 * Imported lazily because `settings-service` reaches the Supabase service-role client and this
 * module's constants are read by client components.
 */
export async function loadPassMark(): Promise<number> {
  const { getNumberSetting } = await import('~/lib/settings/settings-service');
  return clampPassMark(await getNumberSetting(PASS_MARK_SETTING_KEY, DEFAULT_PASS_MARK));
}

/**
 * B0-811 — reporting thresholds for the two judged metrics (methodology §7c). One source of truth,
 * mirroring the reference `judged_metrics.py` `THRESHOLDS`; each is a settings row so a run's
 * report can state exactly what it was cut at.
 *
 * - `simHigh` / `simLow` — similarity band edges.
 * - `lowConfidence` — at or below, the case joins the SME review queue.
 * - `highSimFail` / `lowSimPass` — the two off-diagonal cells worth naming: close to the ideal and
 *   still failed (shape right, substance wrong) / passed while diverging from the ideal (correct,
 *   differently worded).
 * - `corrMinN` — below this sample, no similarity-vs-score correlation is reported.
 */
export type JudgedThresholds = {
  simHigh: number;
  simLow: number;
  lowConfidence: number;
  highSimFail: number;
  lowSimPass: number;
  corrMinN: number;
};

export const DEFAULT_JUDGED_THRESHOLDS: Readonly<JudgedThresholds> = {
  simHigh: 0.75,
  simLow: 0.4,
  lowConfidence: 70,
  highSimFail: 0.6,
  lowSimPass: 0.5,
  corrMinN: 5,
};

export const JUDGED_THRESHOLD_SETTING_KEYS: Readonly<Record<keyof JudgedThresholds, string>> = {
  simHigh: 'REPORT_JUDGED_SIM_HIGH',
  simLow: 'REPORT_JUDGED_SIM_LOW',
  lowConfidence: 'REPORT_JUDGED_LOW_CONFIDENCE',
  highSimFail: 'REPORT_JUDGED_HIGH_SIM_FAIL',
  lowSimPass: 'REPORT_JUDGED_LOW_SIM_PASS',
  corrMinN: 'REPORT_JUDGED_CORR_MIN_N',
};

/** Non-finite or out-of-range values fall back to the shipped default, key by key. */
export function sanitizeJudgedThresholds(raw: Partial<JudgedThresholds>): JudgedThresholds {
  const pick = (key: keyof JudgedThresholds, min: number, max: number): number => {
    const value = raw[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
      ? value
      : DEFAULT_JUDGED_THRESHOLDS[key];
  };
  return {
    simHigh: pick('simHigh', 0, 1),
    simLow: pick('simLow', 0, 1),
    lowConfidence: pick('lowConfidence', 0, 100),
    highSimFail: pick('highSimFail', 0, 1),
    lowSimPass: pick('lowSimPass', 0, 1),
    corrMinN: Math.max(2, Math.floor(pick('corrMinN', 2, 1000))),
  };
}

export async function loadJudgedThresholds(): Promise<JudgedThresholds> {
  const { getNumberSetting } = await import('~/lib/settings/settings-service');
  const entries = await Promise.all(
    (Object.keys(JUDGED_THRESHOLD_SETTING_KEYS) as Array<keyof JudgedThresholds>).map(
      async (key) =>
        [key, await getNumberSetting(JUDGED_THRESHOLD_SETTING_KEYS[key], DEFAULT_JUDGED_THRESHOLDS[key])] as const,
    ),
  );
  return sanitizeJudgedThresholds(Object.fromEntries(entries) as Partial<JudgedThresholds>);
}
