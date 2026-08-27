import type { CaseConcepts } from './case-concepts';
import { assertReportInvariants, collectInvariantFailures } from './invariants';
import type { CaseScore } from './schemas';

/**
 * Pure TS port of the manual "agent-evaluation" skill's `compute_metrics.py` (B0-453): every
 * number in the rendered report is derived here from raw case scores, never asked of the model,
 * so the executive scorecard and the case-by-case detail can never disagree.
 *
 * B0-712 — the arithmetic **Grade** and the reported **Result** are two different things. The
 * grade is the weighted rubric roll-up and nothing else; the result is the grade's status after
 * the concept rules in `applyConceptRules` have had their say. Keeping them separate is the whole
 * point: a case can be capped to Partial Pass for missing a must-have concept while still
 * honestly reporting the B it scored.
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

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export type CaseStatus = 'Pass' | 'Partial Pass' | 'Fail';

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

/** Pass/Partial/Fail bands, highest first — same contract as `GRADE_BANDS` (B0-591). */
export const STATUS_BANDS: ReadonlyArray<{ status: CaseStatus; min: number }> = [
  { status: 'Pass', min: 80 },
  { status: 'Partial Pass', min: 60 },
  { status: 'Fail', min: 0 },
];

export function gradeFromScore(score: number): Grade {
  for (const band of GRADE_BANDS) {
    if (score >= band.min) return band.grade;
  }
  return 'F';
}

export function statusFromScore(score: number): CaseStatus {
  for (const band of STATUS_BANDS) {
    if (score >= band.min) return band.status;
  }
  return 'Fail';
}

/** Lower priority number = higher priority, matching the harness's existing UI tooltips. */
export function tierLabel(priority: number | null): string {
  return priority == null ? 'Unspecified' : `Tier ${priority}`;
}

function tierRank(label: string): number {
  const match = /tier\s*(\d+)/i.exec(label);
  return match ? Number(match[1]) : 99;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Which rule produced a case's final Result. `'rubric'` is the untouched weighted status. */
export type CaseStatusSource = 'rubric' | 'auto_pass' | 'minimal_gate';

/**
 * B0-712 — the concept rules, mirroring the skill's `final_status` in `concept_rules.py`.
 *
 * **The order is the rule.** It is applied exactly once, here:
 *
 * 1. the weighted rubric gives the baseline (`rubricStatus`),
 * 2. full expected coverage can *raise* a below-Pass case to Pass — unless a material factual
 *    issue is on the record, in which case the raise is withheld and recorded,
 * 3. a missing mandatory concept *caps* the case below Pass — applied **last**, so safety always
 *    wins over the automatic Pass, whatever the coverage says.
 *
 * Nothing here touches the sub-scores, `overall` or `grade`. The grade stays pure arithmetic.
 */
export type ConceptRuleOutcome = {
  status: CaseStatus;
  statusSource: CaseStatusSource;
  /**
   * True for *every* case with a missing mandatory concept, including one already below Pass on
   * score. Answers "how many results did the concept gate touch?".
   */
  ratingConstrained: boolean;
  /**
   * The narrower fact that the gate actually removed a Pass. Answers "how many Passes did the
   * gate cost us?". Never a substitute for `ratingConstrained` — they are different questions.
   */
  gateBlockedAPass: boolean;
  /** The automatic-Pass rule fired and raised the status. */
  autoPassTriggered: boolean;
  /** The case qualified for an automatic Pass but a material factual issue withheld it. */
  autoPassBlocked: boolean;
};

export function applyConceptRules(
  rubricStatus: CaseStatus,
  concepts: CaseConcepts | undefined,
): ConceptRuleOutcome {
  const outcome: ConceptRuleOutcome = {
    status: rubricStatus,
    statusSource: 'rubric',
    ratingConstrained: false,
    gateBlockedAPass: false,
    autoPassTriggered: false,
    autoPassBlocked: false,
  };
  if (!concepts) return outcome;

  // (2) Raise: every expected concept satisfied, on a case that specifies any.
  const fullExpectedCoverage =
    concepts.expected.required.length > 0 && concepts.expected.missing.length === 0;
  if (fullExpectedCoverage && outcome.status !== 'Pass') {
    if (concepts.materialIssue) {
      /**
       * Withheld, and recorded separately from "triggered": a report that shows only the granted
       * automatic Passes hides the case where a regulated value was wrong but coverage was full.
       *
       * Under B0-711's mapping this branch is a guard rather than a common path — a material issue
       * is a failed `exact` criterion, and that criterion is itself part of the expected set, so
       * its miss normally leaves expected coverage incomplete and the raise never gets this far.
       * It is kept (and reported) because the withholding rule must not depend on that coincidence:
       * if the exact checks are ever scoped outside the expected set, or a dataset supplies the
       * two sets independently, this is the line that stops a wrong regulated value passing.
       */
      outcome.autoPassBlocked = true;
    } else {
      outcome.status = 'Pass';
      outcome.statusSource = 'auto_pass';
      outcome.autoPassTriggered = true;
    }
  }

  // (3) Cap, last: a missing must-have concept can only ever lower the result.
  if (concepts.mandatory.missing.length > 0) {
    outcome.ratingConstrained = true;
    if (outcome.status === 'Pass') {
      outcome.gateBlockedAPass = true;
      outcome.status = 'Partial Pass';
      outcome.statusSource = 'minimal_gate';
    }
  }

  return outcome;
}

export type RateBlock = {
  n: number;
  avg: number | null;
  grade: Grade | '-';
  pass: number;
  partial: number;
  fail: number;
  passPct: number;
  partialPct: number;
  failPct: number;
};

/** The two facts a rate block reads off a case: its weighted score and its *final* Result. */
export type RatedCase = { overall: number; status: CaseStatus };

/**
 * B0-712 — `avg`/`grade` come from the weighted scores, `pass`/`partial`/`fail` from each case's
 * **final status**. Before this the counts re-derived themselves by thresholding the scores, which
 * silently discarded every concept adjustment: a gated case still counted as a Pass in the very
 * table the reader uses to judge the run. Taking cases (not a bare `number[]`) is what makes that
 * impossible to get wrong again — there is no score-only path left to fall back on.
 */
function rateBlock(cases: readonly RatedCase[]): RateBlock {
  const n = cases.length;
  if (n === 0) {
    return {
      n: 0,
      avg: null,
      grade: '-',
      pass: 0,
      partial: 0,
      fail: 0,
      passPct: 0,
      partialPct: 0,
      failPct: 0,
    };
  }
  const pass = cases.filter((c) => c.status === 'Pass').length;
  const partial = cases.filter((c) => c.status === 'Partial Pass').length;
  const fail = cases.filter((c) => c.status === 'Fail').length;
  const avg = round1(cases.reduce((sum, c) => sum + c.overall, 0) / n);
  return {
    n,
    avg,
    grade: gradeFromScore(avg),
    pass,
    partial,
    fail,
    passPct: round1((100 * pass) / n),
    partialPct: round1((100 * partial) / n),
    failPct: round1((100 * fail) / n),
  };
}

export type LatencyBlock = {
  unit: 's';
  n: number;
  avg: number;
  min: number;
  max: number;
  median: number;
  thresholds: { good: number; slow: number };
  bands: { good: number; acceptable: number; slow: number };
  slowest: Array<{ id: string; seconds: number }>;
};

/** Responsiveness is reported alongside the grade but never blended into it (methodology §7). */
function latencyBlock(
  entries: Array<{ id: string; seconds: number }>,
  goodThreshold = 5,
  slowThreshold = 10,
): LatencyBlock | null {
  if (entries.length === 0) {
    return null;
  }
  const secs = entries.map((e) => e.seconds).sort((a, b) => a - b);
  const n = secs.length;
  const median =
    n % 2 === 1 ? secs[(n - 1) / 2] : round1((secs[n / 2 - 1] + secs[n / 2]) / 2);
  const good = secs.filter((s) => s <= goodThreshold).length;
  const slow = secs.filter((s) => s > slowThreshold).length;
  const acceptable = n - good - slow;
  const slowest = [...entries].sort((a, b) => b.seconds - a.seconds).slice(0, 3);
  return {
    unit: 's',
    n,
    avg: round1(secs.reduce((a, b) => a + b, 0) / n),
    min: secs[0],
    max: secs[n - 1],
    median,
    thresholds: { good: goodThreshold, slow: slowThreshold },
    bands: { good, acceptable, slow },
    slowest,
  };
}

export type ReportCaseInput = {
  testItemId: string;
  question: string;
  priorityRaw: number | null;
  category: string | null;
  score: CaseScore;
  latencySeconds: number | null;
  /**
   * B0-711 — per-concept verdicts for this case, from grading the harness already persisted.
   * Absent (not empty) when the case has no concepts, which leaves every concept rule a no-op.
   */
  concepts?: CaseConcepts;
};

export type EvaluatedCase = {
  id: string;
  question: string;
  tier: string;
  priorityRaw: number | null;
  category: string;
  accuracy: number;
  completeness: number;
  relevance: number;
  clarity: number;
  overall: number;
  grade: Grade;
  /** The weighted rubric's own verdict, before any concept rule. */
  rubricStatus: CaseStatus;
  /** The reported Result: `rubricStatus` after the concept rules. */
  status: CaseStatus;
  statusSource: CaseStatusSource;
  ratingConstrained: boolean;
  gateBlockedAPass: boolean;
  autoPassTriggered: boolean;
  autoPassBlocked: boolean;
  /** Null when the case has no concept data — every flag above is then false. */
  concepts: CaseConcepts | null;
};

export type UteCase = {
  id: string;
  question: string;
  reason: string;
};

/** One concept phrase missing from more than one case, with the cases it spans. */
export type RecurringMissingConcept = {
  concept: string;
  count: number;
  caseIds: string[];
};

/** Coverage for one concept kind across the run. `pct` is out of `casesSpecifying`, never total. */
export type ConceptKindRollup = {
  /** Cases that specify at least one concept of this kind — the denominator. */
  casesSpecifying: number;
  casesSatisfyingAll: number;
  pct: number;
};

/**
 * B0-713 — the run-level concept readout. Null when no case in the run carried concept data at
 * all, which is what lets every concept section be omitted entirely rather than rendered as
 * "0 of 0".
 */
export type ConceptRollup = {
  casesWithConcepts: number;
  mandatory: ConceptKindRollup;
  expected: ConceptKindRollup;
  /** Cases missing at least one mandatory concept, with the concepts named verbatim. */
  missingMandatory: Array<{ id: string; question: string; missing: string[] }>;
  /** How many of `missingMandatory` actually lost a Pass to the gate (`gateBlockedAPass`). */
  gateBlockedPasses: number;
  autoPassed: Array<{ id: string; question: string }>;
  autoPassBlocked: Array<{ id: string; question: string; note: string | null }>;
  recurringMissing: RecurringMissingConcept[];
};

export type ReportMetrics = {
  totalCases: number;
  evaluated: number;
  ute: UteCase[];
  uteCount: number;
  overall: RateBlock;
  highest: Array<{ id: string; question: string; overall: number }>;
  lowest: Array<{ id: string; question: string; overall: number }>;
  perCase: EvaluatedCase[];
  tiers: Array<[string, RateBlock]>;
  categories: Array<[string, RateBlock]>;
  strongestCategory: string | null;
  weakestCategory: string | null;
  latency: LatencyBlock | null;
  /** Null when no evaluated case carried concept data. */
  concepts: ConceptRollup | null;
  warnings: string[];
};

function groupBy(
  cases: EvaluatedCase[],
  keyFn: (c: EvaluatedCase) => string,
  sortFn?: (a: string, b: string) => number,
): Array<[string, RateBlock]> {
  const order: string[] = [];
  const groups = new Map<string, EvaluatedCase[]>();
  for (const c of cases) {
    const key = keyFn(c);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(c);
  }
  const keys = sortFn ? [...order].sort(sortFn) : order;
  return keys.map((key) => [key, rateBlock(groups.get(key)!)]);
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : round1((100 * part) / whole);
}

/**
 * Rolls the per-case concept blocks up for the report's concept section. Returns null when no
 * evaluated case has one, so callers can omit the section instead of rendering empty counts.
 */
function conceptRollup(cases: readonly EvaluatedCase[]): ConceptRollup | null {
  const withConcepts = cases.filter(
    (c): c is EvaluatedCase & { concepts: CaseConcepts } => c.concepts != null,
  );
  if (withConcepts.length === 0) return null;

  const mandatorySpecifying = withConcepts.filter((c) => c.concepts.mandatory.required.length > 0);
  const expectedSpecifying = withConcepts.filter((c) => c.concepts.expected.required.length > 0);
  const mandatoryAll = mandatorySpecifying.filter((c) => c.concepts.mandatory.missing.length === 0);
  const expectedAll = expectedSpecifying.filter((c) => c.concepts.expected.missing.length === 0);

  // Recurring misses span the full expected set (mandatory ⊆ expected), so a must-have that keeps
  // being dropped is counted once, here, rather than twice under two headings.
  const spans = new Map<string, string[]>();
  for (const c of withConcepts) {
    for (const concept of c.concepts.expected.missing) {
      const ids = spans.get(concept) ?? [];
      if (!ids.includes(c.id)) ids.push(c.id);
      spans.set(concept, ids);
    }
  }
  const recurringMissing = [...spans.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([concept, ids]) => ({ concept, count: ids.length, caseIds: ids }))
    .sort((a, b) => b.count - a.count || a.concept.localeCompare(b.concept));

  return {
    casesWithConcepts: withConcepts.length,
    mandatory: {
      casesSpecifying: mandatorySpecifying.length,
      casesSatisfyingAll: mandatoryAll.length,
      pct: pct(mandatoryAll.length, mandatorySpecifying.length),
    },
    expected: {
      casesSpecifying: expectedSpecifying.length,
      casesSatisfyingAll: expectedAll.length,
      pct: pct(expectedAll.length, expectedSpecifying.length),
    },
    missingMandatory: withConcepts
      .filter((c) => c.concepts.mandatory.missing.length > 0)
      .map((c) => ({ id: c.id, question: c.question, missing: c.concepts.mandatory.missing })),
    gateBlockedPasses: withConcepts.filter((c) => c.gateBlockedAPass).length,
    autoPassed: withConcepts
      .filter((c) => c.autoPassTriggered)
      .map((c) => ({ id: c.id, question: c.question })),
    autoPassBlocked: withConcepts
      .filter((c) => c.autoPassBlocked)
      .map((c) => ({ id: c.id, question: c.question, note: c.concepts.materialIssueNote })),
    recurringMissing,
  };
}

/**
 * How a failed structural invariant is treated. `'throw'` (the default, and the generation path)
 * refuses to produce metrics at all; `'warn'` records every violation on `metrics.warnings` and
 * returns the metrics anyway, for re-deriving a report that is already persisted.
 */
export type InvariantSeverity = 'throw' | 'warn';

export type ComputeReportMetricsOptions = {
  invariantSeverity?: InvariantSeverity;
};

export function computeReportMetrics(
  inputs: ReportCaseInput[],
  options?: ComputeReportMetricsOptions,
): ReportMetrics {
  const total = inputs.length;
  const ute: UteCase[] = [];
  const evaluated: EvaluatedCase[] = [];
  const warnings: string[] = [];
  const latencyEntries: Array<{ id: string; seconds: number }> = [];

  for (const input of inputs) {
    if (input.latencySeconds != null) {
      latencyEntries.push({ id: input.testItemId, seconds: input.latencySeconds });
    }

    if (input.score.unableToEvaluate) {
      ute.push({
        id: input.testItemId,
        question: input.question,
        reason: input.score.uteReason ?? 'unspecified',
      });
      continue;
    }

    const rawSubs = {
      accuracy: input.score.accuracy,
      completeness: input.score.completeness,
      relevance: input.score.relevance,
      clarity: input.score.clarity,
    };
    const missing = Object.entries(rawSubs).filter(([, v]) => v == null);
    if (missing.length > 0) {
      warnings.push(
        `${input.testItemId}: missing sub-score(s) ${missing.map(([k]) => k).join(', ')}`,
      );
    }
    const accuracy = rawSubs.accuracy ?? 0;
    const completeness = rawSubs.completeness ?? 0;
    const relevance = rawSubs.relevance ?? 0;
    const clarity = rawSubs.clarity ?? 0;
    const overall = Math.round(
      WEIGHTS.accuracy * accuracy +
        WEIGHTS.completeness * completeness +
        WEIGHTS.relevance * relevance +
        WEIGHTS.clarity * clarity,
    );

    // B0-712 — the grade is the arithmetic, full stop; only the Result can move.
    const rubricStatus = statusFromScore(overall);
    const ruled = applyConceptRules(rubricStatus, input.concepts);

    if (input.concepts?.materialIssue && accuracy >= 80) {
      // Advisory, not structural: a material factual error on a regulated value that did not also
      // cut Accuracy leaves the case able to pass on its weighted score alone. That is a grading
      // problem to fix upstream, not a reason to refuse the report.
      warnings.push(
        `${input.testItemId}: material factual issue recorded but Accuracy is ${accuracy} (≥ 80) — a material error should also reduce Accuracy`,
      );
    }

    evaluated.push({
      id: input.testItemId,
      question: input.question,
      tier: tierLabel(input.priorityRaw),
      priorityRaw: input.priorityRaw,
      category: input.category?.trim() || 'Uncategorized',
      accuracy,
      completeness,
      relevance,
      clarity,
      overall,
      grade: gradeFromScore(overall),
      rubricStatus,
      status: ruled.status,
      statusSource: ruled.statusSource,
      ratingConstrained: ruled.ratingConstrained,
      gateBlockedAPass: ruled.gateBlockedAPass,
      autoPassTriggered: ruled.autoPassTriggered,
      autoPassBlocked: ruled.autoPassBlocked,
      concepts: input.concepts ?? null,
    });
  }

  const overall = rateBlock(evaluated);

  let highest: ReportMetrics['highest'] = [];
  let lowest: ReportMetrics['lowest'] = [];
  if (evaluated.length > 0) {
    const scores = evaluated.map((e) => e.overall);
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    highest = evaluated
      .filter((e) => e.overall === max)
      .map((e) => ({ id: e.id, question: e.question, overall: e.overall }));
    lowest = evaluated
      .filter((e) => e.overall === min)
      .map((e) => ({ id: e.id, question: e.question, overall: e.overall }));
  }

  const tiers = groupBy(evaluated, (e) => e.tier, (a, b) => tierRank(a) - tierRank(b));
  const categories = groupBy(evaluated, (e) => e.category);

  let strongestCategory: string | null = null;
  let weakestCategory: string | null = null;
  let strongestAvg = -Infinity;
  let weakestAvg = Infinity;
  for (const [name, block] of categories) {
    if (block.avg == null) continue;
    if (block.avg > strongestAvg) {
      strongestAvg = block.avg;
      strongestCategory = name;
    }
    if (block.avg < weakestAvg) {
      weakestAvg = block.avg;
      weakestCategory = name;
    }
  }

  const latency = latencyBlock(latencyEntries);

  if (warnings.length > 0) {
    console.warn('[report-metrics]', warnings.join('; '));
  }

  // B0-714 — structural reconciliation (methodology §11). On the generation path these throw: a
  // report whose counts do not add up, or that rates a case Pass while a must-have concept is
  // missing, is not a report with a note attached. Data-quality notes stay on `warnings` above and
  // still render. The read path passes `'warn'` — see `collectInvariantFailures`.
  const invariantContext = {
    totalCases: total,
    uteCount: ute.length,
    evaluated,
    overall,
    tiers,
    categories,
  };
  if (options?.invariantSeverity === 'warn') {
    warnings.push(...collectInvariantFailures(invariantContext));
  } else {
    assertReportInvariants(invariantContext);
  }

  return {
    totalCases: total,
    evaluated: evaluated.length,
    ute,
    uteCount: ute.length,
    overall,
    highest,
    lowest,
    perCase: evaluated,
    tiers,
    categories,
    strongestCategory,
    weakestCategory,
    latency,
    concepts: conceptRollup(evaluated),
    warnings,
  };
}
