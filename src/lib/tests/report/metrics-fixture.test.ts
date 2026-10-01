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
import { DEFAULT_SCORING_RULES } from './scoring-config';

/**
 * B0-823 / B0-835 — arithmetic parity, frozen against a real run.
 *
 * What pins the spec in CI is Bex's own arithmetic over a real graded run: the exact
 * `ReportCaseInput[]` the report assembly hands `computeReportMetrics`, and the metrics it
 * produced, both frozen. Any change to a weight, a rounding, one of the four concept rules or the
 * pass mark fails here, without Python.
 *
 * **B0-835 re-froze `expected.json`** under the reference skill's concept rules (Tom Bird,
 * 2026-09-04), reversing B0-813. The inputs are byte-identical; only the derived metrics moved.
 * Headline before → after: avg 43.3 → 41.8 (grade F either way), 8 Pass / 12 Fail → 5 Pass /
 * 15 Fail. 15 of the 20 cases miss a must-have concept and are therefore gated; the ceiling
 * actually lowered 3 of them (the other 12 already scored at or below 59), and the gate took a
 * Pass away from those same 3. The floor fired on nothing and no coverage cap bound, because every
 * pass in this run was graded in the B0-813 window and emitted no judged Completeness — coverage
 * is its Completeness, so there is nothing to cap.
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
 * To re-derive only `expected.json` from the frozen input — a scoring change, with the graded run
 * untouched and no database needed — call `computeReportMetrics(fixture.inputs, fixture.options)`
 * and write the result. That is how B0-835 re-froze it.
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
    // B0-835 — the run predates the persisted rules, so it is frozen under the shipped defaults.
    expect(fixture.options.scoringRules).toBeUndefined();
    expect(metrics.scoringRules).toEqual(DEFAULT_SCORING_RULES);
  });

  it('pins the headline the report printed for this run', () => {
    expect(fixture.inputs).toHaveLength(20);
    expect(metrics.totalCases).toBe(20);
    expect(metrics.evaluated).toBe(20);
    expect(metrics.uteCount).toBe(0);
    expect(metrics.overall).toEqual({
      n: 20,
      avg: 41.8,
      grade: 'F',
      pass: 5,
      fail: 15,
      passPct: 25,
      failPct: 75,
    });
    expect(metrics.strongestCategory).toBe('surface-compatibility');
    expect(metrics.weakestCategory).toBe('product-comparison');
    expect(metrics.consistency).toMatchObject({
      casesConsolidated: 20,
      flagged: 12,
      byCause: { band_split: 0, score_range: 1, evaluability: 11, concept: 1 },
      timingDisagreementCases: 0,
    });
    // Every passing case clears 70 on its own now, so none of them depends on the lower mark.
    expect(metrics.passOnlyUnderCurrentMark).toEqual([]);
    expect(metrics.warnings).toEqual([]);
  });

  it('pins what each concept rule did to this run (B0-835)', () => {
    expect(metrics.gateFloor).toEqual({
      gateEnabled: true,
      floorEnabled: true,
      floorScore: 70,
      floorRespectsMaterialIssue: true,
      // The floor needs full must-have coverage; 15 of 20 cases here miss one.
      flooredIds: [],
      ceilingEnabled: true,
      ceilingScore: 59,
      cappedIds: [
        'c90eae50-5d02-4fb9-b056-4bbf823f1ac6',
        '8187cd8a-e007-42b7-af26-4a3c2ff7e5f6',
        '578ff952-4958-4c4d-8d0f-7e6fe6123bf2',
      ],
      coverageEnabled: true,
      // No pass in this run emitted a judged Completeness, so there was nothing to cap.
      coverageCappedIds: [],
    });

    const rollup = metrics.concepts!;
    expect(rollup.gatedIds).toHaveLength(15);
    // The ceiling only bites where the arithmetic was above 59; the gate only *removes* a Pass
    // where the pre-gate score would have passed. Here those are the same three cases.
    expect(rollup.preventedIds).toEqual(metrics.gateFloor.cappedIds);
    // No case in this run covered its whole expected set, so the automatic Pass never arose.
    expect(rollup.autoPassIds).toEqual([]);
    expect(rollup.autoPassChangedIds).toEqual([]);
    expect(rollup.autoPassBlockedIds).toEqual([]);
    // The Pre-Gate Content Score keeps the near misses distinguishable from the total ones.
    const preGates = metrics.perCase.map((c) => c.preGateScore);
    expect(Math.min(...preGates)).toBe(9);
    expect(Math.max(...preGates)).toBe(83);
  });

  it('every evaluated case obeys the B0-835 spec, from first principles', () => {
    expect(metrics.perCase).toHaveLength(20);
    for (const c of metrics.perCase) {
      // --- Rule 3: Completeness is min(judged, coverage). Every pass in this run emitted no
      // judged value, so Completeness is the coverage share and nothing was "capped".
      expect(c.coverage.required).toBe(c.concepts.expected.required.length);
      expect(c.coveragePct).toBe(completenessFromCoverage(c.concepts));
      expect(Math.abs(c.coveragePct - (100 * c.coverage.satisfied) / c.coverage.required)).toBeLessThanOrEqual(0.5);
      expect(c.completenessJudged).toBeNull();
      expect(c.completeness).toBe(c.coveragePct);
      expect(c.coverageApplied).toBe(false);
      expect(c.completeness).toBeLessThanOrEqual(c.coveragePct);

      // --- the weighted step: 0.40·A + 0.30·C + 0.20·R + 0.10·Cl, rounded once, and nothing else.
      const weighted =
        WEIGHTS.accuracy * c.accuracy +
        WEIGHTS.completeness * c.completeness +
        WEIGHTS.relevance * c.relevance +
        WEIGHTS.clarity * c.clarity;
      expect(Number.isInteger(c.weighted)).toBe(true);
      expect(Math.abs(c.weighted - weighted)).toBeLessThanOrEqual(0.5);

      // --- Rules 1b and 1: the score is the weighted value, or a bound that fired. Never both.
      expect(c.floorApplied && c.ceilingApplied).toBe(false);
      let expectedOverall = c.weighted;
      if (c.floorApplied) expectedOverall = c.floor!;
      if (c.ceilingApplied) expectedOverall = c.ceiling!;
      expect(c.overall).toBe(expectedOverall);
      // The floor only raises and the ceiling only lowers.
      if (c.floorApplied) expect(c.overall).toBeGreaterThan(c.weighted);
      if (c.ceilingApplied) expect(c.overall).toBeLessThan(c.weighted);
      // No floor on a gated case, and none on a material issue while the floor respects one.
      if (c.mandatoryMissing) expect(c.floorApplied).toBe(false);
      if (c.materialIssue) expect(c.floorApplied).toBe(false);
      // The ceiling fires exactly where a must-have was missed *and* the arithmetic was above it.
      expect(c.ceilingApplied).toBe(c.mandatoryMissing && c.weighted > 59);
      // The Pre-Gate Content Score is the arithmetic before the ceiling, and survives it.
      expect(c.preGateScore).toBe(c.weighted);
      expect(c.preGateGrade).toBe(gradeFromScore(c.preGateScore));
      expect(c.preGateScore).toBeGreaterThanOrEqual(c.overall);

      // --- the Result: the rubric, then the automatic Pass, then the gate (which outranks it).
      expect(c.rubricStatus).toBe(c.overall >= 60 ? 'Pass' : 'Fail');
      expect(c.grade).toBe(gradeFromScore(c.overall));
      expect(c.status === c.rubricStatus || c.statusSource !== 'rubric').toBe(true);
      if (c.mandatoryMissing) {
        // Gated: Fail, capped at or below the ceiling, and graded F — number, letter and Result
        // agreeing, which is what makes a "B / Fail" row impossible.
        expect(c.status).toBe('Fail');
        expect(c.statusSource).toBe('minimal_gate');
        expect(c.ratingConstrained).toBe(true);
        expect(c.overall).toBeLessThanOrEqual(59);
        expect(c.grade).toBe('F');
        // A Pass was only taken away where the pre-gate score would have cleared the mark.
        expect(c.gateBlockedAPass).toBe(c.preGateScore >= 60);
      } else {
        expect(c.statusSource).toBe('rubric');
        expect(c.ratingConstrained).toBe(false);
        expect(c.gateBlockedAPass).toBe(false);
        expect(c.status).toBe(c.rubricStatus);
      }
      expect(c.autoPassTriggered).toBe(false);
      expect(c.autoPassBlocked).toBe(false);
      expect(c.passesOnlyUnderCurrentMark).toBe(c.status === 'Pass' && c.overall < 70);
      expect(c.mandatoryMissing).toBe(c.concepts.mandatory.missing.length > 0);
      expect(c.materialIssue).toBe(c.concepts.materialIssue);
    }
    // The gate has teeth on this run: no case that misses a must-have concept passes.
    expect(metrics.perCase.filter((c) => c.status === 'Pass' && c.mandatoryMissing)).toEqual([]);
    expect(metrics.perCase.filter((c) => c.mandatoryMissing)).toHaveLength(15);
  });

  it('carries regulated concept phrases through verbatim', () => {
    const phrase = 'pH7Q Dual dilutes at 1:256 (0.5 oz/gal)';
    const c = metrics.perCase.find((e) => e.concepts.expected.required.includes(phrase));
    expect(c?.category).toBe('product-comparison');
    expect(c?.concepts.mandatory.required).toContain(phrase);
    expect(c?.concepts.expected.missing).toContain(phrase);
    expect(metrics.concepts?.missingMandatory.find((m) => m.id === c?.id)?.missing).toContain(phrase);
    // The same phrase, verbatim, in the sentence the concept rules produced for the case.
    expect(c?.conceptNote).toContain(phrase);
  });
});
