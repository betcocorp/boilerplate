import { z } from 'zod';

import {
  SCHEDULED_ITEM_STATUSES,
  SCHEDULED_RUN_STATUSES,
} from '~/lib/observability/scheduled-test-types';
import { reportSpeedRatingSchema } from '~/lib/tests/report/data-schemas';
import { REPORT_STATUSES } from '~/lib/tests/report/schemas';

/**
 * B0-1166 (epic B0-1165) — the Thursday-night agent scorecard contract.
 *
 * ONE snapshot object is what the table on `/admin/tests/reports` (B0-1164), the supporting-metric
 * columns (B0-1167) and every export — Markdown, .md, PDF, JSON (B0-1168) — render from. They never
 * re-query; if a number is not in the snapshot it is not on the page and not in the file, so the
 * four can never disagree.
 *
 * Rules carried over from the executive-scorecard skill (see the epic):
 * - Every value is TRANSCRIBED from a persisted source (`test_results.report_state.overall`,
 *   `test_results.failed_items`, the assembled report's `metrics`), never recomputed. `score` is
 *   exactly `report_state.overall.avg` as stored, one decimal, no re-rounding.
 * - A value that was never recorded is `null`, never 0 and never a placeholder string. Renderers
 *   turn `null` into "—"; the JSON export keeps `null`.
 * - `scheduled_test_items.grade` / `.confidence` are NOT a source (they are NULL on every row,
 *   see B0-1169); grade and score come from `test_results` via the child's `test_run_id`.
 * - Content (score / grade / change) and speed / judged metrics (`supporting`) stay separate:
 *   nothing in `supporting` feeds a grade.
 */

/** Same shape as `ReportScoreChange` in `~/lib/tests/report-trend.ts`, so its two `format*` helpers apply. */
export const thursdayScorecardChangeSchema = z.object({
  runId: z.string(),
  previousRunId: z.string(),
  /** The same agent's score in the previous Thursday-night sweep, exactly as persisted. */
  previousScore: z.number(),
  /** current − previous, in score points on the 0–100 scale, rounded to one decimal. */
  deltaPoints: z.number(),
  /** (current − previous) / previous × 100, one decimal; `null` when `previousScore` is 0. */
  changePercent: z.number().nullable(),
});
export type ThursdayScorecardChange = z.infer<typeof thursdayScorecardChangeSchema>;

/**
 * B0-1167 — the "supporting metrics" readout beside the grade, copied field for field from the
 * assembled report (`loadReportData` → `ReportDataReady.metrics`): `speed.avgScore`,
 * `speed.rating`, `speed.metrics.ttft.avgSeconds`, `speed.metrics.total.avgSeconds`,
 * `judged.similarity.avg`, `judged.evalConfidence.avg`, `overall.passRate` (0–100) and
 * `passMark`. Every field is nullable because each block is nullable upstream. Printed exactly as
 * the report states them — no re-rounding, no unit conversion beyond what `metrics.ts` already did.
 */
export const thursdayScorecardSupportingSchema = z.object({
  speedScore: z.number().nullable(),
  speedRating: reportSpeedRatingSchema.nullable(),
  avgTtftSeconds: z.number().nullable(),
  avgTotalSeconds: z.number().nullable(),
  /** 0–1, as `JudgedStats.avg` stores it. */
  similarityAvg: z.number().nullable(),
  /** 0–100, as `JudgedStats.avg` stores it. */
  evalConfidenceAvg: z.number().nullable(),
  /** 0–100 — `metrics.overall.passRate`. */
  passRate: z.number().nullable(),
  passMark: z.number().nullable(),
});
export type ThursdayScorecardSupporting = z.infer<typeof thursdayScorecardSupportingSchema>;

/** Mirrors `reportOverallGradeSchema` in `~/lib/tests/report/schemas.ts` (kept inline, same reason). */
export const thursdayScorecardGradeSchema = z.enum(['A', 'B', 'C', 'D', 'F', '-']);
export type ThursdayScorecardGrade = z.infer<typeof thursdayScorecardGradeSchema>;

/** One row of the scorecard: one golden agent (one sweep child) in one Thursday-night sweep. */
export const thursdayScorecardAgentRowSchema = z.object({
  /** `scheduled_test_items.test_id` — the dataset that stood in for this agent that night. */
  testId: z.string(),
  /** `scheduled_test_items.test_name` as recorded at dispatch time. */
  testName: z.string(),
  /** `tests.intended_agent` (nullable; archived sets may carry a retired id such as `floor`). */
  intendedAgent: z.string().nullable(),
  /** `V1_AGENT_REGISTRY` label for `intendedAgent`, else `testName` — never blank. */
  agentLabel: z.string(),
  /** `scheduled_test_items.test_run_id`; `null` when the create call itself failed. */
  runId: z.string().nullable(),
  /** The ledger child's status — what happened to the run that night. */
  ledgerStatus: z.enum(SCHEDULED_ITEM_STATUSES),
  /** `report_state.status`, or `null` when the run has no report state at all. */
  reportStatus: z.enum(REPORT_STATUSES).nullable(),
  /** `report_state.overall.avg`, exactly as persisted; `null` unless the report completed. */
  score: z.number().nullable(),
  grade: thursdayScorecardGradeSchema.nullable(),
  /** `test_results.failed_items`; `null` if never recorded. */
  failCount: z.number().int().nullable(),
  /** Against the SAME `testId` in the previous Thursday-night sweep; `null` when either side is unscored. */
  change: thursdayScorecardChangeSchema.nullable(),
  modelTag: z.string().nullable(),
  appVersion: z.string().nullable(),
  /** Average `test_result_items.ttft_ms` across the run's items; `null` if none recorded. */
  averageTtftMs: z.number().nullable(),
  /** Average `test_result_items.elapsed_ms` across the run's items; `null` if none recorded. */
  averageElapsedMs: z.number().nullable(),
  /** Whole-number percentage of mandatory concepts satisfied (same arithmetic as the "Reports" table). */
  conceptPercent: z.number().int().nullable(),
  /** B0-1167 — `null` when the loader was asked to skip it or the report is not complete. */
  supporting: thursdayScorecardSupportingSchema.nullable(),
});
export type ThursdayScorecardAgentRow = z.infer<typeof thursdayScorecardAgentRowSchema>;

export const thursdayScorecardSweepSchema = z.object({
  /** `scheduled_test_runs.id`. */
  id: z.string(),
  /** `scheduled_test_runs.sweep_triggered_at` (ISO, UTC). Thursday is decided in America/New_York. */
  sweepTriggeredAt: z.string(),
  status: z.enum(SCHEDULED_RUN_STATUSES),
  totalTests: z.number().int(),
  successfulTests: z.number().int(),
  failedTests: z.number().int(),
  timedOutTests: z.number().int(),
});
export type ThursdayScorecardSweep = z.infer<typeof thursdayScorecardSweepSchema>;

/** The whole scorecard for ONE Thursday-night sweep — the object every renderer consumes. */
export const thursdayScorecardSnapshotSchema = z.object({
  sweep: thursdayScorecardSweepSchema,
  /** The immediately preceding Thursday-night sweep (the Change baseline), or `null`. */
  previousSweep: thursdayScorecardSweepSchema.pick({ id: true, sweepTriggeredAt: true }).nullable(),
  /** One row per child of the sweep, in the ledger's child order (dispatch order). */
  agents: z.array(thursdayScorecardAgentRowSchema),
});
export type ThursdayScorecardSnapshot = z.infer<typeof thursdayScorecardSnapshotSchema>;

/** One selectable Thursday for the picker. */
export const thursdayScorecardSweepOptionSchema = z.object({
  sweepId: z.string(),
  sweepTriggeredAt: z.string(),
  status: z.enum(SCHEDULED_RUN_STATUSES),
});
export type ThursdayScorecardSweepOption = z.infer<typeof thursdayScorecardSweepOptionSchema>;

/** Newest first. */
export const thursdayScorecardListSchema = z.array(thursdayScorecardSweepOptionSchema);
export type ThursdayScorecardList = z.infer<typeof thursdayScorecardListSchema>;

/** What the page and the export route both load: the selected snapshot plus the picker's options. */
export const thursdayScorecardPageDataSchema = z.object({
  /** `null` only when no Thursday-night sweep has ever been recorded. */
  snapshot: thursdayScorecardSnapshotSchema.nullable(),
  sweeps: thursdayScorecardListSchema,
});
export type ThursdayScorecardPageData = z.infer<typeof thursdayScorecardPageDataSchema>;

/** The `?scorecardSweep=` search param on `/admin/tests/reports` and `?sweepId=` on the export route. */
export const SCORECARD_SWEEP_PARAM = 'scorecardSweep';
