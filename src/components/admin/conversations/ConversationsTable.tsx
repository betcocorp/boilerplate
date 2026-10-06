/**
 * B0-533 — filter bar + conversations table for `/admin/bex/conversations` (epic B0-526).
 *
 * Server component, like `RunsTable.tsx`: the filter bar submits as a plain GET so the list is
 * linkable, and pagination is a pair of links built from the same filters.
 */

import Link from 'next/link';

import { ConversationOwnerBadge } from '~/components/admin/conversations/ConversationOwnerBadge';
import { ConversationsFilters } from '~/components/admin/conversations/ConversationsFilters';
import { formatMs, truncateChars } from '~/components/admin/conversations/format';
import { Badge } from '~/components/ui/badge';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { formatEasternTimestamp } from '~/lib/utils/time';

import type { ConversationListRow } from '~/lib/conversations/admin-conversation-browser';

export type ConversationsTableFilters = {
  /** `YYYY-MM-DD` (EST), as typed into the date inputs. */
  from: string;
  to: string;
  /** `chat` | `test_run` | `all`. */
  source: string;
  /** Raw owner filter as typed (email or user id). */
  user: string;
  /** Normalized search term. */
  search: string;
  /** `''` or a positive integer as typed. */
  minTurns: string;
};

export const SOURCE_BADGES: Record<string, { label: string; className: string }> = {
  chat: {
    label: 'Bex chat',
    className: 'border-slate-500/40 bg-slate-500/10 text-slate-700',
  },
  test_run: {
    label: 'Test harness',
    className: 'border-indigo-600/45 bg-indigo-600/12 text-indigo-900',
  },
};

export function buildConversationsHref(
  route: string,
  filters: ConversationsTableFilters,
  page: number,
): string {
  const params = new URLSearchParams();
  if (filters.search) params.set('q', filters.search);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.source && filters.source !== 'chat') params.set('source', filters.source);
  if (filters.user) params.set('user', filters.user);
  if (filters.minTurns) params.set('minTurns', filters.minTurns);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${route}?${qs}` : route;
}

export function ConversationsTable({
  route,
  rows,
  total,
  page,
  pageSize,
  filters,
}: {
  route: string;
  rows: ConversationListRow[];
  total: number;
  page: number;
  pageSize: number;
  filters: ConversationsTableFilters;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasMore = page < pageCount;

  return (
    <>
      <ConversationsFilters filters={filters} route={route} />

      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Conversations</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-medium text-slate-500">
              {total.toLocaleString('en-US')}
            </span>
          </div>
          <span className="text-xs text-slate-500">
            Page {page} of {pageCount}
          </span>
        </div>

        <div className="max-h-[min(72vh,52rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100">
          <table className="w-full caption-bottom text-sm">
            <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Title / first prompt</TableHead>
                <TableHead title="User messages in the conversation">Turns</TableHead>
                <TableHead title="Σ processing_ms across assistant replies — how long Bex spent answering">
                  Agent time
                </TableHead>
                <TableHead title="Σ user_pause_ms across user messages — how long the user sat between Bex's reply and their next message">
                  Pause time
                </TableHead>
                <TableHead>Latest model</TableHead>
                <TableHead className="text-right">Turns view</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={9}>
                    {filters.search
                      ? `No conversations match “${filters.search}” with these filters.`
                      : 'No conversations match these filters.'}
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((row) => {
                const href = `/admin/bex/conversations/${row.id}`;
                const sourceBadge = SOURCE_BADGES[row.source] ?? SOURCE_BADGES.chat;
                return (
                  <TableRow className="relative hover:bg-slate-50/60" key={row.id}>
                    <TableCell className="whitespace-nowrap align-top text-slate-700">
                      <Link
                        className="font-medium text-sky-700 underline-offset-2 after:absolute after:inset-0 after:content-[''] hover:underline"
                        href={href}
                      >
                        {formatEasternTimestamp(row.startedAt)}
                      </Link>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge className={sourceBadge.className} variant="outline">
                        {sourceBadge.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="relative z-10 max-w-[16rem] align-top text-sm">
                      <ConversationOwnerBadge
                        actedBy={row.actedBy}
                        maxChars={18}
                        owner={row.owner}
                      />
                    </TableCell>
                    <TableCell className="max-w-md align-top text-slate-800">
                      <span title={row.title}>{truncateChars(row.title, 60)}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top tabular-nums text-slate-700">
                      {row.metrics.turnCount}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap align-top tabular-nums text-slate-700"
                      title={
                        row.metrics.agentSampleSize > 0
                          ? `${row.metrics.agentSampleSize} measured repl${row.metrics.agentSampleSize === 1 ? 'y' : 'ies'}`
                          : 'No reply recorded processing_ms'
                      }
                    >
                      {formatMs(row.metrics.agentMs)}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap align-top tabular-nums text-slate-700"
                      title={
                        row.metrics.pauseSampleSize > 0
                          ? `${row.metrics.pauseSampleSize} measured pause${row.metrics.pauseSampleSize === 1 ? '' : 's'}`
                          : 'No user message recorded user_pause_ms'
                      }
                    >
                      {formatMs(row.metrics.pauseMs)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top font-mono text-xs text-slate-600">
                      {row.latestModel ?? '—'}
                    </TableCell>
                    <TableCell className="relative z-10 text-right align-top">
                      <Link className="text-sky-700 underline-offset-2 hover:underline" href={href}>
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
            aria-label="Conversations pagination"
            className="mt-8 flex flex-wrap items-center justify-center gap-2"
          >
            <Link
              className={`rounded-xl px-4 py-2 text-sm font-medium ${
                page === 1
                  ? 'pointer-events-none bg-slate-100 text-slate-400'
                  : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
              href={buildConversationsHref(route, filters, Math.max(1, page - 1))}
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
              href={buildConversationsHref(route, filters, page + 1)}
            >
              Next
            </Link>
          </nav>
        ) : null}
      </section>
    </>
  );
}
