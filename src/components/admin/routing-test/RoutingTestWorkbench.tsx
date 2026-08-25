'use client';

import { AlertTriangleIcon } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { AddRoutingTestItemDialog } from '~/components/admin/routing-test/AddRoutingTestItemDialog';
import { RoutingTestItemsTable } from '~/components/admin/routing-test/RoutingTestItemsTable';
import { RoutingTestRunHistory } from '~/components/admin/routing-test/RoutingTestRunHistory';
import { MODEL_DESCRIPTIONS, type ExplicitBexModelTag } from '~/lib/constants/models';
import { runRoutingTestAction } from '~/lib/routing-test/actions';
import {
  ROUTING_TEST_ROUTER_LABELS,
} from '~/lib/routing-test/constants';
import { formatRoutingTestAccuracy } from '~/lib/routing-test/scoring';
import type {
  RoutingTestItemRecord,
  RoutingTestItemResult,
  RoutingTestRouterType,
  RoutingTestRunResult,
  RoutingTestRunRecord,
} from '~/lib/routing-test/types';

/** B0-671 — default selection for the LLM router's model picker; mirrors `TestRunModelControls`. */
const DEFAULT_ROUTING_TEST_MODEL_TAG: ExplicitBexModelTag = 'gpt-4.1-mini';

type RoutingTestWorkbenchProps = {
  items: RoutingTestItemRecord[];
  runs: RoutingTestRunRecord[];
  returnPath: string;
  /** Current `ROUTER_TYPE` setting (B0-656) — the select's initial value. */
  defaultRouterType: RoutingTestRouterType;
};

/** Router types that can report themselves unavailable at runtime (every non-keyword router). */
type DegradableRouterType = Exclude<RoutingTestRouterType, 'keyword'>;

function isDegradableRouterType(value: RoutingTestRouterType): value is DegradableRouterType {
  return value !== 'keyword';
}

export function RoutingTestWorkbench({
  items,
  runs,
  returnPath,
  defaultRouterType,
}: RoutingTestWorkbenchProps) {
  const [routerType, setRouterType] =
    useState<RoutingTestRouterType>(defaultRouterType);
  /** B0-671 — only consulted (and only sent to `runRoutingTestAction`) when `routerType === 'llm'`. */
  const [modelTag, setModelTag] = useState<ExplicitBexModelTag>(
    DEFAULT_ROUTING_TEST_MODEL_TAG,
  );
  const [run, setRun] = useState<RoutingTestRunResult | null>(null);
  /**
   * B0-659/B0-666 — capability check at RUNTIME, not a hardcoded `disabled`: a router is only
   * marked unavailable after an actual run reported it could not be used. Keyed per router type
   * (rather than one shared flag) so semantic and llm degrade independently.
   */
  const [unavailableByRouter, setUnavailableByRouter] = useState<
    Partial<Record<DegradableRouterType, string>>
  >({});
  const [isRunning, startRun] = useTransition();

  const resultsByItemId = useMemo(() => {
    if (!run?.ok) {
      return {};
    }
    return run.items.reduce<Record<string, RoutingTestItemResult>>(
      (accumulator, result) => {
        accumulator[result.itemId] = result;
        return accumulator;
      },
      {},
    );
  }, [run]);

  function handleRun() {
    startRun(async () => {
      // Re-running REPLACES the prior result; nothing is persisted (ephemeral by design).
      // B0-671 — the model tag is only relevant (and only sent) for the LLM router.
      const result = await runRoutingTestAction(
        routerType,
        routerType === 'llm' ? modelTag : undefined,
      );
      setRun(result);

      if (!result.ok) {
        if (isDegradableRouterType(result.routerType)) {
          setUnavailableByRouter((prev) => ({
            ...prev,
            [result.routerType as DegradableRouterType]: result.error,
          }));
          setRouterType('keyword');
        }
        toast.error(result.error);
        return;
      }

      if (isDegradableRouterType(routerType)) {
        setUnavailableByRouter((prev) => {
          const next = { ...prev };
          delete next[routerType];
          return next;
        });
      }
      toast.success(
        `${ROUTING_TEST_ROUTER_LABELS[result.routerType]} router${result.model ? ` (${result.model})` : ''} — ${formatRoutingTestAccuracy(result.summary)}`,
      );
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-col gap-1">
          <p className="text-xs text-slate-500">
            Defaults to the current <code>ROUTER_TYPE</code> setting (
            {ROUTING_TEST_ROUTER_LABELS[defaultRouterType]}). Keyword routing
            is instant; semantic and LLM routing each make one call per item
            and run a few at a time.
          </p>
          {routerType === 'llm' ? (
            <p className="text-xs text-slate-500">
              {MODEL_DESCRIPTIONS[modelTag]}
            </p>
          ) : null}
        </div>

        {(
          Object.entries(unavailableByRouter) as [
            DegradableRouterType,
            string,
          ][]
        ).map(([type, reason]) => (
          <p
            className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800"
            key={type}
          >
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              {ROUTING_TEST_ROUTER_LABELS[type]} router unavailable: {reason} —
              reload once it is deployed to re-enable the option.
            </span>
          </p>
        ))}

        {run?.ok && run.warning ? (
          <p className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{run.warning}</span>
          </p>
        ) : null}

        {run?.ok && run.items.length > 0 ? (
          <p className="text-xs text-slate-500">
            {ROUTING_TEST_ROUTER_LABELS[run.routerType]} router ·{' '}
            {new Date(run.ranAt).toLocaleString()} · this inline result is
            replaced by the next run, but has also been saved — reload to see
            it in the run history below.
          </p>
        ) : null}
      </section>

      <RoutingTestRunHistory
        runs={runs}
        routerType={routerType}
        onRouterTypeChange={setRouterType}
        modelTag={modelTag}
        onModelTagChange={setModelTag}
        onRun={handleRun}
        isRunning={isRunning}
        run={run}
        unavailableByRouter={unavailableByRouter}
        items={items}
      />

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-slate-900">
              Routing test items
            </h2>
            <p className="text-sm text-slate-600">
              {items.length} {items.length === 1 ? 'item' : 'items'}
            </p>
          </div>
          <AddRoutingTestItemDialog />
        </div>

        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center">
            <p className="text-sm font-medium text-slate-900">
              No routing test items yet
            </p>
            <p className="max-w-md text-sm text-slate-600">
              Add a prompt and the SME agent it should route to, then use Run to
              check the selected router against every item.
            </p>
            <AddRoutingTestItemDialog />
          </div>
        ) : (
          <RoutingTestItemsTable
            items={items}
            resultsByItemId={resultsByItemId}
            returnPath={returnPath}
          />
        )}
      </section>
    </div>
  );
}
