import { z } from 'zod';

import { REPORT_STATUSES, caseScoreSchema, reportSynthesisSchema } from './schemas';

/**
 * B0-586 — the structured wire contract for `GET /api/admin/tests/runs/[runId]/report/data`.
 *
 * This is the *only* public shape the verdict-first report UI (epic B0-571) should build against:
 * every number, string and flag `renderReportMarkdown` puts into the Markdown document is
 * reachable from here, assembled from the same inputs by the same shared function
 * (`assembleReportData` in `./assemble.ts`) so the Markdown and the data can never disagree.
 *
 * Two rules this module deliberately enforces:
 *
 * 1. **Regulated values pass through verbatim.** Expected answers, expected concepts/sources and
 *    agent responses carry dilution ratios, contact/dwell times, ppm, oz/gal, mL/L and EPA/DIN
 *    numbers. They are typed as opaque `string`s and are never parsed, rounded, unit-converted or
 *    reformatted anywhere in assembly or serialization. Sub-scores and latencies likewise pass
 *    through at source precision.
 * 2. **Nothing is recomputed.** Every aggregate here is a projection of one `computeReportMetrics`
 *    call. Renderers must not re-derive grades, averages or rates from `cases`.
 */

/** Letter grade for an individual evaluated case (`gradeFromScore`). */
export const reportGradeSchema = z.enum(['A', 'B', 'C', 'D', 'F']);
export type ReportGrade = z.infer<typeof reportGradeSchema>;

/** A `RateBlock` grade — as `reportGradeSchema`, plus the `'-'` sentinel for an empty group. */
export const reportRateGradeSchema = z.enum(['A', 'B', 'C', 'D', 'F', '-']);
export type ReportRateGrade = z.infer<typeof reportRateGradeSchema>;

/** Pass ≥ 80, Partial Pass 60–79, Fail < 60 (`statusFromScore`). */
export const reportCaseStatusSchema = z.enum(['Pass', 'Partial Pass', 'Fail']);
export type ReportCaseStatus = z.infer<typeof reportCaseStatusSchema>;

/**
 * Which band a single timing falls in (`metricBand` in `./speed-rules`). Reported, never part of
 * the grade.
 */
export const reportSpeedBandSchema = z.enum(['good', 'acceptable', 'slow']);
export type ReportSpeedBand = z.infer<typeof reportSpeedBandSchema>;

/**
 * Rating words for a 0–100 Speed Performance Score (`SPEED_RATING_BANDS`). Words, never letters:
 * a "B" beside the content grade's "B" would read as the same judgment, and they are not.
 * Renderers print these verbatim and must never map them onto A–F.
 */
export const reportSpeedRatingSchema = z.enum([
  'Excellent',
  'Good',
  'Acceptable',
  'Slow',
  'Very slow',
]);
export type ReportSpeedRating = z.infer<typeof reportSpeedRatingSchema>;

/** Which timings a case's Speed Performance Score was computed from. */
export const reportSpeedBasisSchema = z.enum(['combined', 'ttft_only', 'total_only']);
export type ReportSpeedBasis = z.infer<typeof reportSpeedBasisSchema>;

/** Which metric a timing is. `ttft` = time to first token, `total` = total response time. */
export const reportSpeedMetricNameSchema = z.enum(['ttft', 'total']);
export type ReportSpeedMetricName = z.infer<typeof reportSpeedMetricNameSchema>;

/**
 * Counts, average and pass/partial/fail rates for one population of evaluated cases (the whole
 * run, one tier, or one category). `avg` is `null` and `grade` is `'-'` when `n === 0`.
 * Percentages are already rounded to one decimal — render them as-is, do not re-round.
 */
export const reportRateBlockSchema = z.object({
  n: z.number().int().min(0),
  avg: z.number().nullable(),
  grade: reportRateGradeSchema,
  pass: z.number().int().min(0),
  partial: z.number().int().min(0),
  fail: z.number().int().min(0),
  passPct: z.number(),
  partialPct: z.number(),
  failPct: z.number(),
});
export type ReportRateBlock = z.infer<typeof reportRateBlockSchema>;

/**
 * One row of the "Performance by tier" / "Performance by category" tables. The Markdown renders
 * these as ordered tuples; here they are named objects, in the same order (tiers ascending with
 * "Unspecified" last; categories in first-seen order).
 */
export const reportGroupRateSchema = z.object({
  name: z.string(),
  block: reportRateBlockSchema,
});
export type ReportGroupRate = z.infer<typeof reportGroupRateSchema>;

/** One measured timing on one case, with its normalized 0–100 score and band. */
export const reportCaseSpeedMetricSchema = z.object({
  metric: reportSpeedMetricNameSchema,
  /** Seconds at source precision — converted from ms once, in assembly, and never re-derived. */
  seconds: z.number(),
  score: z.number(),
  band: reportSpeedBandSchema,
  /** The renormalized weight actually applied (1 when this is the only metric measured). */
  weight: z.number(),
});
export type ReportCaseSpeedMetric = z.infer<typeof reportCaseSpeedMetricSchema>;

/**
 * B0-717 — one case's speed, as its own object rather than a field on the scoreline. Present only
 * for a case that recorded at least one timing, evaluated or Unable to Evaluate alike: the two
 * facts are independent in both directions.
 */
export const reportCaseSpeedSchema = z.object({
  id: z.string(),
  /** Null when that metric was not recorded. Never a zero standing in for an absent measurement. */
  ttft: reportCaseSpeedMetricSchema.nullable(),
  total: reportCaseSpeedMetricSchema.nullable(),
  /** The combined Speed Performance Score. Never blended into any content score or grade. */
  score: z.number(),
  rating: reportSpeedRatingSchema,
  basis: reportSpeedBasisSchema,
});
export type ReportCaseSpeed = z.infer<typeof reportCaseSpeedSchema>;

/** The thresholds in force for one metric, as `./speed-rules` resolved them for this run. */
export const reportSpeedThresholdsSchema = z.object({
  good: z.number(),
  acceptable: z.number(),
  poor: z.number(),
  floor: z.number(),
});
export type ReportSpeedThresholds = z.infer<typeof reportSpeedThresholdsSchema>;

/** Run-level aggregate for one metric. Every figure is rounded once here; render as-is. */
export const reportSpeedMetricAggregateSchema = z.object({
  metric: reportSpeedMetricNameSchema,
  label: z.string(),
  n: z.number().int().min(0),
  avgSeconds: z.number(),
  medianSeconds: z.number(),
  /** Null below the minimum sample size — print `p90Label`, which is then the `n/a` sentinel. */
  p90Seconds: z.number().nullable(),
  p90Label: z.string(),
  minSeconds: z.number(),
  maxSeconds: z.number(),
  avgScore: z.number(),
  bands: z.object({
    good: z.number().int().min(0),
    acceptable: z.number().int().min(0),
    slow: z.number().int().min(0),
  }),
  thresholds: reportSpeedThresholdsSchema,
  fastest: z.array(z.object({ id: z.string(), seconds: z.number() })),
  slowest: z.array(z.object({ id: z.string(), seconds: z.number() })),
});
export type ReportSpeedMetricAggregate = z.infer<typeof reportSpeedMetricAggregateSchema>;

/**
 * The run's speed readout, across both metrics. Null when not one case recorded either timing —
 * renderers then state that timing data was unavailable and draw no table.
 */
export const reportSpeedSchema = z.object({
  unit: z.literal('s'),
  /** Cases with at least one timing. */
  n: z.number().int().min(0),
  metrics: z.object({
    ttft: reportSpeedMetricAggregateSchema.nullable(),
    total: reportSpeedMetricAggregateSchema.nullable(),
  }),
  avgScore: z.number(),
  medianScore: z.number(),
  rating: reportSpeedRatingSchema,
  /** Every rating, including zero counts, in band order — so the distribution table is stable. */
  ratingDistribution: z.array(
    z.object({ rating: reportSpeedRatingSchema, count: z.number().int().min(0) }),
  ),
  basisCounts: z.object({
    combined: z.number().int().min(0),
    ttftOnly: z.number().int().min(0),
    totalOnly: z.number().int().min(0),
  }),
  weights: z.object({ ttft: z.number(), total: z.number() }),
  perCase: z.array(reportCaseSpeedSchema),
});
export type ReportSpeed = z.infer<typeof reportSpeedSchema>;

/** A case that could not be judged. Excluded from every average, grade, count and rate. */
export const reportUteCaseSchema = z.object({
  id: z.string(),
  question: z.string(),
  reason: z.string(),
});
export type ReportUteCase = z.infer<typeof reportUteCaseSchema>;

/** An entry of `metrics.highest` / `metrics.lowest` (all cases tied at the extreme score). */
export const reportScoreExtremeSchema = z.object({
  id: z.string(),
  question: z.string(),
  overall: z.number(),
});
export type ReportScoreExtreme = z.infer<typeof reportScoreExtremeSchema>;

/**
 * B0-713 — which rule produced a case's Result. `'rubric'` is the untouched weighted status;
 * `'auto_pass'` means full expected-concept coverage raised it; `'minimal_gate'` means a missing
 * must-have concept capped it below Pass.
 */
export const reportCaseStatusSourceSchema = z.enum(['rubric', 'auto_pass', 'minimal_gate']);
export type ReportCaseStatusSource = z.infer<typeof reportCaseStatusSourceSchema>;

/**
 * Coverage of one concept kind for one case. `required` is always `satisfied ∪ missing` — B0-714
 * asserts it as a structural invariant, so a renderer may print "satisfied of required" directly.
 * Concept phrases are regulated free text (rule 1): render them verbatim, never parsed.
 */
export const reportConceptKindCoverageSchema = z.object({
  required: z.array(z.string()),
  satisfied: z.array(z.string()),
  missing: z.array(z.string()),
});
export type ReportConceptKindCoverage = z.infer<typeof reportConceptKindCoverageSchema>;

/**
 * The per-case concept judgment, from the criteria grading the run already persisted (B0-711).
 * Absent — never an empty object — for a case with no concepts, so every concept-driven section
 * can be omitted entirely rather than rendered as "0 of 0".
 */
export const reportCaseConceptsSchema = z.object({
  /** Tier-1 ("must have") criteria — the set the rating gate reads. */
  mandatory: reportConceptKindCoverageSchema,
  /** The full criteria set (tiers 1, 2 and 3). */
  expected: reportConceptKindCoverageSchema,
  /** A failed deterministic (`match: 'exact'`) check on a regulated value. Derived in code. */
  materialIssue: z.boolean(),
  /** Names the failed concept(s) verbatim. Null exactly when `materialIssue` is false. */
  materialIssueNote: z.string().nullable(),
});
export type ReportCaseConcepts = z.infer<typeof reportCaseConceptsSchema>;

/** Coverage for one concept kind across the run. `pct` is out of `casesSpecifying`, never total. */
export const reportConceptKindRollupSchema = z.object({
  casesSpecifying: z.number().int().min(0),
  casesSatisfyingAll: z.number().int().min(0),
  pct: z.number(),
});
export type ReportConceptKindRollup = z.infer<typeof reportConceptKindRollupSchema>;

/** One concept phrase missing from more than one case, with the cases it spans. */
export const reportRecurringMissingConceptSchema = z.object({
  concept: z.string(),
  count: z.number().int().min(0),
  caseIds: z.array(z.string()),
});
export type ReportRecurringMissingConcept = z.infer<typeof reportRecurringMissingConceptSchema>;

/** The run-level concept readout. Null when no evaluated case carried concept data at all. */
export const reportConceptRollupSchema = z.object({
  casesWithConcepts: z.number().int().min(0),
  mandatory: reportConceptKindRollupSchema,
  expected: reportConceptKindRollupSchema,
  missingMandatory: z.array(
    z.object({ id: z.string(), question: z.string(), missing: z.array(z.string()) }),
  ),
  /** How many of `missingMandatory` actually lost a Pass to the gate. */
  gateBlockedPasses: z.number().int().min(0),
  autoPassed: z.array(z.object({ id: z.string(), question: z.string() })),
  autoPassBlocked: z.array(
    z.object({ id: z.string(), question: z.string(), note: z.string().nullable() }),
  ),
  recurringMissing: z.array(reportRecurringMissingConceptSchema),
});
export type ReportConceptRollup = z.infer<typeof reportConceptRollupSchema>;

/**
 * The derived scoreline for one evaluated case. Sub-scores are the grader's raw 0–100 judgments;
 * `overall` is the weighted roll-up (Accuracy 40 / Completeness 30 / Relevance 20 / Clarity 10),
 * and `grade`/`status` are derived from `overall`. Absent for Unable-to-Evaluate cases.
 */
export const reportEvaluatedCaseSchema = z.object({
  id: z.string(),
  question: z.string(),
  tier: z.string(),
  priorityRaw: z.number().nullable(),
  category: z.string(),
  accuracy: z.number(),
  completeness: z.number(),
  relevance: z.number(),
  clarity: z.number(),
  overall: z.number(),
  grade: reportGradeSchema,
  /** The weighted rubric's own verdict, before any concept rule (B0-712). */
  rubricStatus: reportCaseStatusSchema,
  /** The reported Result: `rubricStatus` after the concept rules. */
  status: reportCaseStatusSchema,
  statusSource: reportCaseStatusSourceSchema,
  /** True for every case missing a mandatory concept, even one already below Pass on score. */
  ratingConstrained: z.boolean(),
  /** The narrower fact that the gate actually removed a Pass. Not a substitute for the above. */
  gateBlockedAPass: z.boolean(),
  autoPassTriggered: z.boolean(),
  /** The case qualified for an automatic Pass but a material factual issue withheld it. */
  autoPassBlocked: z.boolean(),
  /** Null when the case has no concept data — every flag above is then false. */
  concepts: reportCaseConceptsSchema.nullable(),
});
export type ReportEvaluatedCase = z.infer<typeof reportEvaluatedCaseSchema>;

/** Everything the Markdown's scorecard, tier/category tables and aggregate findings render. */
export const reportMetricsSchema = z.object({
  /** Every case in the run, evaluated or not. */
  totalCases: z.number().int().min(0),
  /** `totalCases - uteCount` — the denominator of every average, rate and grade. */
  evaluated: z.number().int().min(0),
  uteCount: z.number().int().min(0),
  ute: z.array(reportUteCaseSchema),
  overall: reportRateBlockSchema,
  highest: z.array(reportScoreExtremeSchema),
  lowest: z.array(reportScoreExtremeSchema),
  /** Evaluated cases only, in dataset order. UTE cases are absent by design. */
  perCase: z.array(reportEvaluatedCaseSchema),
  tiers: z.array(reportGroupRateSchema),
  categories: z.array(reportGroupRateSchema),
  strongestCategory: z.string().nullable(),
  weakestCategory: z.string().nullable(),
  /**
   * B0-717 — the run's speed readout, replacing the old single-metric `latency` block. Null when
   * no case recorded a timing. Reported beside the grade and never part of it.
   */
  speed: reportSpeedSchema.nullable(),
  /** Null when no evaluated case carried concept data — omit every concept section entirely. */
  concepts: reportConceptRollupSchema.nullable(),
  /**
   * Non-fatal data-quality notes from metric computation. Usually empty. Structural
   * reconciliation failures are *not* here: those throw and the report is never written (B0-714).
   */
  warnings: z.array(z.string()),
});
export type ReportMetricsData = z.infer<typeof reportMetricsSchema>;

/**
 * The harness's own pass/fail signal for a case — reported for reference beside the LLM grade,
 * never part of it. `similarity` is the max retrieval similarity, at source precision.
 */
export const reportCaseHarnessSchema = z.object({
  passed: z.boolean().nullable(),
  status: z.string().nullable(),
  similarity: z.number().nullable(),
});
export type ReportCaseHarness = z.infer<typeof reportCaseHarnessSchema>;

/**
 * The full per-case ledger record (B0-590 consumes every field of this).
 *
 * `idealResponse`, `expectedConcepts`, `minimumConcepts`, `expectedSources` and `actual` are the
 * regulated free text: rendered verbatim, never parsed for numbers.
 */
export const reportCaseSchema = z.object({
  /** `test_items.id`. */
  id: z.string(),
  /** The DOM anchor the Markdown links to — `caseAnchorId(id)`. Use for deep links. */
  anchorId: z.string(),
  question: z.string(),
  /** `Tier N`, or `Unspecified` when the item has no priority. */
  tier: z.string(),
  /** The raw `test_items.priority`; lower number = higher priority. */
  priorityRaw: z.number().nullable(),
  category: z.string(),

  // --- Expected answer / behavior (verbatim) ---
  idealResponse: z.string().nullable(),
  expectedConcepts: z.string().nullable(),
  minimumConcepts: z.string().nullable(),
  expectedSources: z.string().nullable(),
  expectedShouldAnswer: z.boolean().nullable(),

  // --- What the agent actually said ---
  /** Trimmed `response_text`, or the literal `(no response recorded)` placeholder. */
  actual: z.string(),
  /** False when `actual` is the placeholder rather than a real recorded response. */
  responseRecorded: z.boolean(),

  // --- Grading ---
  /** The grader's raw output: sub-scores plus the four narrative fields. */
  score: caseScoreSchema,
  /** Convenience mirror of `score.unableToEvaluate`; `evaluated` is null exactly when true. */
  unableToEvaluate: z.boolean(),
  /** Null for UTE cases. Looked up from `metrics.perCase` — never recomputed. */
  evaluated: reportEvaluatedCaseSchema.nullable(),
  /**
   * The concept block this case was rated with (B0-713), or null when it has none. The same
   * object as `evaluated.concepts` for an evaluated case; present here too so the ledger can read
   * coverage without going through the scoreline.
   */
  concepts: reportCaseConceptsSchema.nullable(),

  // --- Reference signals (never part of the grade) ---
  /** Total response time in seconds — `latencyMs / 1000`, converted once during assembly. */
  latencySeconds: z.number().nullable(),
  /** Source precision, straight from `test_result_items.elapsed_ms`. */
  latencyMs: z.number().nullable(),
  /** B0-715 — time to first token in seconds. Null for runs that recorded none; never 0. */
  ttftSeconds: z.number().nullable(),
  /** Source precision, straight from `test_result_items.ttft_ms`. */
  ttftMs: z.number().nullable(),
  /**
   * The scored speed for this case (B0-717), or null when it recorded no timing at all. Looked up
   * from `metrics.speed.perCase` — never recomputed, in assembly or in a renderer.
   */
  speed: reportCaseSpeedSchema.nullable(),
  harness: reportCaseHarnessSchema.nullable(),
  /** `rag.document` ids retrieved for this answer, de-duplicated, in payload order. */
  retrievedDocumentIds: z.array(z.string()),
  workflowRunId: z.string().nullable(),
});
export type ReportCase = z.infer<typeof reportCaseSchema>;

/** A run that has no finished report yet — the explicit state, not a 404 and not an empty body. */
export const reportDataNotGeneratedSchema = z.object({
  ok: z.literal(true),
  status: z.literal('not_generated'),
  runId: z.string(),
  /** The generation state machine's position, or null when generation never started. */
  reportStatus: z.enum(REPORT_STATUSES).nullable(),
  totalCases: z.number().int().min(0),
  completedCases: z.number().int().min(0),
  /** Set only when `reportStatus === 'failed'`. */
  error: z.string().nullable(),
});
export type ReportDataNotGenerated = z.infer<typeof reportDataNotGeneratedSchema>;

/** A run whose report finished generating: the whole document, as data. */
export const reportDataReadySchema = z.object({
  ok: z.literal(true),
  status: z.literal('ready'),
  runId: z.string(),
  testId: z.string(),
  /** The dataset name — the Markdown's `# <name> — Agent Evaluation Report` heading. */
  testName: z.string(),
  intendedAgent: z.string().nullable(),
  /** ISO timestamp the report was generated. */
  generatedAt: z.string(),
  /**
   * True when the dataset's item count no longer matches the item count the report was generated
   * against — items were added or removed afterwards, so unscored cases appear as UTE. Show a
   * "regenerate this report" affordance; the numbers are still internally consistent.
   */
  stale: z.boolean(),
  metrics: reportMetricsSchema,
  synthesis: reportSynthesisSchema,
  /** Ordered exactly as the Markdown orders them: Tier 1 first, "Unspecified" last. */
  cases: z.array(reportCaseSchema),
});
export type ReportDataReady = z.infer<typeof reportDataReadySchema>;

/** The endpoint's success body. Branch on `status` before touching anything else. */
export const reportDataResponseSchema = z.discriminatedUnion('status', [
  reportDataReadySchema,
  reportDataNotGeneratedSchema,
]);
export type ReportDataResponse = z.infer<typeof reportDataResponseSchema>;
