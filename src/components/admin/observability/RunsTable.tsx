/**
 * B0-335 — filter bar + runs table for `/admin/observability` (epic B0-330).
 *
 * Server component on purpose: the filter bar is a plain GET form (same
 * approach as `/admin/tests/failure-queue`), so filtering works without any
 * client-side state.
 */

import Link from 'next/link';

import { RunAttributionBadge } from '~/components/admin/observability/RunAttributionBadge';
import { RunsFilters } from '~/components/admin/observability/RunsFilters';
import { Badge } from '~/components/ui/badge';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { getAgentBadgeClassName } from '~/lib/bex/agent-badge';
import { formatDurationSeconds, formatEasternTimestamp } from '~/lib/utils/time';

import type { RunScore, WorkflowRunListRow } from '~/types/observability';

const RUN_SOURCE_BADGES: Record<
  string,
  { label: string; className: string }
> = {
  harness: {
    label: 'Test harness',
    className: 'border-indigo-600/45 bg-indigo-600/12 text-indigo-900',
  },
  bex_chat: {
    label: 'Bex chat',
    className: 'border-slate-500/40 bg-slate-500/10 text-slate-700',
  },
  orchestrator_api: {
    label: 'Orchestrator API',
    className: 'border-cyan-600/45 bg-cyan-600/12 text-cyan-900',
  },
};

const UNKNOWN_RUN_SOURCE_BADGE = {
  label: 'Unknown',
  className: 'border-slate-300 bg-slate-100 text-slate-500',
} as const;

export type RunsTableFilters = {
  /** `YYYY-MM-DD` (UTC), as typed into the date inputs. */
  from: string;
  /** `YYYY-MM-DD` (UTC), as typed into the date inputs. */
  to: string;
  status: string;
  routingDecision: string;
  confidenceMin: string;
  confidenceMax: string;
  /** `''` (all) or one of `RUN_SOURCE_OPTIONS` — a stored `RunSource`, or `'unknown'`. */
  source: string;
  /**
   * B0-431 — normalized prompt/run-id search term. Lives in this form rather than
   * beside the table heading on purpose: the list is server-paginated, so a control
   * that looked like it filtered the visible rows would quietly miss matches on
   * later pages.
   */
  search: string;
  /** B0-338 — `''` (all) or an `app_user.user_id` to filter to that one asker. */
  userId: string;
  /** B0-338 — `''` (all) or a `tests.id` to filter to that one test's runs. */
  testId: string;
  /** B0-593 — `''` (all) or one of `PRODUCT_TOOL_NAMES` to filter to runs that called that tool. */
  toolName: string;
};

type RunsTableProps = {
  route: string;
  rows: WorkflowRunListRow[];
  hasMore: boolean;
  page: number;
  filters: RunsTableFilters;
  /** B0-338 — options for the "single test" filter dropdown. */
  testOptions: { id: string; name: string }[];
};

export function buildObservabilityHref(
  route: string,
  filters: RunsTableFilters,
  page: number,
): string {
  const params = new URLSearchParams();
  if (filters.search) params.set('q', filters.search);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.status) params.set('status', filters.status);
  if (filters.routingDecision) params.set('agent', filters.routingDecision);
  if (filters.confidenceMin) params.set('confidenceMin', filters.confidenceMin);
  if (filters.confidenceMax) params.set('confidenceMax', filters.confidenceMax);
  if (filters.source) params.set('source', filters.source);
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.testId) params.set('testId', filters.testId);
  if (filters.toolName) params.set('tool', filters.toolName);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${route}?${qs}` : route;
}

function statusBadgeClassName(status: string): string {
  switch (status) {
    case 'completed':
      return 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900';
    case 'failed':
      return 'border-red-600/45 bg-red-600/12 text-red-900';
    case 'running':
      return 'border-sky-600/45 bg-sky-600/12 text-sky-900';
    default:
      return '';
  }
}

function confidenceLabel(confidence: number | null): string {
  return typeof confidence === 'number' ? `${(confidence * 100).toFixed(0)}%` : '—';
}

/** B0-793 — "82 (B)", never "82/100" or "82 out of 100" phrasing. */
function scoreLabel(score: RunScore | null): string {
  return score ? `${score.overall} (${score.grade})` : '—';
}

export function RunsTable({ route, rows, hasMore, page, filters, testOptions }: RunsTableProps) {
  return (
    <>
      <RunsFilters filters={filters} route={route} testOptions={testOptions} />

      {/* Runs */}
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Workflow runs</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-medium text-slate-500">
              {rows.length}
              {hasMore ? '+' : ''}
            </span>
          </div>
          <span className="text-xs text-slate-500">Page {page}</span>
        </div>

        <div className="max-h-[min(72vh,52rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100">
          <table className="w-full caption-bottom text-sm">
            <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Asked by</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead title="Weighted score (Accuracy 40% / Completeness 30% / Relevance 20% / Clarity 10%) from the test harness's grading, when this run was scored as part of a test report. Only harness-sourced runs can have a score.">
                  Score
                </TableHead>
                {/* B0-428 / B0-429 — time to first token, next to total duration. */}
                <TableHead title="Time to first assistant token, measured from workflow start. Policy-declined runs report the time their decline text was produced (no model call happens).">
                  Stream
                </TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead className="text-right">Trace</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={11}>
                    {filters.search
                      ? `No workflow runs match “${filters.search}” with these filters.`
                      : 'No workflow runs match these filters.'}
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((run) => {
                const href = `/admin/observability/${run.id}`;
                return (
                  <TableRow className="relative hover:bg-slate-50/60" key={run.id}>
                    <TableCell className="whitespace-nowrap align-top text-slate-700">
                      {/* Stretched link: makes the whole row navigate to the trace page. */}
                      <Link
                        className="font-medium text-sky-700 underline-offset-2 after:absolute after:inset-0 after:content-[''] hover:underline"
                        href={href}
                      >
                        {formatEasternTimestamp(run.createdAt)}
                      </Link>
                    </TableCell>
                    <TableCell className="align-top">
                      {(() => {
                        const badge = run.source
                          ? RUN_SOURCE_BADGES[run.source] ?? UNKNOWN_RUN_SOURCE_BADGE
                          : UNKNOWN_RUN_SOURCE_BADGE;
                        return (
                          <Badge
                            className={badge.className}
                            title={
                              run.source
                                ? undefined
                                : 'Recorded before run provenance was stored (B0-416); the entry point is not recoverable.'
                            }
                            variant="outline"
                          >
                            {badge.label}
                          </Badge>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="relative z-10 max-w-[16rem] align-top text-sm">
                      <RunAttributionBadge attribution={run.attribution} />
                    </TableCell>
                    <TableCell className="align-top">
                      {run.routingDecision ? (
                        <Badge
                          className={getAgentBadgeClassName(run.routingDecision)}
                          variant="outline"
                        >
                          {run.routingDecision}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge className={statusBadgeClassName(run.status)} variant="outline">
                        {run.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top tabular-nums text-slate-700">
                      {confidenceLabel(run.confidence)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top tabular-nums text-slate-700">
                      {scoreLabel(run.score)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top tabular-nums text-slate-600">
                      {formatDurationSeconds(run.ttftMs)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top text-slate-600">
                      {formatDurationSeconds(run.durationMs)}
                    </TableCell>
                    <TableCell className="max-w-md align-top text-slate-800">
                      <span className="line-clamp-2">{run.userMessagePreview ?? '—'}</span>
                    </TableCell>
                    <TableCell className="relative z-10 text-right align-top">
                      <Link
                        className="text-sky-700 underline-offset-2 hover:underline"
                        href={href}
                      >
                        View
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </table>
        </div>

        {page > 1 || hasMore ? (
          <nav
            aria-label="Workflow runs pagination"
            className="mt-8 flex flex-wrap items-center justify-center gap-2"
          >
            <Link
              className={`rounded-xl px-4 py-2 text-sm font-medium ${
                page === 1
                  ? 'pointer-events-none bg-slate-100 text-slate-400'
                  : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
              href={buildObservabilityHref(route, filters, Math.max(1, page - 1))}
            >
              Previous
            </Link>
            <span className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white">
              {page}
            </span>
            <Link
              className={`rounded-xl px-4 py-2 text-sm font-medium ${
                hasMore
                  ? 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
                  : 'pointer-events-none bg-slate-100 text-slate-400'
              }`}
              href={buildObservabilityHref(route, filters, page + 1)}
            >
              Next
            </Link>
          </nav>
        ) : null}
      </section>
    </>
  );
}
