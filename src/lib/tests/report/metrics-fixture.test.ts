import { describe, expect, it } from 'vitest';

import expectedFixture from './__fixtures__/report-metrics-12cef5c4.expected.json';
import inputFixture from './__fixtures__/report-metrics-12cef5c4.input.json';
import {
  completenessFromCoverage,
  computeReportMetrics,
  gradeFromScore,
  WEIGHTS,
  type ComputeReportMetricsOptions,
  type ReportCaseInput,
  type ReportMetrics,
} from './metrics';
import type { ReportState } from './schemas';

/**
 * B0-823 — arithmetic parity, frozen against a real run.
 *
 * Bex is the spec (Tom Bird, 2026-09-03). The diff against the reference skill's
 * `compute_metrics.py` is deferred until the skill adopts pure-math scoring (B0-827), so what pins
 * the spec in CI today is Bex's own arithmetic over a real graded run: the exact `ReportCaseInput[]`
 * the report assembly hands `computeReportMetrics`, and the metrics it produced, both frozen. Any
 * change to a weight, a rounding, the coverage rule or the pass mark fails here, without Python.
 *
 * Provenance
 * - Run `12cef5c4-ac57-4001-a20b-44a1aae8bdaa` of test "Product Specialist Top 20 (Less Complex)"
 *   (`/admin/tests/c9729de8-7557-4123-9143-8c500c8ea759/runs/12cef5c4-ac57-4001-a20b-44a1aae8bdaa`).
 * - Graded on `claude-opus-5` at effort `high`, 3 passes, pass mark 60, spread threshold 10,
 *   grading prompt `e2612b27…`; exported 2026-09-03 from app version 2.19.0.
 * - The report's own status is `failed` only because its final synthesis call hit an Anthropic
 *   credit error; all 20 cases have 3 graded passes. The same error cut pass 3 short for 11 cases
 *   (their third pass is Unable to Evaluate with a "Grading call failed" reason), which is why 11
 *   cases carry an `evaluability` flag — each is still graded from its two good passes.
 * - Free text is verbatim, untruncated: concept phrases are regulated data and are asserted back
 *   as such below. Nothing in either file is a timestamp or a generated id.
 *
 * Regenerate (rewrites both fixture files; the exporter refuses to write an input that does not
 * reproduce `assembleReportCases().metrics`, so the frozen input can never disagree with the report):
 *
 *   npx tsx --env-file=.env.local scripts/export-eval-json.ts 12cef5c4-ac57-4001-a20b-44a1aae8bdaa \
 *     --fixture src/lib/tests/report/__fixtures__
 *
 * A regeneration that moves the headline numbers pinned below is a spec change: make it on purpose
 * and update those values in the same commit.
 */

type FixtureInput = {
  state: Pick<ReportState, 'passes' | 'passMark' | 'spreadThreshold' | 'judgedThresholds'>;
  options: ComputeReportMetricsOptions;
  inputs: ReportCaseInput[];
};

const fixture = inputFixture as unknown as FixtureInput;
const expected = expectedFixture as unknown as ReportMetrics;

/** JSON round-trip, as the fixture file is: drops `undefined` keys so `toEqual` compares like with like. */
function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const JUDGED_THRESHOLDS = {
  simHigh: 0.75,
  simLow: 0.4,
  lowConfidence: 70,
  highSimFail: 0.6,
  lowSimPass: 0.5,
  corrMinN: 5,
};

describe('computeReportMetrics — frozen run 12cef5c4 (B0-823)', () => {
  const metrics = viaJson(computeReportMetrics(fixture.inputs, fixture.options));

  it('reproduces the frozen metrics exactly', () => {
    expect(metrics).toEqual(expected);
  });

  it('was frozen under the grading config persisted on the run, not a default', () => {
    expect(fixture.state).toEqual({
      passes: 3,
      passMark: 60,
      spreadThreshold: 10,
      judgedThresholds: JUDGED_THRESHOLDS,
    });
    expect(fixture.options).toEqual({ passMark: 60, judgedThresholds: JUDGED_THRESHOLDS });
    expect(metrics.passMark).toBe(60);
    expect(metrics.strictPassMark).toBe(70);
    expect(metrics.consistency?.passes).toBe(3);
    expect(metrics.consistency?.spreadThreshold).toBe(10);
    expect(metrics.judged?.thresholds).toEqual(JUDGED_THRESHOLDS);
  });

  it('pins the headline the report printed for this run', () => {
    expect(fixture.inputs).toHaveLength(20);
    expect(metrics.totalCases).toBe(20);
    expect(metrics.evaluated).toBe(20);
    expect(metrics.uteCount).toBe(0);
    expect(metrics.overall).toEqual({
      n: 20,
      avg: 43.3,
      grade: 'F',
      pass: 8,
      fail: 12,
      passPct: 40,
      failPct: 60,
    });
    expect(metrics.strongestCategory).toBe('surface-compatibility');
    expect(metrics.weakestCategory).toBe('product-comparison');
    expect(metrics.consistency).toMatchObject({
      casesConsolidated: 20,
      flagged: 12,
      byCause: { band_split: 0, score_range: 1, evaluability: 11, concept: 1 },
      timingDisagreementCases: 0,
    });
    expect(metrics.passOnlyUnderCurrentMark).toHaveLength(1);
    expect(metrics.warnings).toEqual([]);
  });

  it('every evaluated case obeys the pure-math spec (B0-813), from first principles', () => {
    expect(metrics.perCase).toHaveLength(20);
    for (const c of metrics.perCase) {
      // Completeness is the expected-concept coverage share, rounded once — never judged.
      expect(c.completeness).toBe(completenessFromCoverage(c.concepts));
      expect(Math.abs(c.completeness - (100 * c.coverage.satisfied) / c.coverage.required)).toBeLessThanOrEqual(0.5);
      expect(c.coverage.required).toBe(c.concepts.expected.required.length);
      // overall = 0.40·A + 0.30·C + 0.20·R + 0.10·Cl, rounded to an integer, and nothing else.
      const weighted =
        WEIGHTS.accuracy * c.accuracy +
        WEIGHTS.completeness * c.completeness +
        WEIGHTS.relevance * c.relevance +
        WEIGHTS.clarity * c.clarity;
      expect(Number.isInteger(c.overall)).toBe(true);
      expect(Math.abs(c.overall - weighted)).toBeLessThanOrEqual(0.5);
      // Result is the pass mark and only the pass mark; the letter follows the same number.
      expect(c.status).toBe(c.overall >= 60 ? 'Pass' : 'Fail');
      expect(c.grade).toBe(gradeFromScore(c.overall));
      expect(c.passesOnlyUnderCurrentMark).toBe(c.status === 'Pass' && c.overall < 70);
      // Reported facts, not gates.
      expect(c.mandatoryMissing).toBe(c.concepts.mandatory.missing.length > 0);
      expect(c.materialIssue).toBe(c.concepts.materialIssue);
    }
    // "No gate" has teeth on this run: cases that miss a must-have concept still pass on arithmetic.
    expect(metrics.perCase.filter((c) => c.status === 'Pass' && c.mandatoryMissing).length).toBeGreaterThan(0);
  });

  it('carries regulated concept phrases through verbatim', () => {
    const phrase = 'pH7Q Dual dilutes at 1:256 (0.5 oz/gal)';
    const c = metrics.perCase.find((e) => e.concepts.expected.required.includes(phrase));
    expect(c?.category).toBe('product-comparison');
    expect(c?.concepts.mandatory.required).toContain(phrase);
    expect(c?.concepts.expected.missing).toContain(phrase);
    expect(metrics.concepts?.missingMandatory.find((m) => m.id === c?.id)?.missing).toContain(phrase);
  });
});
