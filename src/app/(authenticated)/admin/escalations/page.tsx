/**
 * B0-528 — `/admin/escalations`: the durable records the `escalation_specialist` tool writes when
 * Bex cannot answer from approved documents (epic B0-525). Server component; filters are
 * searchParams-driven so the page is linkable, mirroring `/admin/observability`.
 */

import { connection } from 'next/server';

import { EscalationsTable } from '~/components/admin/escalations/EscalationsTable';
import {
  ESCALATION_STATUSES,
  listEscalations,
  type EscalationRow,
  type EscalationStatus,
} from '~/lib/escalations/escalation-repository';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { readSearchParam } from '~/lib/utils/params';

export const metadata = {
  title: 'Escalations | Betco BEX',
  description: 'Questions Bex could not answer, logged for the Betco team to follow up.',
};

const ROUTE = '/admin/escalations';
const PAGE_SIZE = 50;
/** `all` is the only non-status value the filter accepts; the default is `open`. */
const DEFAULT_STATUS_FILTER = 'open';

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminEscalationsPage({ searchParams }: PageProps) {
  await requirePagePermission(PERMISSIONS.NAVIGATION_SIDEBAR_OBSERVABILITY, `GET ${ROUTE}`);
  await connection();
  const params = await searchParams;

  const statusParam = readSearchParam(params.status, DEFAULT_STATUS_FILTER).trim();
  const statusFilter: EscalationStatus | 'all' =
    statusParam === 'all'
      ? 'all'
      : (ESCALATION_STATUSES as readonly string[]).includes(statusParam)
        ? (statusParam as EscalationStatus)
        : DEFAULT_STATUS_FILTER;

  const requestedPage = Number.parseInt(readSearchParam(params.page, '1'), 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  let loadError: string | null = null;
  let rows: EscalationRow[] = [];
  let hasMore = false;
  try {
    const result = await listEscalations({
      status: statusFilter === 'all' ? undefined : statusFilter,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    rows = result.rows;
    hasMore = result.hasMore;
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : 'Unable to load escalations. If this persists, check the Supabase service-role configuration.';
  }

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Observability
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Escalations
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
            Every time Bex told a user it had no verified answer and logged an escalation, the
            record lands here with the reference the user was given (for example{' '}
            <code>ESC-0042</code>), the question, and why the specialist could not answer. Work the
            open queue by setting a status; notes are kept with the record. The tool only runs while
            the <code>BEX_ESCALATION_TOOL_ENABLED</code> setting is on.
          </p>
        </section>

        {loadError ? (
          <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            {loadError}
          </section>
        ) : null}

        <EscalationsTable
          hasMore={hasMore}
          page={page}
          route={ROUTE}
          rows={rows}
          statusFilter={statusFilter}
        />
      </main>
    </div>
  );
}
