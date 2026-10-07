'use client';

import Link from 'next/link';
import { PlayIcon } from 'lucide-react';

import { Button } from '~/components/ui/button';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { DeleteRoutingTestRunDialog } from '~/components/admin/routing-test/DeleteRoutingTestRunDialog';
import supportedModels, {
  type ExplicitBexModelTag,
  type SupportedModel,
} from '~/lib/constants/models';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  ROUTING_TEST_ACCURACY_TONE_CLASSES,
  ROUTING_TEST_ROUTER_LABELS,
} from '~/lib/routing-test/constants';
import {
  formatRoutingTestAccuracy,
  formatRoutingTestRunScore,
  routingTestAccuracyTone,
} from '~/lib/routing-test/scoring';
import type {
  RoutingTestRouterType,
  RoutingTestRunRecord,
  RoutingTestRunResult,
} from '~/lib/routing-test/types';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';

const ROUTER_TYPES: RoutingTestRouterType[] = ['keyword', 'semantic', 'llm'];

type RoutingTestRunHistoryProps = {
  runs: RoutingTestRunRecord[];
  routerType: RoutingTestRouterType;
  onRouterTypeChange: (type: RoutingTestRouterType) => void;
  modelTag: ExplicitBexModelTag;
  onModelTagChange: (tag: ExplicitBexModelTag) => void;
  onRun: () => void;
  isRunning: boolean;
  run: RoutingTestRunResult | null;
  unavailableByRouter: Partial<Record<Exclude<RoutingTestRouterType, 'keyword'>, string>>;
  items: { length: number };
};

/**
 * B0-667 — persisted run history, newest first. Every "Run" click on `RoutingTestWorkbench` writes
 * one `routing_test_runs` row here as a side effect of `runRoutingTestAction`; this table is a
 * plain server-rendered list with no client state of its own — each row links to the per-item
 * drill-down at `/admin/routing-test/runs/[runId]`.
 *
 * B0-677 — controls (router, model, run button) are now integrated into the run history header.
 */
export function RoutingTestRunHistory({
  runs,
  routerType,
  onRouterTypeChange,
  modelTag,
  onModelTagChange,
  onRun,
  isRunning,
  run,
  unavailableByRouter,
  items,
}: RoutingTestRunHistoryProps) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-slate-900">Run history</h2>
          <p className="text-sm text-slate-600">
            {runs.length} {runs.length === 1 ? 'run' : 'runs'} recorded
          </p>
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-3">
          <div className="flex flex-col gap-2 sm:max-w-xs">
            <Label htmlFor="routing-test-router-type" className="sr-only">
              Router
            </Label>
            <Select
              onValueChange={(v) => onRouterTypeChange(v as RoutingTestRouterType)}
              value={routerType}
            >
              <SelectTrigger className="min-w-32" id="routing-test-router-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROUTER_TYPES.map((type) => {
                  const unavailable = type !== 'keyword' && unavailableByRouter[type] !== undefined;
                  return (
                    <SelectItem disabled={unavailable} key={type} value={type}>
                      {ROUTING_TEST_ROUTER_LABELS[type]}
                      {unavailable ? ' (unavailable)' : ''}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {routerType === 'llm' ? (
            <div className="flex flex-col gap-2 sm:max-w-xs">
              <Label htmlFor="routing-test-model-tag" className="sr-only">
                Model
              </Label>
              <Select
                onValueChange={(v) => onModelTagChange(v as ExplicitBexModelTag)}
                value={modelTag}
              >
                <SelectTrigger className="min-w-32" id="routing-test-model-tag">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {supportedModels.map((m: SupportedModel) => (
                    <SelectItem key={m.name} value={m.name}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            {run?.ok && run.summary ? (
              <p
                className={`text-sm font-medium ${ROUTING_TEST_ACCURACY_TONE_CLASSES[routingTestAccuracyTone(run.summary.accuracy)]}`}
              >
                {formatRoutingTestAccuracy(run.summary)}
              </p>
            ) : null}
            <Button
              disabled={isRunning || items.length === 0}
              onClick={onRun}
              type="button"
              size="sm"
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
      </div>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center">
          <p className="text-sm font-medium text-slate-900">No runs yet</p>
          <p className="max-w-md text-sm text-slate-600">
            Every Run above is saved here automatically — hit Run on the
            workbench to start your first history entry.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ran at</TableHead>
                <TableHead>Router</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Avg item</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                // B0-670 — same 0-1 accuracy fraction `routingTestAccuracyTone` expects; derived
                // from the persisted counts since `RoutingTestRunRecord` has no `accuracy` field.
                const accuracy = run.total_items === 0 ? 0 : run.passed_items / run.total_items;
                return (
                <TableRow key={run.id}>
                  <TableCell className="text-sm text-slate-800">
                    <Link
                      className="text-sky-700 underline-offset-2 hover:underline"
                      href={`/admin/routing-test/runs/${run.id}`}
                    >
                      {formatDate(run.ran_at)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-slate-800">
                    {ROUTING_TEST_ROUTER_LABELS[run.router_type]}
                    {/* B0-671 — which model an `llm` run actually called, straight off the persisted column. */}
                    {run.router_type === 'llm' && run.model ? (
                      <span className="ml-1 text-xs text-slate-500">({run.model})</span>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className={`text-sm font-medium ${ROUTING_TEST_ACCURACY_TONE_CLASSES[routingTestAccuracyTone(accuracy)]}`}
                  >
                    {formatRoutingTestRunScore(run.passed_items, run.total_items)}
                  </TableCell>
                  <TableCell className="text-sm text-slate-700">
                    {formatDurationSeconds(run.duration_ms)}
                  </TableCell>
                  <TableCell className="text-sm text-slate-700">
                    {run.avg_item_duration_ms !== null
                      ? `${Math.round(run.avg_item_duration_ms)}ms`
                      : '—'}
                  </TableCell>
                  <TableCell className="flex items-center justify-end gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/admin/routing-test/runs/${run.id}`}>
                        View
                      </Link>
                    </Button>
                    <DeleteRoutingTestRunDialog
                      run={run}
                      returnPath="/admin/routing-test"
                    />
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
