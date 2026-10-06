/**
 * B0-528 — filter bar + table for `/admin/escalations`. Server component: the status filter is a
 * plain GET form (same approach as `RunsTable`), so filtering works without client state. Only the
 * per-row status form (`EscalationStatusForm`) is a client island.
 */

import Link from 'next/link';

import { EscalationStatusForm } from '~/components/admin/escalations/EscalationStatusForm';
import { Badge } from '~/components/ui/badge';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  ESCALATION_STATUSES,
  type EscalationRow,
  type EscalationStatus,
} from '~/lib/escalations/escalation-repository';
import { formatEasternTimestamp } from '~/lib/utils/time';

export const ESCALATION_STATUS_LABELS: Record<EscalationStatus, string> = {
  open: 'Open',
  in_review: 'In review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

const STATUS_BADGES: Record<EscalationStatus, string> = {
  open: 'border-amber-500/50 bg-amber-500/10 text-amber-900',
  in_review: 'border-sky-600/45 bg-sky-600/12 text-sky-900',
  resolved: 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900',
  dismissed: 'border-slate-300 bg-slate-100 text-slate-500',
};

const REASON_LABELS: Record<EscalationRow['reason'], string> = {
  no_evidence: 'No evidence',
  low_confidence: 'Low confidence',
  regulated_value_not_on_file: 'Regulated value not on file',
  out_of_scope: 'Out of scope',
  compatibility_unverified: 'Compatibility unverified',
  safety_incident: 'Safety incident',
  user_requested: 'User requested',
  other: 'Other',
};

const SOURCE_LABELS: Record<string, string> = {
  harness: 'Test harness',
  bex_chat: 'Bex chat',
  orchestrator_api: 'Orchestrator API',
};

const QUESTION_PREVIEW_MAX_CHARS = 120;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildHref(route: string, statusFilter: string, page: number): string {
  const params = new URLSearchParams();
  if (statusFilter !== 'open') params.set('status', statusFilter);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

type EscalationsTableProps = {
  route: string;
  rows: EscalationRow[];
  hasMore: boolean;
  page: number;
  statusFilter: EscalationStatus | 'all';
};

export function EscalationsTable({ route, rows, hasMore, page, statusFilter }: EscalationsTableProps) {
  return (
    <>
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <form action={route} className="flex flex-wrap items-end gap-4" method="get">
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Status
            <select
              className="h-9 min-w-40 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm"
              defaultValue={statusFilter}
              name="status"
            >
              <option value="all">All statuses</option>
              {ESCALATION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {ESCALATION_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <button
            className="h-9 rounded-xl bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800"
            type="submit"
          >
            Apply
          </button>
          <Link
            className="text-sm font-medium text-sky-700 underline-offset-2 hover:underline"
            href={route}
          >
            Reset
          </Link>
        </form>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Escalations</h2>
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
                <TableHead>Reference</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Specialist</TableHead>
                <TableHead>Question</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Trace</TableHead>
                <TableHead className="min-w-72">Update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={9}>
                    {statusFilter === 'all'
                      ? 'No escalations have been logged yet.'
                      : `No ${ESCALATION_STATUS_LABELS[statusFilter].toLowerCase()} escalations.`}
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((row) => (
                <TableRow className="hover:bg-slate-50/60" key={row.id}>
                  <TableCell className="whitespace-nowrap align-top font-mono text-sm font-medium text-slate-900">
                    {row.reference}
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top text-slate-700">
                    {formatEasternTimestamp(row.created_at)}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge className={STATUS_BADGES[row.status]} variant="outline">
                      {ESCALATION_STATUS_LABELS[row.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top text-slate-700">{REASON_LABELS[row.reason]}</TableCell>
                  <TableCell className="align-top text-slate-700">
                    {row.specialist ?? <span className="text-xs text-slate-400">—</span>}
                  </TableCell>
                  <TableCell className="max-w-md align-top text-slate-800">
                    <span title={row.question}>{truncate(row.question, QUESTION_PREVIEW_MAX_CHARS)}</span>
                    <p className="mt-1 text-xs leading-5 text-slate-500" title={row.summary}>
                      {truncate(row.summary, QUESTION_PREVIEW_MAX_CHARS)}
                    </p>
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top text-slate-600">
                    {row.source ? (SOURCE_LABELS[row.source] ?? row.source) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top">
                    {row.workflow_run_id ? (
                      <Link
                        className="text-sky-700 underline-offset-2 hover:underline"
                        href={`/admin/observability/${row.workflow_run_id}`}
                      >
                        View run
                      </Link>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <EscalationStatusForm
                      id={row.id}
                      initialNotes={row.resolution_notes ?? ''}
                      initialStatus={row.status}
                      reference={row.reference}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </table>
        </div>

        {page > 1 || hasMore ? (
          <nav
            aria-label="Escalations pagination"
            className="mt-8 flex flex-wrap items-center justify-center gap-2"
          >
            <Link
              className={`rounded-xl px-4 py-2 text-sm font-medium ${
                page === 1
                  ? 'pointer-events-none bg-slate-100 text-slate-400'
                  : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
              href={buildHref(route, statusFilter, Math.max(1, page - 1))}
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
              href={buildHref(route, statusFilter, page + 1)}
            >
              Next
            </Link>
          </nav>
        ) : null}
      </section>
    </>
  );
}
