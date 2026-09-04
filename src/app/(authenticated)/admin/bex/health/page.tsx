/**
 * B0-577 / B0-578 / B0-579 / B0-580 — Bex Health dashboard (epic B0-569).
 *
 * Server component, searchParams-driven like `/admin/observability` so the window AND version
 * selection are linkable/bookmarkable — the URL fully determines the view. Thin by convention:
 * composition only — every panel (and the header with its selectors) lives under
 * `~/components/admin/bex-health/*`.
 */

import { connection } from 'next/server';

import { HealthHeader } from '~/components/admin/bex-health/HealthHeader';
import { LiveTrafficCard } from '~/components/admin/bex-health/LiveTrafficCard';
import { PipelineStageStrip } from '~/components/admin/bex-health/PipelineStageStrip';
import { TierCards } from '~/components/admin/bex-health/TierCards';
import { TokensPerDayPanel } from '~/components/admin/bex-health/TokensPerDayPanel';
import { VerdictStrip } from '~/components/admin/bex-health/VerdictStrip';
import { resolveHealthSearchParams } from '~/lib/bex-health/search-params';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

export const metadata = {
  title: 'Bex health | Betco BEX',
  description:
    'Verdicts, traffic, pipeline and token health for the Bex product-support workflow.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminBexHealthPage({ searchParams }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_OBSERVABILITY,
    'GET /admin/bex/health',
  );
  await connection();
  const { window, version } = resolveHealthSearchParams(await searchParams);

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <HealthHeader version={version} window={window} />
        <VerdictStrip version={version} window={window} />
        <TierCards version={version} window={window} />
        <LiveTrafficCard version={version} window={window} />
        <PipelineStageStrip version={version} window={window} />
        <TokensPerDayPanel version={version} window={window} />
      </main>
    </div>
  );
}
