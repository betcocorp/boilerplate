/**
 * B0-629 — `/admin` Mission Control dashboard.
 *
 * Replaces the previous landing page, which rendered shadcn demo boilerplate (hardcoded document
 * rows, invented reviewer names, dead "Quick Create" / Outline controls) around two real metrics.
 *
 * Server component, searchParams-driven like `/admin/bex/health` and `/admin/observability`, so
 * the window AND version selection are linkable and a pasted URL fully determines the view. Thin
 * by convention: composition only — every panel, and the filter row, lives under
 * `~/components/admin/dashboard/*` and fetches its own data from a canonical reader.
 *
 * The window default is `resolveHealthSearchParams`' own 7 days rather than the mockup's
 * "Last 24 hours": golden-set sweeps are started by hand from /admin/tests rather than nightly, so
 * a one-day landing window would leave the health bar's gate verdict — the page's headline — empty
 * on most days. Sharing the health page's default also means the two surfaces reconcile.
 *
 * The previous page's permissions shortcut card is gone with the rest of the layout. That is not an
 * access-control change: `admin.card.permissions` still gates the account menu's Access control
 * entry (`AdminAccountMenu`), the sidebar (`AdminSidebarNav`), every `/api/admin/permissions` route
 * and the permissions pages themselves — the card was the one checkpoint that only decorated.
 */

import { connection } from 'next/server';

import { AdminAccessDeniedToast } from '~/components/admin/AdminAccessDeniedToast';
import { DashboardHeader } from '~/components/admin/dashboard/DashboardHeader';
import { HealthBar } from '~/components/admin/dashboard/HealthBar';
import { KpiRow } from '~/components/admin/dashboard/KpiRow';
import { PipelinePanel } from '~/components/admin/dashboard/PipelinePanel';
import { ReportScoreTrendPanel } from '~/components/admin/dashboard/ReportScoreTrendPanel';
import { RoutingPanel } from '~/components/admin/dashboard/RoutingPanel';
import { ToolHealthPanel } from '~/components/admin/dashboard/ToolHealthPanel';
import { resolveHealthSearchParams } from '~/lib/bex-health/search-params';

export const metadata = {
  title: 'Mission Control | Betco BEX',
  description:
    'Gate verdict, traffic, pipeline, routing and tool health for the Bex product-support workflow.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminDashboardPage({ searchParams }: PageProps) {
  await connection();
  const resolvedSearchParams = await searchParams;
  const { window, version } = resolveHealthSearchParams(resolvedSearchParams);
  // B0-839 — redirect target for `requirePagePermission`'s it-admin-only page guard.
  const accessDenied = resolvedSearchParams.accessDenied === '1';

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-5 p-4 sm:p-6">
      <AdminAccessDeniedToast show={accessDenied} />
      <HealthBar version={version} window={window} />

      <DashboardHeader version={version} window={window} />
      <ReportScoreTrendPanel version={version} window={window} />
      <KpiRow version={version} window={window} />
      <PipelinePanel version={version} window={window} />

      {/* Routing and Tool health are peers: side by side on wide screens, stacked below. */}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <RoutingPanel version={version} window={window} />
        <ToolHealthPanel version={version} window={window} />
      </div>
    </main>
  );
}
