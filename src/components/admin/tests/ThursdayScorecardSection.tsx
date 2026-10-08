import { ArrowRight, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { ReportChangeCell } from '~/components/admin/tests/ReportChangeCell';
import { ThursdayScorecardCards } from '~/components/admin/tests/ThursdayScorecardCards';
import { ThursdayScorecardSweepPicker } from '~/components/admin/tests/ThursdayScorecardSweepPicker';
import { TrendDelta } from '~/components/admin/tests/TrendDelta';
import { Button } from '~/components/ui/button';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  describeThursdayScorecardScore,
  truncateLabel,
} from '~/lib/tests/report-row-format';
import type {
  ThursdayScorecardAgentRow,
  ThursdayScorecardPageData,
} from '~/lib/tests/thursday-scorecard-schemas';
import { formatDurationMs, formatEasternSweepLabel } from '~/lib/utils/time';

/**
 * B0-1164 (epic B0-1165) — the Thursday scorecard card on `/admin/tests/reports`, directly under
 * "Reports". Same primitives, wrapper, sticky header and cell classes as the "Reports" table so
 * a scored row here and the same run's row above read identically. Renders ONLY from the
 * snapshot — nothing here re-queries. No week columns, no averages, no aggregate row.
 *
 * `#thursday-scorecard-capture` is the element the PDF export (B0-1168) captures; the sweep
 * picker and `exportsSlot` stay outside it on purpose. B0-1170 folds the trend indicators
 * (vs the previous Thursday-night sweep) into the same table and adds the highlights / notes
 * cards under it, inside the capture root.
 */

/** Column count, for the empty-state `colSpan`. */
const COLUMN_COUNT = 16;

/**
 * B0-1167 — the supporting-metric group sits after Version and before Report, set off by a left
 * border and a muted header so it reads as separate from Score/Change. Values print exactly as the
 * assembled report stores them (no re-rounding); `null` is "—".
 */
const SUPPORTING_HEAD_CLASS = 'border-l border-slate-200 text-slate-500';
const SUPPORTING_CELL_CLASS = 'whitespace-nowrap tabular-nums text-slate-600';

/** B0-1170 — the mock's "faster, not better" warning, shown beside the Speed value. */
const CONTENT_DOWN_SPEED_UP_TITLE =
  'Content quality declined while speed improved — this agent is answering faster and less well';

const LEDGER_STATUS_WORDS: Record<
  ThursdayScorecardAgentRow['ledgerStatus'],
  string
> = {
  queued: 'queued',
  claimed: 'claimed',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed out',
  skipped: 'skipped',
};

function describeScoreTitle(row: ThursdayScorecardAgentRow): string {
  const ledger = `Sweep child ${LEDGER_STATUS_WORDS[row.ledgerStatus]}`;
  const report =
    row.reportStatus === null
      ? 'no report state recorded'
      : `report ${row.reportStatus}`;
  return `${ledger} · ${report}`;
}

export function ThursdayScorecardSection({
  data,
  selectedSweepId,
  exportsSlot,
  hidePicker = false,
  historyHref = '/admin/tests/reports/scorecards',
}: {
  data: ThursdayScorecardPageData;
  /** The sweep actually rendered (the loader already degraded an unknown param to the newest). */
  selectedSweepId: string | null;
  /** B0-1168 — export buttons, rendered beside the picker and outside the capture root. */
  exportsSlot?: ReactNode;
  /** B0-1170 — the standalone card page renders one fixed sweep, so it has no picker. */
  hidePicker?: boolean;
  /** B0-1170 — link under the cards to the history view; `null` when this IS a card page. */
  historyHref?: string | null;
}) {
  const { snapshot } = data;
  const sweepLabel = snapshot
    ? formatEasternSweepLabel(snapshot.sweep.sweepTriggeredAt)
    : null;
  const previousLabel = snapshot?.previousSweep
    ? formatEasternSweepLabel(snapshot.previousSweep.sweepTriggeredAt)
    : null;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3 overflow-x-auto">
        <div className="flex shrink-0 gap-2 items-center">
          <h2 className="text-lg font-semibold text-slate-900">
            Thursday scorecard
          </h2>
          <span className="text-sm text-slate-600">
            {snapshot
              ? `${snapshot.agents.length} agent${snapshot.agents.length === 1 ? '' : 's'}`
              : 'No sweep'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {snapshot && selectedSweepId && !hidePicker ? (
            <ThursdayScorecardSweepPicker
              selectedSweepId={selectedSweepId}
              sweeps={data.sweeps}
            />
          ) : null}
          {exportsSlot}
        </div>
      </div>
      <div id="thursday-scorecard-capture">
        {snapshot ? (
          <p className="mb-3 text-xs text-slate-500">
            {`Thursday-night sweep · ${sweepLabel} · ${snapshot.sweep.successfulTests} of ${snapshot.sweep.totalTests} ran · `}
            {previousLabel
              ? `Change vs ${previousLabel}`
              : 'no earlier Thursday-night sweep'}
          </p>
        ) : null}
        <div className="scorecard-scroll relative max-h-[50vh] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
          <table className="w-full min-w-[1100px] caption-bottom text-sm">
            <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
              <TableRow>
                <TableHead title="Row number — the ledger's dispatch order for this sweep">
                  #
                </TableHead>
                <TableHead title="Golden agent (registry label for the dataset's intended agent; dataset name when the agent id is retired)">
                  Agent
                </TableHead>
                <TableHead title="Overall score/grade from the auto-generated eval report (B0-609) — the same value the Reports table shows for this run">
                  Score
                </TableHead>
                <TableHead title="Change from this agent's previous Thursday-night sweep">
                  Change
                </TableHead>
                <TableHead title="Failing prompts in this run — same count as the 'Fails' column on /admin/tests">
                  Fails
                </TableHead>
                <TableHead title="Percentage of criteria met across all evaluated cases">
                  Concept %
                </TableHead>
                <TableHead title="Average time-to-first-token / average elapsed time across this run's items">
                  TTFT/ELAP
                </TableHead>
                <TableHead title="LLM model used in this run (B0-733)">
                  Model
                </TableHead>
                <TableHead title="App version at run time (B0-733)">
                  Version
                </TableHead>
                <TableHead
                  className={SUPPORTING_HEAD_CLASS}
                  title="Speed Performance Score and rating from the run's report (metrics.speed.avgScore / rating) — reported beside the grade, never part of it"
                >
                  Speed
                </TableHead>
                <TableHead
                  className="text-slate-500"
                  title="Average time to first token in seconds from the run's report (metrics.speed.metrics.ttft.avgSeconds)"
                >
                  Avg TTFT
                </TableHead>
                <TableHead
                  className="text-slate-500"
                  title="Average judged similarity to the ideal response, 0–1, from the run's report (metrics.judged.similarity.avg) — reported, never graded"
                >
                  Similarity
                </TableHead>
                <TableHead
                  className="text-slate-500"
                  title="Average evaluator confidence, 0–100, from the run's report (metrics.judged.evalConfidence.avg)"
                >
                  Eval conf.
                </TableHead>
                <TableHead
                  className="text-slate-500"
                  title="Percentage of evaluated cases at or above the pass mark, from the run's report (metrics.overall.passPct)"
                >
                  Pass rate
                </TableHead>
                <TableHead title="Opens the run's eval report (completed reports only)">
                  Report
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!snapshot ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={COLUMN_COUNT}>
                    No Thursday-night sweep recorded yet.
                  </TableCell>
                </TableRow>
              ) : snapshot.agents.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={COLUMN_COUNT}>
                    This sweep recorded no agents.
                  </TableCell>
                </TableRow>
              ) : (
                snapshot.agents.map((row, index) => {
                  const runHref = row.runId
                    ? `/admin/tests/${row.testId}/runs/${row.runId}`
                    : null;
                  const agentText = truncateLabel(row.agentLabel, 24);
                  return (
                    <TableRow key={`${row.testId}:${row.runId ?? index}`}>
                      <TableCell className="whitespace-nowrap text-slate-600">
                        {index + 1}
                      </TableCell>
                      <TableCell className="max-w-[280px] truncate font-medium">
                        {runHref ? (
                          <Link
                            className="text-sky-700 underline-offset-2 hover:underline"
                            href={runHref}
                            title={row.testName}
                          >
                            {agentText}
                          </Link>
                        ) : (
                          <span title={row.testName}>{agentText}</span>
                        )}
                        {row.flags.includes('now_failing') ? (
                          <span
                            aria-label="Graded D or F this sweep"
                            className="ml-1 inline-block size-2 rounded-full bg-rose-500 align-middle"
                            role="img"
                            title="Graded D or F this sweep"
                          />
                        ) : null}
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap tabular-nums text-slate-700"
                        title={describeScoreTitle(row)}
                      >
                        <span className="flex flex-col items-start">
                          <span>{describeThursdayScorecardScore(row)}</span>
                          {row.grade !== null &&
                          row.previous?.grade !== null &&
                          row.previous?.grade !== undefined &&
                          row.previous.grade !== row.grade ? (
                            <span
                              className="text-xs text-slate-500"
                              title={`Grade ${row.previous.grade} in the previous Thursday-night sweep, ${row.grade} now`}
                            >
                              {`${row.previous.grade} → ${row.grade}`}
                            </span>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <ReportChangeCell
                          change={row.change}
                          noChangeTitle={
                            row.score === null
                              ? 'This agent has no score in this sweep, so there is nothing to compare'
                              : previousLabel
                                ? `This agent has no score in the previous Thursday-night sweep (${previousLabel})`
                                : 'No earlier Thursday-night sweep to compare against'
                          }
                          previousTitle={
                            row.change && previousLabel
                              ? `Previous Thursday-night sweep (${previousLabel}): ${row.change.previousScore}/100`
                              : undefined
                          }
                          score={row.score}
                        />
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap tabular-nums text-slate-700"
                        title={
                          row.failCount === null
                            ? 'Not recorded for this run'
                            : `${row.failCount} failing prompt${row.failCount === 1 ? '' : 's'} in this run`
                        }
                      >
                        <span className="flex flex-col items-start">
                          <span>{row.failCount ?? '—'}</span>
                          <TrendDelta
                            betterWhen="lower"
                            current={row.failCount}
                            label="Failed prompts"
                            previous={row.previous?.failCount ?? null}
                          />
                        </span>
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap tabular-nums text-slate-700"
                        title={
                          row.conceptPercent !== null
                            ? 'Percentage of mandatory concepts satisfied'
                            : 'No report data available'
                        }
                      >
                        {row.conceptPercent !== null
                          ? row.conceptPercent + '%'
                          : '—'}
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap tabular-nums text-slate-600"
                        title="Average TTFT / average elapsed time across this run's items"
                      >
                        {row.averageTtftMs === null
                          ? '—'
                          : formatDurationMs(row.averageTtftMs)}
                        {' / '}
                        {row.averageElapsedMs === null
                          ? '—'
                          : formatDurationMs(row.averageElapsedMs)}
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap text-slate-600"
                        title={row.modelTag ?? 'Not recorded for this run'}
                      >
                        {row.modelTag ?? '—'}
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap text-slate-600"
                        title={row.appVersion ?? 'Not recorded for this run'}
                      >
                        {row.appVersion ?? '—'}
                      </TableCell>
                      <TableCell
                        className={`border-l border-slate-200 ${SUPPORTING_CELL_CLASS}`}
                        title={
                          row.supporting?.speedScore !== null &&
                          row.supporting?.speedScore !== undefined
                            ? 'Speed Performance Score · rating, as the report states them'
                            : 'No completed report — no speed readout'
                        }
                      >
                        <span className="flex flex-col items-start">
                          <span className="inline-flex items-center gap-1">
                            {row.supporting?.speedScore !== null &&
                            row.supporting?.speedScore !== undefined
                              ? `${row.supporting.speedScore} · ${row.supporting.speedRating ?? '—'}`
                              : '—'}
                            {row.flags.includes('content_down_speed_up') ? (
                              <span
                                aria-label={CONTENT_DOWN_SPEED_UP_TITLE}
                                className="inline-flex"
                                role="img"
                                title={CONTENT_DOWN_SPEED_UP_TITLE}
                              >
                                <TriangleAlert
                                  aria-hidden
                                  className="size-3.5 text-amber-600"
                                />
                              </span>
                            ) : null}
                          </span>
                          <TrendDelta
                            betterWhen="higher"
                            current={row.supporting?.speedScore ?? null}
                            label="Speed score"
                            previous={row.previous?.speedScore ?? null}
                          />
                        </span>
                      </TableCell>
                      <TableCell
                        className={SUPPORTING_CELL_CLASS}
                        title="Average time to first token across the report's evaluated cases"
                      >
                        {row.supporting?.avgTtftSeconds !== null &&
                        row.supporting?.avgTtftSeconds !== undefined
                          ? `${row.supporting.avgTtftSeconds}s`
                          : '—'}
                      </TableCell>
                      <TableCell
                        className={SUPPORTING_CELL_CLASS}
                        title="Average judged similarity (0–1)"
                      >
                        {row.supporting?.similarityAvg ?? '—'}
                      </TableCell>
                      <TableCell
                        className={SUPPORTING_CELL_CLASS}
                        title="Average evaluator confidence (0–100)"
                      >
                        {row.supporting?.evalConfidenceAvg ?? '—'}
                      </TableCell>
                      <TableCell
                        className={SUPPORTING_CELL_CLASS}
                        title={
                          row.supporting?.passMark !== null &&
                          row.supporting?.passMark !== undefined
                            ? `Cases at or above the pass mark of ${row.supporting.passMark}`
                            : 'No completed report — no pass rate'
                        }
                      >
                        <span className="flex flex-col items-start">
                          <span>
                            {row.supporting?.passRate !== null &&
                            row.supporting?.passRate !== undefined
                              ? `${row.supporting.passRate}%`
                              : '—'}
                          </span>
                          <TrendDelta
                            betterWhen="higher"
                            current={row.supporting?.passRate ?? null}
                            format={(n) => `${n}%`}
                            label="Pass rate"
                            previous={row.previous?.passRate ?? null}
                          />
                        </span>
                      </TableCell>
                      <TableCell>
                        {row.runId && row.reportStatus === 'completed' ? (
                          <Button asChild size="sm" variant="outline">
                            <Link
                              href={`/admin/tests/${row.testId}/runs/${row.runId}/report`}
                            >
                              View
                            </Link>
                          </Button>
                        ) : (
                          <span
                            className="text-slate-400"
                            title={
                              row.runId
                                ? 'No completed report for this run'
                                : 'No run was created for this agent in this sweep'
                            }
                          >
                            —
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </table>
        </div>

        <p className="mt-4 border-t border-slate-200 pt-3 text-xs italic text-slate-500">
          Grade, score (out of 100) and failed prompts are the content result;
          pass rate is the share of prompts at or above the pass mark. Speed
          score, average time to first token, similarity and evaluator
          confidence are independent supporting metrics — none contributes to
          the grade or the score. — means the source evaluation did not report
          that metric; it is never read as zero.
        </p>

        {snapshot ? <ThursdayScorecardCards snapshot={snapshot} /> : null}

        <p className="mt-4 border-t border-slate-200 pt-3 text-xs italic text-slate-500">
          This report card summarizes finalized agent-evaluation reports. It
          performs no grading, changes no methodology and recalculates no score
          — every grade, score, failure count and supporting metric is
          transcribed from the source evaluation, which remains the source of
          truth.
        </p>
        <Link
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-sky-700 underline-offset-2 hover:underline"
          href="/admin/tests/reports/scorecards"
        >
          View all Thursday report cards <ArrowRight className="size-3" />
        </Link>
      </div>
    </section>
  );
}
