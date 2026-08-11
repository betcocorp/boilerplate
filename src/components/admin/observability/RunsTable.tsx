/**
 * B0-335 — filter bar + runs table for `/admin/observability` (epic B0-330).
 *
 * Server component on purpose: the filter bar is a plain GET form (same
 * approach as `/admin/tests/failure-queue`), so filtering works without any
 * client-side state.
 */

import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/native-select';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';
import { getAgentBadgeClassName } from '~/lib/bex/agent-badge';
import { formatDurationSeconds, formatEasternTimestamp } from '~/lib/utils/time';

import type { WorkflowRunListRow } from '~/types/observability';

/** `workflow_runs.status` values written by `run-product-support-workflow.ts`. */
const RUN_STATUSES = ['running', 'completed', 'failed'] as const;

/**
 * Filterable `final_output->>routingDecision` values. Mirrors
 * `routingDecisionSchema` in `~/lib/orchestrator/orchestrator-schemas.ts`:
 * an SME agent id, or `ambiguous` when the planner could not commit.
 */
const ROUTING_FILTER_OPTIONS = [...SME_AGENT_IDS, 'ambiguous'] as const;

export type RunsTableFilters = {
  /** `YYYY-MM-DD` (UTC), as typed into the date inputs. */
  from: string;
  /** `YYYY-MM-DD` (UTC), as typed into the date inputs. */
  to: string;
  status: string;
  routingDecision: string;
  confidenceMin: string;
  confidenceMax: string;
  /** `''` | `'live'` | `'harness'`. */
  source: string;
};

type RunsTableProps = {
  route: string;
  rows: WorkflowRunListRow[];
  hasMore: boolean;
  page: number;
  filters: RunsTableFilters;
};

export function buildObservabilityHref(
  route: string,
  filters: RunsTableFilters,
  page: number,
): string {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.status) params.set('status', filters.status);
  if (filters.routingDecision) params.set('agent', filters.routingDecision);
  if (filters.confidenceMin) params.set('confidenceMin', filters.confidenceMin);
  if (filters.confidenceMax) params.set('confidenceMax', filters.confidenceMax);
  if (filters.source) params.set('source', filters.source);
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

export function RunsTable({ route, rows, hasMore, page, filters }: RunsTableProps) {
  return (
    <>
      {/* Filters */}
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
        <form
          action={route}
          className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
          method="get"
        >
          <div className="flex min-w-0 flex-col gap-2">
            <Label className="text-sm text-slate-700" htmlFor="observability-from">
              From (UTC)
            </Label>
            <Input
              defaultValue={filters.from}
              id="observability-from"
              name="from"
              type="date"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <Label className="text-sm text-slate-700" htmlFor="observability-to">
              To (UTC)
            </Label>
            <Input defaultValue={filters.to} id="observability-to" name="to" type="date" />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <Label className="text-sm text-slate-700" htmlFor="observability-status">
              Status
            </Label>
            <NativeSelect
              defaultValue={filters.status}
              id="observability-status"
              name="status"
            >
              <option value="">All statuses</option>
              {RUN_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <Label className="text-sm text-slate-700" htmlFor="observability-agent">
              Agent / routing
            </Label>
            <NativeSelect
              defaultValue={filters.routingDecision}
              id="observability-agent"
              name="agent"
            >
              <option value="">All agents</option>
              {ROUTING_FILTER_OPTIONS.map((agent) => (
                <option key={agent} value={agent}>
                  {agent}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <Label className="text-sm text-slate-700" htmlFor="observability-confidence-min">
              Confidence min (0–1)
            </Label>
            <Input
              defaultValue={filters.confidenceMin}
              id="observability-confidence-min"
              max="1"
              min="0"
              name="confidenceMin"
              placeholder="0"
              step="0.05"
              type="number"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <Label className="text-sm text-slate-700" htmlFor="observability-confidence-max">
              Confidence max (0–1)
            </Label>
            <Input
              defaultValue={filters.confidenceMax}
              id="observability-confidence-max"
              max="1"
              min="0"
              name="confidenceMax"
              placeholder="1"
              step="0.05"
              type="number"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <Label className="text-sm text-slate-700" htmlFor="observability-source">
              Source
            </Label>
            <NativeSelect
              defaultValue={filters.source}
              id="observability-source"
              name="source"
            >
              <option value="">All sources</option>
              <option value="live">Live</option>
              <option value="harness">Test harness</option>
            </NativeSelect>
          </div>

          <div className="flex items-end gap-2">
            <Button type="submit">Apply filters</Button>
            <Button asChild type="button" variant="outline">
              <Link href={route}>Reset</Link>
            </Button>
          </div>
        </form>
        <p className="mt-4 text-xs text-slate-500">
          Defaults to the last 7 days. Applying a confidence bound excludes runs
          that never recorded a confidence (in-flight or failed runs).
        </p>
      </section>

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
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Confidence</TableHead>
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
                  <TableCell className="text-slate-500" colSpan={9}>
                    No workflow runs match these filters.
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
                      <Badge
                        className={
                          run.source === 'harness'
                            ? 'border-indigo-600/45 bg-indigo-600/12 text-indigo-900'
                            : 'border-slate-500/40 bg-slate-500/10 text-slate-700'
                        }
                        variant="outline"
                      >
                        {run.source === 'harness' ? 'Test harness' : 'Live'}
                      </Badge>
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
