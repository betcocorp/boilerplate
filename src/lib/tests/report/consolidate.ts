import { normConcept, type CaseConcepts, type ConceptKindCoverage } from './case-concepts';
import {
  completenessFromCoverage,
  computeOverall,
  roundScore,
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
 * 2. **Ties resolve as the reference does (B0-817).** A concept is satisfied only on a strict
 *    majority of the passes that judged it, so a 1–1 split resolves to *not* satisfied; a material
 *    factual issue likewise needs a strict majority, so a 1–1 split resolves to *no* issue. A case is
 *    Unable to Evaluate only when *every* pass said so — one pass that could judge it is enough to
 *    grade it, with the disagreement flagged.
 * 3. **Timings are never consolidated.** TTFT and total response time are objective measurements,
 *    not judgments, so this module has no timing output at all — there is no path by which a
 *    timing could be averaged here. It only *checks* per-pass timings for disagreement and emits a
 *    data-quality warning if it finds one. (In the current pipeline timings are read off the
 *    `test_result_items` row once per case, not per pass, so passes cannot disagree. The check is
 *    the guard that keeps it that way if per-pass timings ever appear.)
 * 4. **Concept phrases are regulated free text.** Every phrase is copied by reference, counted and
 *    re-emitted verbatim — never parsed, rounded, unit-converted, re-cased or truncated. Two spellings
 *    of one phrase are recognised as one phrase for *voting* only (`normConcept`); the first-seen
 *    spelling is the one re-emitted.
 * 5. **The judged metrics are judgments** (methodology §7c) and consolidate by median exactly like
 *    the sub-scores; timings are measurements and are never consolidated (rule 3).
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

/** Median of a judged metric (§7c) across the evaluable passes that supplied it. */
function medianJudged(
  passes: readonly CaseScore[],
  key: 'similarity' | 'evalConfidence',
): number | null {
  const values = passes
    .map((score) => score[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length === 0 ? null : median(values);
}

/** Occurrences per `normConcept` key — repeated phrases are a multiset, not a set. */
function countByKey(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = normConcept(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

type KindConsolidation = {
  coverage: ConceptKindCoverage;
  disagreements: ConceptDisagreement[];
};

/**
 * Majority verdict per concept phrase, across the passes that carried concept data.
 *
 * `required` is not a judgment — it is what the dataset asked for — so it is the **union** of every
 * pass's required list in first-seen order (B0-817, as `consolidate_runs.py` does): a pass that
 * omits a phrase is silent about it, not a vote against its existence. Only "was it satisfied" is
 * voted on, by `normConcept` identity, and a tie loses (`conservativeMedianCount`). Repeated
 * phrases are handled by occurrence count rather than by set membership, because a dataset may
 * legitimately require the same phrase twice. The first-seen spelling of a phrase is the one
 * re-emitted.
 */
function consolidateKind(
  voters: readonly CaseConcepts[],
  kind: 'mandatory' | 'expected',
  disagreementKind: ConceptDisagreementKind,
): KindConsolidation {
  // Union of the required lists: for each key, the maximum occurrence count any pass required, in
  // first-seen order, spelled as first seen.
  const spelling = new Map<string, string>();
  const requiredCounts = new Map<string, number>();
  const order: string[] = [];
  for (const voter of voters) {
    const counts = countByKey(voter[kind].required);
    for (const phrase of voter[kind].required) {
      const key = normConcept(phrase);
      if (!spelling.has(key)) {
        spelling.set(key, phrase);
        order.push(key);
      }
      requiredCounts.set(key, Math.max(requiredCounts.get(key) ?? 0, counts.get(key) ?? 0));
    }
  }

  const satisfiedCounts = voters.map((v) => countByKey(v[kind].satisfied));
  const disagreements: ConceptDisagreement[] = [];
  const satisfiedByKey = new Map<string, number>();

  for (const key of order) {
    const requiredCount = requiredCounts.get(key) ?? 0;
    const votes = satisfiedCounts.map((counts) => counts.get(key) ?? 0);
    const min = Math.min(...votes);
    const max = Math.max(...votes);
    if (min !== max) {
      disagreements.push({
        kind: disagreementKind,
        concept: spelling.get(key)!,
        votesFor: votes.filter((v) => v > 0).length,
        voters: voters.length,
      });
    }
    satisfiedByKey.set(key, Math.min(requiredCount, Math.max(0, conservativeMedianCount(votes))));
  }

  // Rebuilt walking the union in order, so `satisfied ∪ missing === required` holds as a multiset
  // — the partition the `concept_coverage_partitions_required` invariant asserts.
  const required: string[] = [];
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const key of order) {
    const phrase = spelling.get(key)!;
    let left = satisfiedByKey.get(key) ?? 0;
    for (let i = 0; i < (requiredCounts.get(key) ?? 0); i += 1) {
      required.push(phrase);
      if (left > 0) {
        left -= 1;
        satisfied.push(phrase);
      } else {
        missing.push(phrase);
      }
    }
  }

  return { coverage: { required, satisfied, missing }, disagreements };
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

  // Strict majority, as the reference does: a 1–1 tie is *no* material issue (B0-817).
  const materialVotes = voters.filter((v) => v.materialIssue).length;
  const materialIssue = materialVotes * 2 > voters.length;
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
 * whatever the sub-scores are, integer or not, so an averaged middle pair still reconciles with
 * `overall_recomputes_from_sub_scores`. It is deliberately not rounded — rounding a judgment to
 * hide a `.5` would be inventing precision the passes did not produce. (Bex is the spec here; the
 * reference Python rounds its even medians and is to follow, B0-814.)
 *
 * **Evaluability** (B0-817): a case is Unable to Evaluate only when *every* pass said so. Any pass
 * that could judge it is enough to grade it — with the evaluability flag raised — because dropping
 * a case out of every average, rate and grade on the word of a minority distorts the run far more
 * than grading it with the disagreement named.
 *
 * **The narrative** (explanation / missed / incorrect / improvement, and the two judged-metric
 * notes) is taken verbatim from the first evaluable pass, as the reference keeps its first run's
 * prose (B0-817). It is never stitched together from several passes: a grading rationale is only
 * true of the scores it was written about.
 *
 * **The judged metrics** — similarity (0–1) and evaluator confidence (0–100) — are judgments and
 * consolidate by median like the sub-scores, rounded to two decimals and to an integer respectively
 * as the reference does (methodology §7c).
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
  const evaluable = scores.filter((score) => !score.unableToEvaluate);
  const unableToEvaluate = evaluable.length === 0;

  let score: CaseScore;
  if (unableToEvaluate) {
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
      concepts: null,
      similarity: null,
      similarityNote: null,
      evalConfidence: null,
      confidenceNote: null,
    };
  } else {
    const narrative = evaluable[0];
    const similarity = medianJudged(evaluable, 'similarity');
    const evalConfidence = medianJudged(evaluable, 'evalConfidence');
    score = {
      unableToEvaluate: false,
      uteReason: null,
      accuracy: medianSubScore(evaluable, 'accuracy'),
      completeness: medianSubScore(evaluable, 'completeness'),
      relevance: medianSubScore(evaluable, 'relevance'),
      clarity: medianSubScore(evaluable, 'clarity'),
      explanation: narrative.explanation,
      missed: narrative.missed,
      incorrect: narrative.incorrect,
      improvement: narrative.improvement,
      concepts: conceptResult.concepts ?? null,
      similarity: similarity == null ? null : Math.round(similarity * 100) / 100,
      similarityNote: narrative.similarityNote ?? null,
      evalConfidence: evalConfidence == null ? null : roundScore(evalConfidence),
      confidenceNote: narrative.confidenceNote ?? null,
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
