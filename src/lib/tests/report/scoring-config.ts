import { z } from 'zod';

/**
 * B0-812 / B0-835 — the scoring model's configuration: the Pass/Fail line, the stricter line every
 * report measures itself against, and the four deterministic concept rules.
 *
 * **B0-835 (Tom Bird, 2026-09-04) reverses the B0-813 "pure math" decision.** Bex adopts the
 * reference agent-evaluation skill's rules verbatim, so a Bex report and a desktop report of the
 * same run read the same. The Result is therefore no longer derived from the weighted score alone;
 * four named rules act on the score before it, in this fixed order (methodology §2b Rule 4 step 7):
 *
 * 1. **`expectedCoverage`** caps Completeness at the share of expected concepts the answer covered,
 *    so missing expected content reduces the grade proportionally.
 * 2. the four sub-scores are weighted.
 * 3. **`minimalFloor`** raises a fully-mandatory-covered answer to at least 70 (a C) — withheld
 *    when a material factual issue is flagged, if `respectMaterialIssue`.
 * 4. **`minimalCeiling`** caps an answer missing any mandatory concept at 59, so its letter is F
 *    and its Result Fail *by arithmetic* rather than by overriding either. The uncapped value
 *    survives as the per-case Pre-Gate Content Score, a diagnostic that never enters an average.
 *
 * **`minimalGate`** is the safety rule those two express: a case missing a must-have concept is
 * rated Fail whatever its score, and it outranks the automatic Pass that full expected coverage
 * earns. Disabling the gate also disables the ceiling — the ceiling exists to make the gate's
 * verdict visible in the number, so it must not fire where the gate does not.
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
 * B0-835 — the four deterministic concept rules, ported field-for-field from the reference skill's
 * `concept_rules.py` `SCORING_DEFAULTS` (minus its `pass_mark`, which is `DEFAULT_PASS_MARK` above).
 *
 * - `minimalGate` — a case missing ANY mandatory concept is rated Fail, whatever its score.
 * - `minimalFloor` — a case satisfying EVERY mandatory concept scores at least `score`;
 *   `respectMaterialIssue` withdraws that protection when a material factual issue is flagged, so
 *   full must-have coverage can never shield a wrong dilution, contact time, ppm, CAS or EPA
 *   registration number from scoring below a C.
 * - `minimalCeiling` — a case missing any mandatory concept is capped at `score`, which is what
 *   keeps the number, the letter and the Result in agreement instead of printing "B / Fail".
 * - `expectedCoverage` — Completeness is capped at the expected-concept coverage achieved.
 */
export type ScoringRules = {
  minimalGate: { enabled: boolean };
  minimalFloor: { enabled: boolean; score: number; respectMaterialIssue: boolean };
  minimalCeiling: { enabled: boolean; score: number };
  expectedCoverage: { enabled: boolean };
};

/** Every rule on, at the reference skill's numbers. The shipped default for every report. */
export const DEFAULT_SCORING_RULES: Readonly<ScoringRules> = {
  minimalGate: { enabled: true },
  minimalFloor: { enabled: true, score: 70, respectMaterialIssue: true },
  minimalCeiling: { enabled: true, score: 59 },
  expectedCoverage: { enabled: true },
};

/** Settings rows, per B0-638 (never env vars). One row per knob, flat, so each is togglable alone. */
export const SCORING_RULE_SETTING_KEYS = {
  minimalGateEnabled: 'REPORT_MINIMAL_GATE_ENABLED',
  minimalFloorEnabled: 'REPORT_MINIMAL_FLOOR_ENABLED',
  minimalFloorScore: 'REPORT_MINIMAL_FLOOR_SCORE',
  minimalFloorRespectMaterialIssue: 'REPORT_MINIMAL_FLOOR_RESPECT_MATERIAL_ISSUE',
  minimalCeilingEnabled: 'REPORT_MINIMAL_CEILING_ENABLED',
  minimalCeilingScore: 'REPORT_MINIMAL_CEILING_SCORE',
  expectedCoverageEnabled: 'REPORT_EXPECTED_COVERAGE_ENABLED',
} as const;

/** The persisted/wire shape of `ScoringRules`. Exact — a report says what it was scored under. */
export const scoringRulesSchema = z.object({
  minimalGate: z.object({ enabled: z.boolean() }),
  minimalFloor: z.object({
    enabled: z.boolean(),
    score: z.number(),
    respectMaterialIssue: z.boolean(),
  }),
  minimalCeiling: z.object({ enabled: z.boolean(), score: z.number() }),
  expectedCoverage: z.object({ enabled: z.boolean() }),
});

/**
 * Non-finite, out-of-range (a rule score is a 0–100 score) or non-boolean values fall back to the
 * shipped default **key by key**, exactly as `sanitizeJudgedThresholds` does: one bad settings row
 * must not silently disable a whole safety rule.
 */
export function sanitizeScoringRules(raw: unknown): ScoringRules {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const section = (key: keyof ScoringRules): Record<string, unknown> => {
    const value = source[key];
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  };
  const bool = (key: keyof ScoringRules, field: string, fallback: boolean): boolean => {
    const value = section(key)[field];
    return typeof value === 'boolean' ? value : fallback;
  };
  const score = (key: keyof ScoringRules, fallback: number): number => {
    const value = section(key).score;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : fallback;
  };
  return {
    minimalGate: {
      enabled: bool('minimalGate', 'enabled', DEFAULT_SCORING_RULES.minimalGate.enabled),
    },
    minimalFloor: {
      enabled: bool('minimalFloor', 'enabled', DEFAULT_SCORING_RULES.minimalFloor.enabled),
      score: score('minimalFloor', DEFAULT_SCORING_RULES.minimalFloor.score),
      respectMaterialIssue: bool(
        'minimalFloor',
        'respectMaterialIssue',
        DEFAULT_SCORING_RULES.minimalFloor.respectMaterialIssue,
      ),
    },
    minimalCeiling: {
      enabled: bool('minimalCeiling', 'enabled', DEFAULT_SCORING_RULES.minimalCeiling.enabled),
      score: score('minimalCeiling', DEFAULT_SCORING_RULES.minimalCeiling.score),
    },
    expectedCoverage: {
      enabled: bool(
        'expectedCoverage',
        'enabled',
        DEFAULT_SCORING_RULES.expectedCoverage.enabled,
      ),
    },
  };
}

/**
 * The rules in force, from the settings table. Imported lazily for the same reason
 * `loadPassMark`/`loadJudgedThresholds` are: `settings-service` reaches the Supabase service-role
 * client and this module's constants and types are read by client components.
 */
export async function loadScoringRules(): Promise<ScoringRules> {
  const { getBooleanSetting, getNumberSetting } = await import('~/lib/settings/settings-service');
  const K = SCORING_RULE_SETTING_KEYS;
  const D = DEFAULT_SCORING_RULES;
  const [
    minimalGateEnabled,
    minimalFloorEnabled,
    minimalFloorScore,
    minimalFloorRespectMaterialIssue,
    minimalCeilingEnabled,
    minimalCeilingScore,
    expectedCoverageEnabled,
  ] = await Promise.all([
    getBooleanSetting(K.minimalGateEnabled, D.minimalGate.enabled),
    getBooleanSetting(K.minimalFloorEnabled, D.minimalFloor.enabled),
    getNumberSetting(K.minimalFloorScore, D.minimalFloor.score),
    getBooleanSetting(K.minimalFloorRespectMaterialIssue, D.minimalFloor.respectMaterialIssue),
    getBooleanSetting(K.minimalCeilingEnabled, D.minimalCeiling.enabled),
    getNumberSetting(K.minimalCeilingScore, D.minimalCeiling.score),
    getBooleanSetting(K.expectedCoverageEnabled, D.expectedCoverage.enabled),
  ]);

  return sanitizeScoringRules({
    minimalGate: { enabled: minimalGateEnabled },
    minimalFloor: {
      enabled: minimalFloorEnabled,
      score: minimalFloorScore,
      respectMaterialIssue: minimalFloorRespectMaterialIssue,
    },
    minimalCeiling: { enabled: minimalCeilingEnabled, score: minimalCeilingScore },
    expectedCoverage: { enabled: expectedCoverageEnabled },
  });
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
