'use client';

import { AlertTriangleIcon, PlayIcon } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { AddRoutingTestItemDialog } from '~/components/admin/routing-test/AddRoutingTestItemDialog';
import { RoutingTestItemsTable } from '~/components/admin/routing-test/RoutingTestItemsTable';
import { Button } from '~/components/ui/button';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/native-select';
import { Spinner } from '~/components/ui/spinner';
import { runRoutingTestAction } from '~/lib/routing-test/actions';
import { ROUTING_TEST_ROUTER_LABELS } from '~/lib/routing-test/constants';
import { formatRoutingTestAccuracy } from '~/lib/routing-test/scoring';
import type {
  RoutingTestItemRecord,
  RoutingTestItemResult,
  RoutingTestRouterType,
  RoutingTestRunResult,
} from '~/lib/routing-test/types';

type RoutingTestWorkbenchProps = {
  items: RoutingTestItemRecord[];
  returnPath: string;
  /** Current `ROUTER_TYPE` setting (B0-656) — the select's initial value. */
  defaultRouterType: RoutingTestRouterType;
};

const ROUTER_TYPES: RoutingTestRouterType[] = ['keyword', 'semantic'];

export function RoutingTestWorkbench({
  items,
  returnPath,
  defaultRouterType,
}: RoutingTestWorkbenchProps) {
  const [routerType, setRouterType] =
    useState<RoutingTestRouterType>(defaultRouterType);
  const [run, setRun] = useState<RoutingTestRunResult | null>(null);
  /**
   * B0-659 — capability check at RUNTIME, not a hardcoded `disabled`: the semantic option is only
   * marked unavailable after an actual run reported that the semantic router could not be used.
   */
  const [semanticUnavailable, setSemanticUnavailable] = useState<string | null>(
    null,
  );
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
      const result = await runRoutingTestAction(routerType);
      setRun(result);

      if (!result.ok) {
        if (result.routerType === 'semantic') {
          setSemanticUnavailable(result.error);
          setRouterType('keyword');
        }
        toast.error(result.error);
        return;
      }

      if (routerType === 'semantic') {
        setSemanticUnavailable(null);
      }
      toast.success(
        `${ROUTING_TEST_ROUTER_LABELS[result.routerType]} router — ${formatRoutingTestAccuracy(result.summary)}`,
      );
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2 sm:max-w-xs sm:flex-1">
            <Label htmlFor="routing-test-router-type">Router</Label>
            <NativeSelect
              id="routing-test-router-type"
              onChange={(event) =>
                setRouterType(event.target.value as RoutingTestRouterType)
              }
              value={routerType}
            >
              {ROUTER_TYPES.map((type) => (
                <option
                  disabled={type === 'semantic' && semanticUnavailable !== null}
                  key={type}
                  value={type}
                >
                  {ROUTING_TEST_ROUTER_LABELS[type]}
                  {type === 'semantic' && semanticUnavailable !== null
                    ? ' (unavailable)'
                    : ''}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-slate-500">
              Defaults to the current <code>ROUTER_TYPE</code> setting (
              {ROUTING_TEST_ROUTER_LABELS[defaultRouterType]}). Keyword routing
              is instant; semantic routing makes one embedding call per item and
              runs a few at a time.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {run?.ok ? (
              <p className="text-sm font-medium text-slate-900">
                {formatRoutingTestAccuracy(run.summary)}
              </p>
            ) : null}
            <Button
              disabled={isRunning || items.length === 0}
              onClick={handleRun}
              type="button"
            >
              {isRunning ? (
                <Spinner className="size-4" />
              ) : (
                <PlayIcon className="size-4" />
              )}
              {isRunning ? 'Running…' : 'Run'}
            </Button>
          </div>
        </div>

        {semanticUnavailable ? (
          <p className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              Semantic router unavailable: {semanticUnavailable} — reload once it
              is deployed to re-enable the option.
            </span>
          </p>
        ) : null}

        {run?.ok && run.warning ? (
          <p className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{run.warning}</span>
          </p>
        ) : null}

        {run?.ok && run.items.length > 0 ? (
          <p className="mt-4 text-xs text-slate-500">
            {ROUTING_TEST_ROUTER_LABELS[run.routerType]} router ·{' '}
            {new Date(run.ranAt).toLocaleString()} · results are not saved —
            re-running replaces them.
          </p>
        ) : null}
      </section>

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
          <AddRoutingTestItemDialog returnPath={returnPath} />
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
            <AddRoutingTestItemDialog returnPath={returnPath} />
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
