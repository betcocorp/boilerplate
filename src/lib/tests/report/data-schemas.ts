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

/** Which responsiveness band a case's latency falls in. Reported, never part of the grade. */
export const reportLatencyBandSchema = z.enum(['good', 'acceptable', 'slow']);
export type ReportLatencyBand = z.infer<typeof reportLatencyBandSchema>;

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

/** Response-time summary across every case that recorded one. Never blended into the grade. */
export const reportLatencySchema = z.object({
  unit: z.literal('s'),
  n: z.number().int().min(0),
  avg: z.number(),
  min: z.number(),
  max: z.number(),
  median: z.number(),
  thresholds: z.object({ good: z.number(), slow: z.number() }),
  bands: z.object({
    good: z.number().int().min(0),
    acceptable: z.number().int().min(0),
    slow: z.number().int().min(0),
  }),
  slowest: z.array(z.object({ id: z.string(), seconds: z.number() })),
});
export type ReportLatency = z.infer<typeof reportLatencySchema>;

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
  status: reportCaseStatusSchema,
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
  latency: reportLatencySchema.nullable(),
  /** Non-fatal reconciliation/data-quality notes from metric computation. Usually empty. */
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

  // --- Reference signals (never part of the grade) ---
  latencySeconds: z.number().nullable(),
  /** Source precision, straight from `test_result_items.elapsed_ms`. */
  latencyMs: z.number().nullable(),
  /** Null when the case has no latency, or the run recorded none at all. */
  latencyBand: reportLatencyBandSchema.nullable(),
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
