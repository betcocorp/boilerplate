import { z } from 'zod';

/**
 * Per-case grading output. Mirrors the manual "agent-evaluation" methodology's eval.json case
 * shape (B0-453): the model supplies judgment only — accuracy/completeness/relevance/clarity are
 * raw 0-100 sub-scores. Overall/grade/status are always derived downstream in metrics.ts, never
 * asked of the model, so the two can never drift apart.
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
});

export type CaseScore = z.infer<typeof caseScoreSchema>;

export const top3RecommendationSchema = z.object({
  priority: z.number().int().min(1).max(3),
  what: z.string(),
  whyFirst: z.string(),
  evidence: z.string(),
  affected: z.string(),
  change: z.string(),
  changePseudocode: z.array(z.string()).min(1),
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
  caseScores: z.record(z.string(), caseScoreSchema),
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

export function emptyReportState(model: string, totalCases: number): ReportState {
  const now = new Date().toISOString();
  return {
    status: 'idle',
    model,
    totalCases,
    completedCases: 0,
    startedAt: now,
    updatedAt: now,
    caseScores: {},
    synthesis: null,
    error: null,
    overall: null,
  };
}
