/**
 * B0-533 — admin conversation browser (epic B0-526 "Multi-Turn Conversation Observability").
 *
 * Server component; every filter is a searchParam so the list is linkable, mirroring
 * `/admin/observability`. Gated on `bex.chat.view-all` — the permission for seeing other users'
 * conversations (B0-447).
 */

import Link from 'next/link';
import { connection } from 'next/server';

import {
  ConversationsTable,
  type ConversationsTableFilters,
} from '~/components/admin/conversations/ConversationsTable';
import {
  listConversationsForAdmin,
  type ConversationListRow,
  type ConversationSourceFilter,
} from '~/lib/conversations/admin-conversation-browser';
import { resolveUserFilterInput } from '~/lib/observability/run-attribution';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { readSearchParam } from '~/lib/utils/params';

export const metadata = {
  title: 'Conversations | Betco BEX',
  description: 'Turn-by-turn browser for Bex conversations: routing, agent time vs pause time, tool calls, confidence.',
};

const ROUTE = '/admin/bex/conversations';
const PAGE_SIZE = 50;
/** Inclusive default window: today plus the previous 6 days (same as `/admin/observability`). */
const DEFAULT_WINDOW_DAYS = 7;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_MAX_CHARS = 200;
const SOURCE_FILTERS = new Set<ConversationSourceFilter>(['chat', 'test_run', 'all']);

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function readDay(value: string, fallback: string): string {
  return DAY_PATTERN.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    ? value
    : fallback;
}

/** Same PostgREST-metacharacter stripping as the observability search (B0-431). */
function normalizeSearchTerm(value: string): string {
  return value
    .trim()
    .slice(0, SEARCH_MAX_CHARS)
    .replaceAll(',', ' ')
    .replaceAll('%', '')
    .replaceAll('*', '')
    .replaceAll('(', '')
    .replaceAll(')', '')
    .trim();
}

export default async function AdminConversationsPage({ searchParams }: PageProps) {
  await requirePagePermission(PERMISSIONS.BEX_CHAT_VIEW_ALL, 'GET /admin/bex/conversations');
  await connection();
  const params = await searchParams;

  const now = new Date();
  const defaultTo = utcDay(now);
  const defaultFrom = utcDay(
    new Date(now.getTime() - (DEFAULT_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000),
  );
  const fromDay = readDay(readSearchParam(params.from), defaultFrom);
  const toDayRequested = readDay(readSearchParam(params.to), defaultTo);
  const toDay = toDayRequested < fromDay ? fromDay : toDayRequested;

  const sourceParam = readSearchParam(params.source).trim() as ConversationSourceFilter;
  const source: ConversationSourceFilter = SOURCE_FILTERS.has(sourceParam) ? sourceParam : 'chat';

  const search = normalizeSearchTerm(readSearchParam(params.q));

  const user = readSearchParam(params.user).trim().slice(0, SEARCH_MAX_CHARS);
  // An email that matches no `app_user` row resolves to null: the list must report "no match"
  // rather than silently dropping the filter and showing everyone's conversations.
  const resolvedUserId = user ? await resolveUserFilterInput(user) : undefined;
  const userFilterMatchedNothing = Boolean(user) && resolvedUserId === null;

  const minTurnsParsed = Number.parseInt(readSearchParam(params.minTurns), 10);
  const minTurns = Number.isFinite(minTurnsParsed) && minTurnsParsed > 0 ? minTurnsParsed : undefined;

  const requestedPage = Number.parseInt(readSearchParam(params.page, '1'), 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const filters: ConversationsTableFilters = {
    from: fromDay,
    to: toDay,
    source,
    user,
    search,
    minTurns: minTurns ? String(minTurns) : '',
  };

  let loadError: string | null = null;
  let rows: ConversationListRow[] = [];
  let total = 0;

  try {
    if (!userFilterMatchedNothing) {
      const result = await listConversationsForAdmin({
        source,
        from: `${fromDay}T00:00:00.000Z`,
        to: `${toDay}T23:59:59.999Z`,
        userId: resolvedUserId || undefined,
        search: search || undefined,
        minTurns,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      rows = result.rows;
      total = result.total;
    }
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : 'Unable to load conversations. If this persists, check the Supabase service-role configuration.';
  }

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Observability
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Conversations
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
            Every Bex conversation as a sequence of turns. Each row totals the time Bex spent
            answering against the time the user spent between replies; open one to see the routing
            decision, confidence and tool calls behind every turn, with a link to each run&apos;s
            full trace.
          </p>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
            Looking for a single run?{' '}
            <Link
              className="font-medium text-sky-700 underline-offset-2 hover:underline"
              href="/admin/observability"
            >
              Prompt observability
            </Link>{' '}
            lists workflow runs across every entry point.
          </p>
        </section>

        {loadError ? (
          <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            {loadError}
          </section>
        ) : null}

        <ConversationsTable
          filters={filters}
          page={page}
          pageSize={PAGE_SIZE}
          route={ROUTE}
          rows={rows}
          total={total}
        />
      </main>
    </div>
  );
}
