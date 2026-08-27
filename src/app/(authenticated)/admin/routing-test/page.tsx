import { connection } from 'next/server';

import { RoutingTestActionToast } from '~/components/admin/routing-test/RoutingTestActionToast';
import { RoutingTestRunCharts } from '~/components/admin/routing-test/RoutingTestRunCharts';
import { RoutingTestWorkbench } from '~/components/admin/routing-test/RoutingTestWorkbench';
import { ROUTING_TEST_PATH } from '~/lib/routing-test/constants';
import {
  listRoutingTestItems,
  listRoutingTestRuns,
} from '~/lib/routing-test/repository';
import { getRouterType } from '~/lib/settings/settings-service';

export const metadata = {
  title: 'Routing Test | Betco BEX',
  description:
    'Score a flat list of prompts against the keyword, semantic, or LLM SME router.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * B0-658/659/667 — the routing test surface. Deliberately single-purpose and much simpler than
 * `/admin/tests`: one flat list of prompt + expected agent (`public.routing_test_items`, B0-657),
 * one live run against the selected router (still ephemeral inline UX — re-running replaces the
 * result on this page), and a persisted run-history list below it (B0-667) written as a side
 * effect of that same run.
 */
export default async function AdminRoutingTestPage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;
  const success = typeof params.success === 'string' ? params.success : null;
  const error = typeof params.error === 'string' ? params.error : null;

  const [items, defaultRouterType, runs] = await Promise.all([
    listRoutingTestItems(),
    getRouterType(),
    listRoutingTestRuns(),
  ]);

  return (
    <div className="flex flex-1 bg-slate-50">
      <RoutingTestActionToast error={error} success={success} />
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold tracking-[0.2em] text-sky-700 uppercase">
            Routing test
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Check SME routing against expected agents
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
            One flat list of prompts, each tagged with the SME agent it should
            route to. Pick a router, hit Run, and every prompt is classified and
            scored against its expected agent. The result shown inline here is
            replaced by the next run, but every run is also saved to the history
            below.
          </p>
        </section>

        {/*
          B0-698 — router comparison charts over the same persisted runs the history table below
          renders. Omitted entirely with no runs; the run-history section owns that empty state.
        */}
        {runs.length > 0 ? <RoutingTestRunCharts runs={runs} /> : null}

        <RoutingTestWorkbench
          defaultRouterType={defaultRouterType}
          items={items}
          returnPath={ROUTING_TEST_PATH}
          runs={runs}
        />
      </main>
    </div>
  );
}
