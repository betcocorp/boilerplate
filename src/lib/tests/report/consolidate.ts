import type { CaseConcepts, ConceptKindCoverage } from './case-concepts';
import {
  completenessFromCoverage,
  computeOverall,
  statusFromScore,
  type CaseStatus,
} from './metrics';
import type { CaseScore } from './schemas';
import { DEFAULT_PASS_MARK } from './scoring-config';

/**
 * B0-720 — N independent grading passes in, one reconcilable `CaseScore` out, plus the
 * disagreement between them. A pure port of the reference eval's `consolidate_runs.py`.
 *
 * Four rules the whole module hangs on:
 *
 * 1. **The median is taken per sub-score, never on the weighted total.** Downstream,
 *    `computeReportMetrics` recomputes `overall` from the four sub-scores and `WEIGHTS`, and the
 *    `overall_recomputes_from_sub_scores` invariant asserts that recomputation exactly. Median a
 *    weighted total and the four sub-scores no longer reproduce it — the report would refuse to
 *    generate, and rightly so. So the consolidated score is an ordinary `CaseScore` and every
 *    weighted number downstream is computed once, in the one place it was always computed.
 *    B0-813: Completeness is not a judged sub-score any more — each pass's Completeness is its own
 *    expected-concept coverage, and the consolidated one is the coverage of the majority verdict —
 *    so the per-pass overalls in the variance block are computed from each pass's own coverage.
 * 2. **Ties resolve conservatively.** A 1–1 split on whether a concept was satisfied resolves to
 *    *not* satisfied; a 1–1 split on whether a material factual issue exists resolves to *yes, it
 *    exists*. Both readings are the one that withholds a Pass, which is the direction a regulated
 *    eval has to fail in.
 * 3. **Timings are never consolidated.** TTFT and total response time are objective measurements,
 *    not judgments, so this module has no timing output at all — there is no path by which a
 *    timing could be averaged here. It only *checks* per-pass timings for disagreement and emits a
 *    data-quality warning if it finds one. (In the current pipeline timings are read off the
 *    `test_result_items` row once per case, not per pass, so passes cannot disagree. The check is
 *    the guard that keeps it that way if per-pass timings ever appear.)
 * 4. **Concept phrases are regulated free text.** Every phrase is copied by reference, counted and
 *    re-emitted verbatim — never parsed, rounded, unit-converted, re-cased or truncated.
 */

/** The shipped pass count. **1, not 3** (Tom Bird, 2026-08-27): multi-pass is opt-in. */
export const DEFAULT_GRADING_PASSES = 1;

/**
 * Upper bound on the configured pass count. Every extra pass is another full grading call per
 * case against the same 260s wall-clock budget, so a fat-fingered `30` in the settings table must
 * not silently turn a 200-case run into 6,000 model calls.
 */
export const MAX_GRADING_PASSES = 9;

/** Score range (max − min of the per-pass overalls) at or above which a case is flagged. */
export const DEFAULT_CONSISTENCY_SPREAD_THRESHOLD = 10;

/** `settings` keys backing both knobs. No env vars — see B0-638. */
export const CONSISTENCY_SETTING_KEYS = {
  passes: 'REPORT_GRADING_PASSES',
  spreadThreshold: 'REPORT_CONSISTENCY_SPREAD_THRESHOLD',
} as const;

export type ConsistencyConfig = {
  /** How many independent grading passes each case gets. */
  passes: number;
  spreadThreshold: number;
};

/** Whole passes only, at least one, never more than `MAX_GRADING_PASSES`. */
export function clampGradingPasses(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GRADING_PASSES;
  return Math.min(MAX_GRADING_PASSES, Math.max(1, Math.floor(value)));
}

/**
 * The only async function in this module, and the only place config is read — mirroring
 * `loadSpeedThresholds`. A missing row yields the shipped default (that is `getNumberSetting`'s
 * fallback contract), so with nothing configured this returns 1 pass and today's behaviour.
 */
export async function loadConsistencyConfig(): Promise<ConsistencyConfig> {
  // Imported here rather than at the top of the file: `settings-service` reaches the Supabase
  // service-role client, and this module's constants and types are read by client components.
  const { getNumberSetting } = await import('~/lib/settings/settings-service');

  const [passes, spreadThreshold] = await Promise.all([
    getNumberSetting(CONSISTENCY_SETTING_KEYS.passes, DEFAULT_GRADING_PASSES),
    getNumberSetting(
      CONSISTENCY_SETTING_KEYS.spreadThreshold,
      DEFAULT_CONSISTENCY_SPREAD_THRESHOLD,
    ),
  ]);

  return {
    passes: clampGradingPasses(passes),
    spreadThreshold:
      Number.isFinite(spreadThreshold) && spreadThreshold >= 0
        ? spreadThreshold
        : DEFAULT_CONSISTENCY_SPREAD_THRESHOLD,
  };
}

/**
 * One pass's view of one case. `concepts` and the two timings are optional because in the current
 * pipeline they are derived once per case rather than per pass — supply them and this module will
 * check the passes agree, which is all it ever does with a timing.
 */
export type ConsolidationPass = {
  score: CaseScore;
  concepts?: CaseConcepts;
  ttftSeconds?: number | null;
  totalSeconds?: number | null;
};

/** Why a case is in the human-review queue. Ordered as listed wherever they are rendered. */
export const VARIANCE_CAUSES = [
  'band_split',
  'score_range',
  'evaluability',
  'concept',
] as const;
export type VarianceCause = (typeof VARIANCE_CAUSES)[number];

/** One phrase per cause, defined once so the Markdown and the React report cannot word it apart. */
export const VARIANCE_CAUSE_LABELS: Readonly<Record<VarianceCause, string>> = {
  band_split: 'Passes disagreed on Pass / Fail',
  score_range: 'Score range at or above the spread threshold',
  evaluability: 'Passes disagreed on whether the case could be evaluated',
  concept: 'Passes split on a concept judgment',
};

/** Which judgment the passes split on. */
export type ConceptDisagreementKind =
  | 'mandatory_concept'
  | 'expected_concept'
  | 'all_mandatory'
  | 'all_expected'
  | 'material_issue';

export const CONCEPT_DISAGREEMENT_LABELS: Readonly<Record<ConceptDisagreementKind, string>> = {
  mandatory_concept: 'Mandatory concept',
  expected_concept: 'Expected concept',
  all_mandatory: 'Every mandatory concept satisfied',
  all_expected: 'Every expected concept satisfied',
  material_issue: 'Material factual issue on a regulated value',
};

/**
 * One split judgment. `concept` names the phrase **verbatim** for the two per-phrase kinds and is
 * null for the three whole-case judgments, which are about the case rather than any one phrase.
 */
export type ConceptDisagreement = {
  kind: ConceptDisagreementKind;
  concept: string | null;
  /** Passes that judged it satisfied / present, out of the passes that carried concept data. */
  votesFor: number;
  voters: number;
};

/**
 * The disagreement between a case's passes. Null for a single-pass case — which is what lets the
 * whole consistency block be *absent* from a single-pass report rather than rendered as "0 flags".
 */
export type CaseGradingVariance = {
  passes: number;
  /**
   * Each pass's own weighted overall — from that pass's judged sub-scores and its own coverage-
   * derived Completeness — in pass order. Null for a pass that could not evaluate the case.
   */
  passOveralls: Array<number | null>;
  /** Each pass's Result at the pass mark in force. */
  passBands: Array<CaseStatus | null>;
  /** max − min across the numeric overalls; null with fewer than two of them. */
  range: number | null;
  bandSplit: boolean;
  scoreRangeExceeded: boolean;
  /** The threshold `scoreRangeExceeded` was judged against, carried so a reader can see it. */
  spreadThreshold: number;
  evaluabilitySplit: boolean;
  conceptDisagreements: ConceptDisagreement[];
  causes: VarianceCause[];
  flagged: boolean;
  /**
   * Per-pass timing disagreements. **Data quality, never a grading flag** — they say the numbers
   * were entered inconsistently at the source, not that the grading is shaky.
   */
  timingWarnings: string[];
};

export type ConsolidatedCase = {
  /** An ordinary `CaseScore`, so everything downstream is unchanged. */
  score: CaseScore;
  /** The consolidated concept block, or undefined when no pass carried one. */
  concepts: CaseConcepts | undefined;
  variance: CaseGradingVariance | null;
};

/** Ascending median. Even n averages the two middle values — see `consolidateCasePasses`. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * The median rounded **down**, used for every count-valued concept judgment.
 *
 * This is the "a 1–1 tie resolves to not satisfied" rule, generalized: one satisfied vote and one
 * missed vote medians to 0.5 and floors to 0 — not satisfied. Two of three medians to 1.
 */
function conservativeMedianCount(values: readonly number[]): number {
  return Math.floor(median(values));
}

/**
 * A pass's own weighted overall, computed exactly as `computeReportMetrics` computes it — Completeness
 * from that pass's own expected-concept coverage, missing judged sub-scores coerced to 0 the same
 * way — so a per-pass number in the variance block is the number that pass would have produced on
 * its own. Null when the pass could not evaluate the case, including when it has no expected
 * concepts to compute Completeness from.
 *
 * A pass persisted before B0-813 carries a judged `completeness` and no concept block; its stored
 * number is used so a legacy report's variance block still reads. A pass from the current grader
 * carries a block and `completeness: null`, so coverage is the only source.
 */
function passOverall(score: CaseScore, concepts: CaseConcepts | undefined): number | null {
  if (score.unableToEvaluate) return null;
  const completeness = completenessFromCoverage(concepts) ?? score.completeness ?? null;
  if (completeness == null) return null;
  return computeOverall({
    accuracy: score.accuracy ?? 0,
    completeness,
    relevance: score.relevance ?? 0,
    clarity: score.clarity ?? 0,
  });
}

type SubScoreKey = 'accuracy' | 'completeness' | 'relevance' | 'clarity';

/** Median of one sub-score across the evaluable passes, ignoring passes that did not supply it. */
function medianSubScore(passes: readonly CaseScore[], key: SubScoreKey): number | null {
  const values = passes
    .map((score) => score[key])
    .filter((value): value is number => value != null);
  return values.length === 0 ? null : median(values);
}

function countOccurrences(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** Distinct phrases in first-seen order — concept order is meaningful to a reader. */
function distinctInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

type KindConsolidation = {
  coverage: ConceptKindCoverage;
  disagreements: ConceptDisagreement[];
};

/**
 * Majority verdict per concept phrase, across the passes that carried concept data.
 *
 * `required` is not a judgment — it is what the dataset asked for — so it is taken verbatim from
 * the first pass that has it, in its original order. Only "was it satisfied" is voted on, and a
 * tie loses (`conservativeMedianCount`). Repeated phrases are handled by occurrence count rather
 * than by set membership, because a dataset may legitimately require the same phrase twice.
 */
function consolidateKind(
  voters: readonly CaseConcepts[],
  kind: 'mandatory' | 'expected',
  disagreementKind: ConceptDisagreementKind,
): KindConsolidation {
  const required = voters[0][kind].required;
  const requiredCounts = countOccurrences(required);
  const satisfiedCounts = voters.map((v) => countOccurrences(v[kind].satisfied));
  const disagreements: ConceptDisagreement[] = [];
  const satisfiedByPhrase = new Map<string, number>();

  for (const phrase of distinctInOrder(required)) {
    const requiredCount = requiredCounts.get(phrase) ?? 0;
    const votes = satisfiedCounts.map((counts) => counts.get(phrase) ?? 0);
    const min = Math.min(...votes);
    const max = Math.max(...votes);
    if (min !== max) {
      disagreements.push({
        kind: disagreementKind,
        concept: phrase,
        votesFor: votes.filter((v) => v > 0).length,
        voters: voters.length,
      });
    }
    satisfiedByPhrase.set(
      phrase,
      Math.min(requiredCount, Math.max(0, conservativeMedianCount(votes))),
    );
  }

  // Rebuilt walking `required` in order, so `satisfied ∪ missing === required` holds as a multiset
  // — the partition B0-714's `concept_coverage_partitions_required` invariant asserts.
  const remaining = new Map(satisfiedByPhrase);
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const phrase of required) {
    const left = remaining.get(phrase) ?? 0;
    if (left > 0) {
      remaining.set(phrase, left - 1);
      satisfied.push(phrase);
    } else {
      missing.push(phrase);
    }
  }

  return { coverage: { required: [...required], satisfied, missing }, disagreements };
}

/** True when the passes split on a boolean judgment (some yes, some no). */
function splits(values: readonly boolean[]): boolean {
  return values.some((v) => v) && values.some((v) => !v);
}

type ConceptConsolidation = {
  concepts: CaseConcepts | undefined;
  disagreements: ConceptDisagreement[];
};

function consolidateConcepts(passes: readonly ConsolidationPass[]): ConceptConsolidation {
  const voters = passes
    .map((pass) => pass.concepts)
    .filter((concepts): concepts is CaseConcepts => concepts != null);
  if (voters.length === 0) return { concepts: undefined, disagreements: [] };

  const mandatory = consolidateKind(voters, 'mandatory', 'mandatory_concept');
  const expected = consolidateKind(voters, 'expected', 'expected_concept');

  // A tie means "yes, there is a material issue": the reading that withholds the automatic Pass.
  const materialVotes = voters.filter((v) => v.materialIssue).length;
  const materialIssue = materialVotes > 0 && materialVotes * 2 >= voters.length;
  const materialIssueNote = materialIssue
    ? (voters.find((v) => v.materialIssue)?.materialIssueNote ?? null)
    : null;

  const disagreements = [...mandatory.disagreements, ...expected.disagreements];

  // The three whole-case judgments, each recorded separately from the per-phrase splits above: a
  // reader needs to know the passes disagreed about whether every must-have was delivered, not
  // only about which phrase moved.
  const allMandatory = voters.map((v) => v.mandatory.missing.length === 0);
  if (splits(allMandatory)) {
    disagreements.push({
      kind: 'all_mandatory',
      concept: null,
      votesFor: allMandatory.filter(Boolean).length,
      voters: voters.length,
    });
  }
  const allExpected = voters.map(
    (v) => v.expected.required.length > 0 && v.expected.missing.length === 0,
  );
  if (splits(allExpected)) {
    disagreements.push({
      kind: 'all_expected',
      concept: null,
      votesFor: allExpected.filter(Boolean).length,
      voters: voters.length,
    });
  }
  const materialFlags = voters.map((v) => v.materialIssue);
  if (splits(materialFlags)) {
    disagreements.push({
      kind: 'material_issue',
      concept: null,
      votesFor: materialVotes,
      voters: voters.length,
    });
  }

  return {
    concepts: {
      mandatory: mandatory.coverage,
      expected: expected.coverage,
      materialIssue,
      materialIssueNote,
    },
    disagreements,
  };
}

/**
 * Timings are checked, never merged. A disagreement here is a data-entry bug at the source, so it
 * is reported as a warning and both values are named — smoothing it into an average would erase
 * the only evidence that something upstream is wrong.
 */
function timingDisagreements(passes: readonly ConsolidationPass[]): string[] {
  const warnings: string[] = [];
  for (const [key, label] of [
    ['ttftSeconds', 'time to first token'],
    ['totalSeconds', 'total response time'],
  ] as const) {
    const values = passes
      .map((pass) => pass[key])
      .filter((value): value is number => value != null);
    const distinct = [...new Set(values)];
    if (distinct.length > 1) {
      warnings.push(
        `grading passes recorded different ${label} values (${distinct.join(', ')} s) — a timing is a measurement, not a judgment, so it is reported as recorded and never averaged`,
      );
    }
  }
  return warnings;
}

export type ConsolidateOptions = {
  /** Defaults to `DEFAULT_CONSISTENCY_SPREAD_THRESHOLD`. */
  spreadThreshold?: number;
  /** B0-812 — the pass mark the per-pass bands are judged at. Defaults to `DEFAULT_PASS_MARK`. */
  passMark?: number | null;
};

/**
 * Consolidates one case's passes.
 *
 * **Even pass counts** average the two middle sub-scores (e.g. 60 and 70 → 65). That is safe
 * precisely because the median is per sub-score: the weighted total is recomputed downstream from
 * whatever the four sub-scores are, integer or not, so an averaged middle pair still reconciles
 * with `grade_isolated_from_speed`. It is deliberately not rounded — rounding a judgment to hide
 * a `.5` would be inventing precision the passes did not produce.
 *
 * **Evaluability** is a strict majority: a case is Unable to Evaluate only when more than half the
 * passes said so. A 1–1 tie keeps the case *evaluable* and raises the evaluability flag instead,
 * because at least one pass did judge it and dropping a case out of every average, rate and grade
 * on a tie distorts the run far more than grading it with the disagreement named.
 *
 * **The narrative** (explanation / missed / incorrect / improvement) is taken verbatim from one
 * representative pass — the one whose own overall is nearest the consolidated overall, earliest
 * pass winning a tie. It is never stitched together from several passes: a grading rationale is
 * only true of the scores it was written about.
 *
 * A single pass returns that pass unchanged, with `variance: null`. This is what makes
 * `passes = 1` byte-identical to the report before any of this existed.
 *
 * @throws when handed no passes at all — a programmer error, never a data state.
 */
export function consolidateCasePasses(
  passes: readonly ConsolidationPass[],
  options?: ConsolidateOptions,
): ConsolidatedCase {
  if (passes.length === 0) {
    throw new Error('consolidateCasePasses requires at least one grading pass.');
  }

  if (passes.length === 1) {
    // Identity, and deliberately the *same objects*: one pass has nothing to consolidate, and a
    // rebuilt copy would be one refactor away from drifting from what the grader actually said.
    return { score: passes[0].score, concepts: passes[0].concepts, variance: null };
  }

  const spreadThreshold = options?.spreadThreshold ?? DEFAULT_CONSISTENCY_SPREAD_THRESHOLD;
  const passMark = options?.passMark ?? DEFAULT_PASS_MARK;
  const scores = passes.map((pass) => pass.score);
  const conceptResult = consolidateConcepts(passes);

  const uteVotes = scores.filter((score) => score.unableToEvaluate).length;
  const unableToEvaluate = uteVotes * 2 > passes.length;
  const evaluable = scores.filter((score) => !score.unableToEvaluate);

  let score: CaseScore;
  if (unableToEvaluate || evaluable.length === 0) {
    const firstUte = scores.find((s) => s.unableToEvaluate);
    score = {
      unableToEvaluate: true,
      uteReason: firstUte?.uteReason ?? null,
      accuracy: null,
      completeness: null,
      relevance: null,
      clarity: null,
      explanation: '',
      missed: '',
      incorrect: '',
      improvement: '',
    };
  } else {
    const subScores = {
      accuracy: medianSubScore(evaluable, 'accuracy'),
      completeness: medianSubScore(evaluable, 'completeness'),
      relevance: medianSubScore(evaluable, 'relevance'),
      clarity: medianSubScore(evaluable, 'clarity'),
    };
    const consolidatedOverall = passOverall(
      { ...evaluable[0], ...subScores },
      conceptResult.concepts,
    );
    let representative = evaluable[0];
    let bestDistance = Infinity;
    for (const candidate of evaluable) {
      const candidateConcepts = passes.find((pass) => pass.score === candidate)?.concepts;
      const distance = Math.abs(
        (passOverall(candidate, candidateConcepts) ?? 0) - (consolidatedOverall ?? 0),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        representative = candidate;
      }
    }
    score = {
      unableToEvaluate: false,
      uteReason: null,
      ...subScores,
      explanation: representative.explanation,
      missed: representative.missed,
      incorrect: representative.incorrect,
      improvement: representative.improvement,
    };
  }

  const passOveralls = passes.map((pass) => passOverall(pass.score, pass.concepts));
  const passBands = passOveralls.map((overall) =>
    overall == null ? null : statusFromScore(overall, passMark),
  );
  const numeric = passOveralls.filter((value): value is number => value != null);
  const range = numeric.length > 1 ? Math.max(...numeric) - Math.min(...numeric) : null;
  const bands = passBands.filter((band): band is CaseStatus => band != null);
  const bandSplit = new Set(bands).size > 1;
  const scoreRangeExceeded = range != null && range >= spreadThreshold;
  const evaluabilitySplit = uteVotes > 0 && uteVotes < passes.length;

  const causes = VARIANCE_CAUSES.filter((cause) => {
    if (cause === 'band_split') return bandSplit;
    if (cause === 'score_range') return scoreRangeExceeded;
    if (cause === 'evaluability') return evaluabilitySplit;
    return conceptResult.disagreements.length > 0;
  });

  return {
    score,
    concepts: conceptResult.concepts,
    variance: {
      passes: passes.length,
      passOveralls,
      passBands,
      range,
      bandSplit,
      scoreRangeExceeded,
      spreadThreshold,
      evaluabilitySplit,
      conceptDisagreements: conceptResult.disagreements,
      causes,
      flagged: causes.length > 0,
      timingWarnings: timingDisagreements(passes),
    },
  };
}
