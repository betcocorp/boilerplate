/**
 * B0-577 — Bex Health dashboard shell (epic B0-569).
 *
 * Server component, searchParams-driven like `/admin/observability` so the window is
 * linkable/bookmarkable. Thin by convention: composition only — every panel (and the header)
 * lives under `~/components/admin/bex-health/*`. Panels not yet built render as labelled
 * placeholder slots so the page's vertical order is already the final one.
 */

import { connection } from 'next/server';

import { HealthHeader } from '~/components/admin/bex-health/HealthHeader';
import { PanelPlaceholder } from '~/components/admin/bex-health/PanelPlaceholder';
import { TokensPerDayPanel } from '~/components/admin/bex-health/TokensPerDayPanel';
import { resolveHealthSearchParams } from '~/lib/bex-health/search-params';

export const metadata = {
  title: 'Bex health | Betco BEX',
  description:
    'Verdicts, traffic, pipeline and token health for the Bex product-support workflow.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminBexHealthPage({ searchParams }: PageProps) {
  await connection();
  const { window, version } = resolveHealthSearchParams(await searchParams);

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <HealthHeader version={version} window={window} />
        <PanelPlaceholder title="Verdict strip" />
        <PanelPlaceholder title="Tier cards" />
        <PanelPlaceholder title="Live traffic" />
        <PanelPlaceholder title="Pipeline strip" />
        <TokensPerDayPanel version={version} window={window} />
      </main>
    </div>
  );
}
