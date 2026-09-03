import { z } from 'zod';

/**
 * Required = satisfied ∪ missing, always (asserted per kind, per case, by `./invariants`). Concept
 * phrases are regulated free text — copied verbatim from the golden columns, never parsed.
 */
export const conceptKindCoverageSchema = z.object({
  required: z.array(z.string()),
  satisfied: z.array(z.string()),
  missing: z.array(z.string()),
});

export type ConceptKindCoverage = z.infer<typeof conceptKindCoverageSchema>;

/**
 * B0-808/B0-809 — the grader's per-concept judgment for one case, authored on every pass.
 *
 * - `mandatory` — the `minimum_concepts` column (the skill's `Minimal_Excepted_Concepts`).
 * - `expected` — the `expected_concepts` column (`Expected_Key_Concepts`). Mandatory ⊆ expected.
 * - `materialIssue` — a material factual error, contradiction, fabrication, unsafe instruction or
 *   wrong regulated value (dilution, oz/gal, mL/L, ppm, %, contact time, CAS, EPA reg. no., log
 *   reduction). Reported on the case; it changes no score.
 */
export const caseConceptsSchema = z.object({
  mandatory: conceptKindCoverageSchema,
  expected: conceptKindCoverageSchema,
  materialIssue: z.boolean(),
  materialIssueNote: z.string().nullable(),
});

export type CaseConcepts = z.infer<typeof caseConceptsSchema>;

/**
 * Per-case grading output — one pass's judgment, and the shape persisted in `report_state`.
 *
 * B0-813 (pure-math scoring): the grader judges Accuracy, Relevance and Clarity and the concept
 * coverage; **Completeness is computed** downstream as the expected-concept coverage fraction
 * (`metrics.ts`) and is never asked of the model. The `completeness` field stays on the persisted
 * shape so `report_state` rows graded before B0-813 still parse; the new grader writes `null` and
 * the metrics layer ignores the field either way.
 *
 * The judged metrics (`similarity`, `evalConfidence`, methodology §7c) are reported beside the
 * grade and never enter it. Every new field is optional so legacy rows parse unchanged.
 */
export const caseScoreSchema = z.object({
  unableToEvaluate: z.boolean(),
  uteReason: z.string().nullable(),
  accuracy: z.number().min(0).max(100).nullable(),
  completeness: z.number().min(0).max(100).nullable(),
  relevance: z.number().min(0).max(100).nullable(),
  clarity: z.number().min(0).max(100).nullable(),
  explanation: z.string(),
  missed: z.string(),
  incorrect: z.string(),
  improvement: z.string(),
  /** The grader's per-concept verdicts for this pass; absent on rows graded before B0-808. */
  concepts: caseConceptsSchema.nullable().optional(),
  /** 0–1: how much of what the Ideal Response says the answer also says. Reported, not graded. */
  similarity: z.number().min(0).max(1).nullable().optional(),
  similarityNote: z.string().nullable().optional(),
  /** 0–100: how sure the grader is of this grade. The low end is the SME review queue. */
  evalConfidence: z.number().min(0).max(100).nullable().optional(),
  confidenceNote: z.string().nullable().optional(),
});

export type CaseScore = z.infer<typeof caseScoreSchema>;

export const top3RecommendationSchema = z.object({
  priority: z.number().int().min(1).max(3),
  what: z.string(),
  whyFirst: z.string(),
  evidence: z.string(),
  affected: z.string(),
  change: z.string(),
  impact: z.string(),
});

export type Top3Recommendation = z.infer<typeof top3RecommendationSchema>;

export const reportSynthesisSchema = z.object({
  failurePatterns: z.array(z.string()),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  top3: z.array(top3RecommendationSchema).length(3),
  exec: z.object({
    strongestAreas: z.array(z.string()),
    improvementAreas: z.array(z.string()),
    mostSignificantFailure: z.string(),
    majorRisk: z.string(),
    readiness: z.string(),
  }),
});

export type ReportSynthesis = z.infer<typeof reportSynthesisSchema>;

export const REPORT_STATUSES = [
  'idle',
  'scoring',
  'synthesizing',
  'completed',
  'failed',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

// Mirrors `Grade` from `./metrics.ts` plus the '-' sentinel `RateBlock.grade` uses when there are
// no evaluated cases; kept as an inline literal enum (rather than importing `Grade`) so this
// persisted-data schema doesn't need to depend on the metrics module's types.
const reportOverallGradeSchema = z.enum(['A', 'B', 'C', 'D', 'F', '-']);

export const reportOverallSchema = z.object({
  avg: z.number().nullable(),
  grade: reportOverallGradeSchema,
});

export type ReportOverall = z.infer<typeof reportOverallSchema>;

export const reportStateSchema = z.object({
  status: z.enum(REPORT_STATUSES),
  model: z.string(),
  totalCases: z.number().int().min(0),
  completedCases: z.number().int().min(0),
  startedAt: z.string(),
  updatedAt: z.string(),
  /**
   * The **consolidated** score per case — one per case, whatever the pass count. Kept as the
   * single-score record it has always been so every existing reader (the synthesizer, the read
   * path, a `report_state` row persisted before B0-719) keeps working untouched. With
   * `passes === 1` this is the one pass verbatim.
   */
  caseScores: z.record(z.string(), caseScoreSchema),
  /**
   * B0-719 — each pass's independent score for a case, in pass order. The resumption unit: a crash
   * during pass 2 leaves a one-entry array and only pass 2 is re-run.
   *
   * `.optional().default({})` for the same reason `overall` got it in B0-609 — a `report_state`
   * persisted before this field existed must still `safeParse`. A parse failure drops every
   * already-scored case to the orchestrator's "start fresh" fallback, which throws away real money
   * in grading calls.
   */
  casePassScores: z.record(z.string(), z.array(caseScoreSchema)).optional().default({}),
  /**
   * B0-719 — how many independent passes each case gets in *this* report. Resolved from
   * `settings.REPORT_GRADING_PASSES` when the state is created and then persisted, so a settings
   * change mid-run can never change the pass count of a report already part-way through.
   * Defaults to 1: a legacy row was graded exactly once.
   */
  passes: z.number().int().min(1).optional().default(1),
  /**
   * B0-720 — the score-range flag threshold in force when this report was graded. Null on a legacy
   * row (and on any single-pass report), where the reader falls back to the shipped default.
   */
  spreadThreshold: z.number().nullable().optional().default(null),
  /**
   * B0-812 — the pass mark this report's Results were derived from, resolved from
   * `settings.REPORT_PASS_MARK` when the state is created. Null on a legacy row, where the reader
   * falls back to `DEFAULT_PASS_MARK` (`./scoring-config`).
   */
  passMark: z.number().nullable().optional().default(null),
  /**
   * B0-810 — SHA-256 of the grading system prompt that scored this report (`GRADING_PROMPT_HASH`).
   * Null on a legacy row. Two reports that disagree can be told apart by this before anything else.
   */
  gradingPromptHash: z.string().nullable().optional().default(null),
  /** B0-811 — the judged-metric thresholds in force when this report was graded. Null on a legacy row. */
  judgedThresholds: z
    .object({
      simHigh: z.number(),
      simLow: z.number(),
      lowConfidence: z.number(),
      highSimFail: z.number(),
      lowSimPass: z.number(),
      corrMinN: z.number(),
    })
    .nullable()
    .optional()
    .default(null),
  synthesis: reportSynthesisSchema.nullable(),
  error: z.string().nullable(),
  // B0-609 — the report's aggregate score/grade (`computeReportMetrics(...).overall`), persisted
  // once generation completes so the "Recent runs" table can render it without recomputing
  // metrics from per-item data it doesn't otherwise load. `.optional()` so `report_state` rows
  // persisted before this field existed still parse successfully (falling back to `null`) instead
  // of failing `safeParse` entirely and losing already-scored `caseScores` to the orchestrator's
  // "start fresh" fallback.
  overall: reportOverallSchema.nullable().optional().default(null),
});

export type ReportState = z.infer<typeof reportStateSchema>;

export function parseReportState(value: unknown): ReportState | null {
  const result = reportStateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function emptyReportState(
  model: string,
  totalCases: number,
  /** B0-719 — the configured pass count, resolved once and then persisted. */
  passes = 1,
  /** B0-720 — the configured score-range flag threshold; null leaves the reader's default. */
  spreadThreshold: number | null = null,
  /** B0-812 — the configured pass mark; null leaves the reader's default. */
  passMark: number | null = null,
): ReportState {
  const now = new Date().toISOString();
  return {
    status: 'idle',
    model,
    totalCases,
    completedCases: 0,
    startedAt: now,
    updatedAt: now,
    caseScores: {},
    casePassScores: {},
    passes,
    spreadThreshold,
    passMark,
    gradingPromptHash: null,
    judgedThresholds: null,
    synthesis: null,
    error: null,
    overall: null,
  };
}

/**
 * B0-825 — everything that decided this report's numbers besides the answers themselves, read off
 * the persisted state so a report always says what it was graded with. Two reports that disagree
 * can be told apart by this block before anything else is compared.
 */
export type ReportGradingConfig = {
  model: string;
  passes: number;
  spreadThreshold: number | null;
  passMark: number | null;
  gradingPromptHash: string | null;
  judgedThresholds: ReportState['judgedThresholds'];
};

export function gradingConfigFromState(state: ReportState): ReportGradingConfig {
  return {
    model: state.model,
    passes: state.passes,
    spreadThreshold: state.spreadThreshold,
    passMark: state.passMark,
    gradingPromptHash: state.gradingPromptHash,
    judgedThresholds: state.judgedThresholds,
  };
}

/**
 * B0-719 — how many (case, pass) grading units are finished, which is what the progress bar counts.
 *
 * Counting cases would stall a 3-pass report's bar at 33% for two thirds of its run. A report
 * persisted before per-pass scores existed has no `casePassScores` at all, so it falls back to its
 * case count and its progress reads exactly as it did before.
 */
export function completedPassCount(state: ReportState): number {
  const fromPasses = Object.values(state.casePassScores).reduce(
    (total, scores) => total + scores.length,
    0,
  );
  return fromPasses > 0 ? fromPasses : state.completedCases;
}

/** The denominator that goes with `completedPassCount`. */
export function totalPassCount(state: ReportState): number {
  return state.totalCases * state.passes;
}
