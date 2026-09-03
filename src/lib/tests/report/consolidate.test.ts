import { describe, expect, it } from 'vitest';

import type { CaseConcepts, ConceptKindCoverage } from './case-concepts';
import {
  clampGradingPasses,
  consolidateCasePasses,
  DEFAULT_CONSISTENCY_SPREAD_THRESHOLD,
  DEFAULT_GRADING_PASSES,
  MAX_GRADING_PASSES,
  type ConsolidationPass,
} from './consolidate';
import { computeReportMetrics, type ReportCaseInput } from './metrics';
import type { CaseScore } from './schemas';

/**
 * B0-720 / B0-721 — consolidation of N independent grading passes, and the consistency rollup
 * built from it.
 *
 * The fixtures carry real regulated phrases (dilution ratios, contact times, ppm, EPA numbers) and
 * are asserted back byte-for-byte: any parsing, rounding, unit conversion or re-punctuation of a
 * concept phrase shows up here as a failure.
 */

const CONCEPT = {
  dilution: 'Dilute 1:64 (2 oz/gal)',
  contactTime: '10 minutes contact time at 600 ppm active quat',
  epa: 'EPA Reg. No. 6836-140-4170',
} as const;

/**
 * Equal sub-scores make the weighted roll-up equal `overall` exactly (0.4+0.3+0.2+0.1 = 1). The
 * `completeness` here stands in for a pass persisted before B0-813 — the current grader writes
 * null and coverage is the only source; `passOverall` falls back to the stored value only when a
 * pass carries no concept block, which keeps a legacy report's variance readable.
 */
function score(overall: number, partial: Partial<CaseScore> = {}): CaseScore {
  return {
    unableToEvaluate: false,
    uteReason: null,
    accuracy: overall,
    completeness: overall,
    relevance: overall,
    clarity: overall,
    explanation: `explanation @${overall}`,
    missed: `missed @${overall}`,
    incorrect: `incorrect @${overall}`,
    improvement: `improvement @${overall}`,
    ...partial,
  };
}

function uteScore(reason: string): CaseScore {
  return {
    unableToEvaluate: true,
    uteReason: reason,
    accuracy: null,
    completeness: null,
    relevance: null,
    clarity: null,
    explanation: '',
    missed: '',
    incorrect: '',
    improvement: '',
  };
}

function coverage(required: string[], missing: string[]): ConceptKindCoverage {
  return { required, satisfied: required.filter((c) => !missing.includes(c)), missing };
}

function concepts(params: {
  mandatoryRequired: string[];
  mandatoryMissing?: string[];
  bonusRequired?: string[];
  bonusMissing?: string[];
  materialIssue?: boolean;
  materialIssueNote?: string | null;
}): CaseConcepts {
  const mandatoryMissing = params.mandatoryMissing ?? [];
  const bonusRequired = params.bonusRequired ?? [];
  const bonusMissing = params.bonusMissing ?? [];
  return {
    mandatory: coverage(params.mandatoryRequired, mandatoryMissing),
    expected: coverage(
      [...params.mandatoryRequired, ...bonusRequired],
      [...mandatoryMissing, ...bonusMissing],
    ),
    materialIssue: params.materialIssue ?? false,
    materialIssueNote: params.materialIssueNote ?? null,
  };
}

function passes(...scores: CaseScore[]): ConsolidationPass[] {
  return scores.map((s) => ({ score: s }));
}

describe('consolidateCasePasses — a single pass (B0-719 default)', () => {
  it('returns the pass untouched and no variance at all', () => {
    const only = score(73);
    const result = consolidateCasePasses([{ score: only }]);

    // The same object, not a copy: `passes = 1` must reproduce today's report exactly.
    expect(result.score).toBe(only);
    expect(result.variance).toBeNull();
  });

  it('carries a single pass’s concepts through by reference', () => {
    const block = concepts({ mandatoryRequired: [CONCEPT.dilution] });
    const result = consolidateCasePasses([{ score: score(90), concepts: block }]);
    expect(result.concepts).toBe(block);
  });
});

describe('consolidateCasePasses — the median (B0-720)', () => {
  it('medians each sub-score, so the weighted total still recomputes downstream', () => {
    const result = consolidateCasePasses(
      passes(
        score(60, { accuracy: 50, completeness: 60, relevance: 70, clarity: 80 }),
        score(60, { accuracy: 90, completeness: 40, relevance: 70, clarity: 60 }),
        score(60, { accuracy: 70, completeness: 80, relevance: 10, clarity: 70 }),
      ),
    );

    expect(result.score.accuracy).toBe(70);
    expect(result.score.completeness).toBe(60);
    expect(result.score.relevance).toBe(70);
    expect(result.score.clarity).toBe(70);

    // The consolidated case survives `computeReportMetrics`, whose `overall_recomputes_from_sub_scores`
    // invariant recomputes `overall` from the four sub-scores alone — with Completeness taken from
    // the coverage, not the stored median. Consolidating on the weighted total would make this throw.
    const metrics = computeReportMetrics([
      {
        testItemId: 'median',
        question: 'q',
        priorityRaw: 1,
        category: 'Dilution',
        score: result.score,
        latencySeconds: null,
        ttftSeconds: null,
        concepts: concepts({ mandatoryRequired: [CONCEPT.dilution] }),
        variance: result.variance,
      },
    ]);
    expect(metrics.perCase[0]!.completeness).toBe(100);
    expect(metrics.perCase[0]!.overall).toBe(Math.round(0.4 * 70 + 0.3 * 100 + 0.2 * 70 + 0.1 * 70));
  });

  it('computes each pass’s own overall from that pass’s coverage, not from a judged Completeness', () => {
    // Same judged sub-scores every pass; only the concept verdicts differ.
    const full = concepts({ mandatoryRequired: [CONCEPT.dilution], bonusRequired: [CONCEPT.epa] });
    const half = concepts({
      mandatoryRequired: [CONCEPT.dilution],
      bonusRequired: [CONCEPT.epa],
      bonusMissing: [CONCEPT.epa],
    });
    const result = consolidateCasePasses([
      { score: score(80, { completeness: null }), concepts: full },
      { score: score(80, { completeness: null }), concepts: half },
      { score: score(80, { completeness: null }), concepts: full },
    ]);

    // full: 0.4·80 + 0.3·100 + 0.2·80 + 0.1·80 = 86; half: 0.4·80 + 0.3·50 + 0.2·80 + 0.1·80 = 71.
    expect(result.variance!.passOveralls).toEqual([86, 71, 86]);
    expect(result.variance!.range).toBe(15);
    expect(result.variance!.causes).toContain('score_range');
    expect(result.variance!.causes).toContain('concept');
  });

  it('leaves the median untouched when one pass is a wild outlier', () => {
    const result = consolidateCasePasses(passes(score(80), score(82), score(12)));

    expect(result.score.accuracy).toBe(80);
    expect(result.score.completeness).toBe(80);
    // The outlier is not silently absorbed: it shows up as a flag instead.
    expect(result.variance!.range).toBe(70);
    expect(result.variance!.flagged).toBe(true);
    expect(result.variance!.causes).toContain('score_range');
  });

  it('averages the two middle sub-scores on an even pass count', () => {
    const result = consolidateCasePasses(passes(score(60), score(70), score(72), score(90)));
    // (70 + 72) / 2 — deliberately not rounded, because the weighted total is recomputed from it.
    expect(result.score.accuracy).toBe(71);

    const result2 = consolidateCasePasses(passes(score(60), score(65)));
    expect(result2.score.accuracy).toBe(62.5);
  });

  it('takes the narrative verbatim from the pass nearest the consolidated score', () => {
    const result = consolidateCasePasses(passes(score(40), score(70), score(72)));
    expect(result.score.explanation).toBe('explanation @70');
    expect(result.score.improvement).toBe('improvement @70');
  });
});

describe('consolidateCasePasses — flags (B0-720)', () => {
  it('raises no flag and no variance noise when every pass agrees', () => {
    const block = concepts({
      mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
      mandatoryMissing: [CONCEPT.contactTime],
    });
    const result = consolidateCasePasses([
      { score: score(72), concepts: block, ttftSeconds: 1.2, totalSeconds: 9.4 },
      { score: score(72), concepts: block, ttftSeconds: 1.2, totalSeconds: 9.4 },
      { score: score(72), concepts: block, ttftSeconds: 1.2, totalSeconds: 9.4 },
    ]);

    expect(result.variance!.flagged).toBe(false);
    expect(result.variance!.causes).toEqual([]);
    expect(result.variance!.range).toBe(0);
    expect(result.variance!.bandSplit).toBe(false);
    expect(result.variance!.conceptDisagreements).toEqual([]);
    expect(result.variance!.timingWarnings).toEqual([]);
    // The concept verdict is unchanged, phrases verbatim.
    expect(result.concepts!.mandatory.missing).toEqual([CONCEPT.contactTime]);
  });

  it('flags a 58 / 62 / 60 spread that straddles the pass mark', () => {
    const result = consolidateCasePasses(passes(score(58), score(62), score(60)));

    expect(result.variance!.passOveralls).toEqual([58, 62, 60]);
    expect(result.variance!.passBands).toEqual(['Fail', 'Pass', 'Pass']);
    expect(result.variance!.bandSplit).toBe(true);
    expect(result.variance!.range).toBe(4);
    // 4 points is well under the spread threshold — the band split alone is what flags it.
    expect(result.variance!.scoreRangeExceeded).toBe(false);
    expect(result.variance!.causes).toEqual(['band_split']);
    expect(result.variance!.flagged).toBe(true);
  });

  it('flags a score range at exactly the spread threshold', () => {
    const at = consolidateCasePasses(passes(score(85), score(95)), { spreadThreshold: 10 });
    expect(at.variance!.scoreRangeExceeded).toBe(true);

    const under = consolidateCasePasses(passes(score(86), score(95)), { spreadThreshold: 10 });
    expect(under.variance!.scoreRangeExceeded).toBe(false);
  });

  it('uses the default spread threshold when none is supplied', () => {
    const result = consolidateCasePasses(passes(score(85), score(95)));
    expect(result.variance!.spreadThreshold).toBe(DEFAULT_CONSISTENCY_SPREAD_THRESHOLD);
    expect(result.variance!.scoreRangeExceeded).toBe(true);
  });

  it('judges the per-pass bands at the pass mark it is given (B0-812)', () => {
    const at60 = consolidateCasePasses(passes(score(65), score(75)));
    expect(at60.variance!.passBands).toEqual(['Pass', 'Pass']);
    expect(at60.variance!.bandSplit).toBe(false);

    const at70 = consolidateCasePasses(passes(score(65), score(75)), { passMark: 70 });
    expect(at70.variance!.passBands).toEqual(['Fail', 'Pass']);
    expect(at70.variance!.bandSplit).toBe(true);
  });
});

describe('consolidateCasePasses — evaluability (B0-720)', () => {
  it('calls a case Unable to Evaluate on a strict majority', () => {
    const result = consolidateCasePasses(
      passes(uteScore('empty response'), uteScore('empty response'), score(70)),
    );

    expect(result.score.unableToEvaluate).toBe(true);
    expect(result.score.uteReason).toBe('empty response');
    expect(result.score.accuracy).toBeNull();
    expect(result.variance!.evaluabilitySplit).toBe(true);
    expect(result.variance!.causes).toContain('evaluability');
  });

  it('keeps a 1–1 tie evaluable, and flags the disagreement instead of dropping the case', () => {
    const result = consolidateCasePasses(passes(uteScore('too ambiguous'), score(70)));

    expect(result.score.unableToEvaluate).toBe(false);
    expect(result.score.accuracy).toBe(70);
    expect(result.variance!.passOveralls).toEqual([null, 70]);
    expect(result.variance!.evaluabilitySplit).toBe(true);
    expect(result.variance!.flagged).toBe(true);
  });
});

describe('consolidateCasePasses — concept majority (B0-720)', () => {
  it('resolves a 1–1 tie on a concept to NOT satisfied', () => {
    const satisfied = concepts({ mandatoryRequired: [CONCEPT.dilution] });
    const missed = concepts({
      mandatoryRequired: [CONCEPT.dilution],
      mandatoryMissing: [CONCEPT.dilution],
    });
    const result = consolidateCasePasses([
      { score: score(80), concepts: satisfied },
      { score: score(80), concepts: missed },
    ]);

    expect(result.concepts!.mandatory.satisfied).toEqual([]);
    expect(result.concepts!.mandatory.missing).toEqual([CONCEPT.dilution]);
    expect(result.variance!.causes).toContain('concept');
    expect(result.variance!.conceptDisagreements).toContainEqual({
      kind: 'mandatory_concept',
      concept: CONCEPT.dilution,
      votesFor: 1,
      voters: 2,
    });
  });

  it('takes the majority verdict when two of three passes agree', () => {
    const satisfied = concepts({ mandatoryRequired: [CONCEPT.contactTime] });
    const missed = concepts({
      mandatoryRequired: [CONCEPT.contactTime],
      mandatoryMissing: [CONCEPT.contactTime],
    });
    const result = consolidateCasePasses([
      { score: score(80), concepts: satisfied },
      { score: score(80), concepts: satisfied },
      { score: score(80), concepts: missed },
    ]);

    expect(result.concepts!.mandatory.satisfied).toEqual([CONCEPT.contactTime]);
    expect(result.concepts!.mandatory.missing).toEqual([]);
    expect(result.variance!.conceptDisagreements[0]!.votesFor).toBe(2);
  });

  it('resolves a 1–1 tie on a material factual issue to "there is one"', () => {
    const clean = concepts({ mandatoryRequired: [CONCEPT.epa] });
    const dirty = concepts({
      mandatoryRequired: [CONCEPT.epa],
      materialIssue: true,
      materialIssueNote: `Exact-match check failed on a regulated value: "${CONCEPT.epa}".`,
    });
    const result = consolidateCasePasses([
      { score: score(88), concepts: clean },
      { score: score(88), concepts: dirty },
    ]);

    expect(result.concepts!.materialIssue).toBe(true);
    expect(result.concepts!.materialIssueNote).toBe(
      `Exact-match check failed on a regulated value: "${CONCEPT.epa}".`,
    );
    expect(result.variance!.conceptDisagreements.map((d) => d.kind)).toContain('material_issue');
  });

  it('records the whole-case concept judgments the passes split on', () => {
    const full = concepts({ mandatoryRequired: [CONCEPT.dilution] });
    const partial = concepts({
      mandatoryRequired: [CONCEPT.dilution],
      mandatoryMissing: [CONCEPT.dilution],
    });
    const result = consolidateCasePasses([
      { score: score(70), concepts: full },
      { score: score(70), concepts: partial },
    ]);

    const kinds = result.variance!.conceptDisagreements.map((d) => d.kind);
    expect(kinds).toContain('all_mandatory');
    expect(kinds).toContain('all_expected');
    // No automatic-Pass rule exists any more (B0-813), so there is no such judgment to split on.
    expect(kinds).not.toContain('auto_pass_eligible');
  });

  it('keeps a repeated concept phrase as a multiset when the passes disagree', () => {
    const twice = [CONCEPT.dilution, CONCEPT.dilution];
    const bothSatisfied: CaseConcepts = {
      mandatory: { required: twice, satisfied: twice, missing: [] },
      expected: { required: twice, satisfied: twice, missing: [] },
      materialIssue: false,
      materialIssueNote: null,
    };
    const oneSatisfied: CaseConcepts = {
      mandatory: {
        required: twice,
        satisfied: [CONCEPT.dilution],
        missing: [CONCEPT.dilution],
      },
      expected: {
        required: twice,
        satisfied: [CONCEPT.dilution],
        missing: [CONCEPT.dilution],
      },
      materialIssue: false,
      materialIssueNote: null,
    };
    const result = consolidateCasePasses([
      { score: score(80), concepts: bothSatisfied },
      { score: score(80), concepts: oneSatisfied },
    ]);

    // A 2-vs-1 tie on the occurrence count floors to 1 — the conservative reading again.
    expect(result.concepts!.mandatory.satisfied).toEqual([CONCEPT.dilution]);
    expect(result.concepts!.mandatory.missing).toEqual([CONCEPT.dilution]);
    expect([
      ...result.concepts!.mandatory.satisfied,
      ...result.concepts!.mandatory.missing,
    ]).toHaveLength(result.concepts!.mandatory.required.length);
  });
});

describe('consolidateCasePasses — timings (B0-720)', () => {
  it('warns on a timing disagreement and never averages it', () => {
    const result = consolidateCasePasses([
      { score: score(80), ttftSeconds: 1.2, totalSeconds: 9.4 },
      { score: score(80), ttftSeconds: 1.9, totalSeconds: 9.4 },
    ]);

    expect(result.variance!.timingWarnings).toHaveLength(1);
    expect(result.variance!.timingWarnings[0]).toContain('1.2, 1.9');
    // A timing disagreement is data quality, not a grading flag.
    expect(result.variance!.causes).toEqual([]);
    expect(result.variance!.flagged).toBe(false);
    // And there is no consolidated timing to have been averaged — the shape carries none.
    expect(Object.keys(result)).toEqual(['score', 'concepts', 'variance']);
  });
});

describe('clampGradingPasses (B0-719)', () => {
  it('ships at one pass by default', () => {
    expect(DEFAULT_GRADING_PASSES).toBe(1);
  });

  it('clamps to whole passes within bounds', () => {
    expect(clampGradingPasses(3)).toBe(3);
    expect(clampGradingPasses(0)).toBe(1);
    expect(clampGradingPasses(-4)).toBe(1);
    expect(clampGradingPasses(2.7)).toBe(2);
    expect(clampGradingPasses(500)).toBe(MAX_GRADING_PASSES);
    expect(clampGradingPasses(Number.NaN)).toBe(DEFAULT_GRADING_PASSES);
  });
});

/** The rollup that B0-721 renders. Built here from real consolidations, never hand-written. */
function metricsFor(cases: Array<{ id: string; passes: ConsolidationPass[] }>) {
  const inputs: ReportCaseInput[] = cases.map(({ id, passes: casePasses }) => {
    const consolidated = consolidateCasePasses(casePasses);
    return {
      testItemId: id,
      question: `Question ${id}`,
      priorityRaw: 1,
      category: 'Dilution',
      score: consolidated.score,
      latencySeconds: null,
      ttftSeconds: null,
      concepts: consolidated.concepts,
      variance: consolidated.variance,
    };
  });
  return computeReportMetrics(inputs);
}

describe('computeReportMetrics — grading-consistency rollup (B0-721)', () => {
  it('reports no consistency block at all for a single-pass run', () => {
    const metrics = metricsFor([{ id: 'a', passes: passes(score(80)) }]);
    expect(metrics.consistency).toBeNull();
  });

  it('counts flags by cause, calling concept disagreements out separately', () => {
    const satisfied = concepts({ mandatoryRequired: [CONCEPT.dilution] });
    const missed = concepts({
      mandatoryRequired: [CONCEPT.dilution],
      mandatoryMissing: [CONCEPT.dilution],
    });

    const metrics = metricsFor([
      { id: 'agree', passes: passes(score(72), score(72), score(72)) },
      { id: 'band', passes: passes(score(58), score(62), score(60)) },
      { id: 'spread', passes: passes(score(80), score(82), score(12)) },
      {
        id: 'concept',
        passes: [
          { score: score(80), concepts: satisfied },
          { score: score(80), concepts: satisfied },
          { score: score(80), concepts: missed },
        ],
      },
      { id: 'ute', passes: passes(uteScore('empty response'), score(70)) },
    ]);

    const con = metrics.consistency!;
    expect(con.passes).toBe(3);
    expect(con.casesConsolidated).toBe(5);
    expect(con.flagged).toBe(4);
    // B0-813 — a concept split moves the number too: the pass that missed the only expected
    // concept has Completeness 0 (overall 56, Fail) while the others have 100 (overall 86, Pass),
    // so the 'concept' case is also a band split and a 30-point score range.
    expect(con.byCause.band_split).toBe(3);
    expect(con.byCause.score_range).toBe(2);
    expect(con.byCause.evaluability).toBe(1);
    expect(con.byCause.concept).toBe(1);
    expect(con.conceptDisagreementCases).toBe(1);
    // One split phrase records four judgments: the phrase under both kinds (mandatory ⊆ expected),
    // plus all-mandatory and all-expected.
    expect(con.conceptDisagreements).toBe(4);
    expect(con.maxRange).toBe(70);
    expect(con.queue.map((entry) => entry.id)).not.toContain('agree');
    expect(con.queue).toHaveLength(4);
  });

  it('keeps a flagged Unable-to-Evaluate case in the queue, where the ledger cannot show it', () => {
    const metrics = metricsFor([
      { id: 'ute', passes: passes(uteScore('empty'), uteScore('empty'), score(70)) },
    ]);

    expect(metrics.perCase).toHaveLength(0);
    expect(metrics.uteCount).toBe(1);
    const entry = metrics.consistency!.queue[0]!;
    expect(entry.id).toBe('ute');
    expect(entry.unableToEvaluate).toBe(true);
    expect(entry.passOveralls).toEqual([null, null, 70]);
  });

  it('routes a timing disagreement to the data-quality warnings, not to a flag', () => {
    const metrics = metricsFor([
      {
        id: 'timings',
        passes: [
          { score: score(80), ttftSeconds: 1.2 },
          { score: score(80), ttftSeconds: 1.9 },
        ],
      },
    ]);

    expect(metrics.consistency!.flagged).toBe(0);
    expect(metrics.consistency!.timingDisagreementCases).toBe(1);
    expect(metrics.warnings.some((w) => w.startsWith('timings: grading passes recorded'))).toBe(
      true,
    );
  });
});
