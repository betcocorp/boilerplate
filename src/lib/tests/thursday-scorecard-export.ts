import { z } from 'zod';

import { describeThursdayScorecardScore } from '~/lib/tests/report-row-format';
import { formatChangePercent, formatChangePoints } from '~/lib/tests/report-trend';
import {
  type ThursdayScorecardAgentRow,
  type ThursdayScorecardSnapshot,
  thursdayScorecardSnapshotSchema,
} from '~/lib/tests/thursday-scorecard-schemas';
import { easternDateKey, formatDurationMs, formatEasternSweepLabel } from '~/lib/utils/time';

/**
 * B0-1168 (epic B0-1165) — the Thursday scorecard's exports: Markdown (copy / .md) and the JSON
 * document. Pure renderers over ONE `ThursdayScorecardSnapshot`, no I/O: the table on
 * `/admin/tests/reports`, the Markdown, the PDF (a capture of that table) and the JSON all read
 * the same object, so they cannot disagree. Every value is transcribed as the snapshot holds it —
 * never re-rounded, never converted; `null` renders as "—" in Markdown and stays `null` in JSON.
 */

const NOT_RECORDED = '—';

/** Column order of the on-screen scorecard table; the Markdown table must match it exactly. */
const MARKDOWN_COLUMNS = [
  '#',
  'Agent',
  'Score',
  'Change',
  'Fails',
  'Concept %',
  'TTFT/ELAP',
  'Model',
  'Version',
  'Speed',
  'Avg TTFT',
  'Similarity',
  'Eval conf.',
  'Pass rate',
] as const;

const MARKDOWN_NOTE =
  'Scores are out of 100. "—" means not recorded. Speed and judged metrics are reported beside ' +
  'the grade and never feed it.';

/** A GFM table cell: pipes would end the cell, newlines would end the row. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function orDash(value: string | number | null): string {
  return value === null ? NOT_RECORDED : String(value);
}

function durationOrDash(ms: number | null): string {
  return ms === null ? NOT_RECORDED : formatDurationMs(ms);
}

function changeCell(change: ThursdayScorecardAgentRow['change']): string {
  if (!change) return NOT_RECORDED;
  return `${formatChangePoints(change)} (${formatChangePercent(change)})`;
}

function speedCell(supporting: ThursdayScorecardAgentRow['supporting']): string {
  if (!supporting) return NOT_RECORDED;
  const parts = [supporting.speedScore, supporting.speedRating].filter((v) => v !== null);
  return parts.length ? parts.join(' · ') : NOT_RECORDED;
}

function agentRowCells(row: ThursdayScorecardAgentRow, index: number): string[] {
  const s = row.supporting;
  return [
    String(index + 1),
    escapeCell(row.agentLabel),
    describeThursdayScorecardScore(row),
    changeCell(row.change),
    orDash(row.failCount),
    row.conceptPercent === null ? NOT_RECORDED : `${row.conceptPercent}%`,
    `${durationOrDash(row.averageTtftMs)} / ${durationOrDash(row.averageElapsedMs)}`,
    escapeCell(orDash(row.modelTag)),
    escapeCell(orDash(row.appVersion)),
    speedCell(s),
    s === null || s.avgTtftSeconds === null ? NOT_RECORDED : `${s.avgTtftSeconds}s`,
    s === null ? NOT_RECORDED : orDash(s.similarityAvg),
    s === null ? NOT_RECORDED : orDash(s.evalConfidenceAvg),
    s === null || s.passRate === null ? NOT_RECORDED : `${s.passRate}%`,
  ];
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** The scorecard as one Markdown document: heading, preamble, one GFM table, a note line. */
export function renderThursdayScorecardMarkdown(snapshot: ThursdayScorecardSnapshot): string {
  const { sweep, previousSweep, agents } = snapshot;
  const baseline = previousSweep
    ? `Change is against the previous Thursday-night sweep, ${formatEasternSweepLabel(previousSweep.sweepTriggeredAt)}.`
    : 'No earlier Thursday-night sweep; Change is not available.';

  const lines: string[] = [
    `# Thursday scorecard — ${formatEasternSweepLabel(sweep.sweepTriggeredAt)}`,
    '',
    `Sweep \`${sweep.id}\` · ${sweep.successfulTests} of ${sweep.totalTests} ran · status: ${sweep.status}. ${baseline}`,
    '',
    tableRow(MARKDOWN_COLUMNS),
    tableRow(MARKDOWN_COLUMNS.map(() => '---')),
    ...agents.map((row, index) => tableRow(agentRowCells(row, index))),
    '',
    MARKDOWN_NOTE,
    '',
  ];
  return lines.join('\n');
}

export const EXPORT_THURSDAY_SCORECARD_JSON_COMMENT =
  'Exported from Bex /admin/tests/reports (B0-1168). One Thursday-night golden sweep per ' +
  'document; Change is against the previous Thursday-night sweep named in previousSweep. Values ' +
  'are transcribed from persisted test_results reports; null means not recorded.';

/** The JSON export: the snapshot's own fields, field for field, plus three export-time meta fields. */
export const thursdayScorecardJsonDocumentSchema = thursdayScorecardSnapshotSchema.extend({
  $comment: z.string(),
  /** ISO instant the document was produced. */
  exportedAt: z.string(),
  /** `APP_VERSION` of the app that produced the document (not of the runs — see `agents[].appVersion`). */
  appVersion: z.string(),
});
export type ThursdayScorecardJsonDocument = z.infer<typeof thursdayScorecardJsonDocumentSchema>;

export function buildThursdayScorecardJson(
  snapshot: ThursdayScorecardSnapshot,
  meta: { exportedAt: string; appVersion: string },
): ThursdayScorecardJsonDocument {
  return {
    $comment: EXPORT_THURSDAY_SCORECARD_JSON_COMMENT,
    exportedAt: meta.exportedAt,
    appVersion: meta.appVersion,
    sweep: snapshot.sweep,
    previousSweep: snapshot.previousSweep,
    agents: snapshot.agents,
  };
}

/** `thursday-scorecard-YYYY-MM-DD` — the Thursday's EASTERN date (the cron fires 00:00 UTC, the evening before in ET). */
export function thursdayScorecardExportFileBase(
  snapshot: Pick<ThursdayScorecardSnapshot, 'sweep'>,
): string {
  return thursdayScorecardFileBaseFor(snapshot.sweep.sweepTriggeredAt);
}

/** Same name from just the instant — the toolbar derives the JSON filename without the snapshot. */
export function thursdayScorecardFileBaseFor(sweepTriggeredAt: string): string {
  return `thursday-scorecard-${easternDateKey(sweepTriggeredAt)}`;
}

/** Strips the characters no filesystem download name may carry (same rule as the exec summary). */
export function sanitizeFilename(name: string): string {
  const trimmed = name.trim() || 'thursday-scorecard';
  return trimmed.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
}
