/**
 * B0-582 — "The pipeline" stage strip for the Bex Health dashboard: five connected
 * stage boxes (route → retrieve → generate → validate → gate) that make the workflow
 * itself the layout.
 *
 * Async server component; presentation only. Every number comes from
 * `~/lib/observability/pipeline-stages.ts`, which composes the same aggregate
 * functions `/admin/observability` renders from, so the two surfaces reconcile.
 */

import { ArrowRightIcon } from 'lucide-react';

import {
  getPipelineStageStripData,
  PIPELINE_STAGES,
  type PipelineStageId,
  type PipelineStageStripData,
  type StageLatency,
} from '~/lib/observability/pipeline-stages';

/** Shared props contract for all Bex Health panels (wave 2 wires real values). */
export type HealthPanelProps = {
  window: { from: Date; to: Date };
  /** Null = all traffic; the string "unversioned" selects runs with NULL `app_version`. */
  version: string | null;
};

const EM_DASH = '—';

function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** One line of stage-specific footer text per stage, from the reader's figures. */
function stageFooter(id: PipelineStageId, data: PipelineStageStripData): string {
  switch (id) {
    case 'route':
      return `${formatCount(data.route.ambiguousRouteCount)} ambiguous route${data.route.ambiguousRouteCount === 1 ? '' : 's'}`;
    case 'retrieve':
      return `${formatCount(data.retrieve.failedToolCallCount)} failed tool call${data.retrieve.failedToolCallCount === 1 ? '' : 's'}`;
    case 'generate':
      return data.generate.avgTotalTokens === null
        ? `${EM_DASH} tokens/run (no runs recorded usage)`
        : `${formatCount(data.generate.avgTotalTokens)} tokens/run (n=${formatCount(data.generate.tokenSampleSize)})`;
    case 'validate':
      return `${formatCount(data.validate.skippedOrBypassedCount)} skipped or bypassed`;
    case 'gate':
      return `${
        data.gate.meanFinalConfidence === null
          ? `${EM_DASH} mean confidence`
          : `${(data.gate.meanFinalConfidence * 100).toFixed(1)}% mean confidence`
      } · ${formatCount(data.gate.forcedToReviewCount)} forced to review`;
  }
}

function stageLatency(id: PipelineStageId, data: PipelineStageStripData): StageLatency {
  return data[id].latency;
}

function StageBox({
  number,
  name,
  represents,
  latency,
  footer,
}: {
  number: string;
  name: string;
  represents: string;
  latency: StageLatency;
  footer: string;
}) {
  return (
    <article className="flex min-w-0 flex-1 flex-col rounded-2xl border border-slate-200 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        <span className="tabular-nums text-slate-400">{number}</span> {name}
      </p>
      <p className="mt-1 truncate font-mono text-[11px] text-slate-400" title={represents}>
        {represents}
      </p>
      {latency === null ? (
        <p className="mt-3 text-lg font-semibold text-slate-400">No samples</p>
      ) : (
        <>
          <p className="mt-3 text-2xl font-semibold tabular-nums text-slate-950">
            {formatMs(latency.avgDurationMs)}
          </p>
          <p className="mt-1 text-xs tabular-nums text-slate-500">
            p95 {formatMs(latency.p95DurationMs)} · n={formatCount(latency.sampleSize)}
          </p>
        </>
      )}
      <p className="mt-auto border-t border-slate-100 pt-3 text-xs text-slate-600">
        {footer}
      </p>
    </article>
  );
}

export async function PipelineStageStrip({ window, version }: HealthPanelProps) {
  const data = await getPipelineStageStripData(
    { from: window.from.toISOString(), to: window.to.toISOString() },
    version,
  );

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">The pipeline</h2>
        <p className="text-xs tabular-nums text-slate-500">
          {formatCount(data.totalRuns)} run{data.totalRuns === 1 ? '' : 's'} ·{' '}
          {data.windowFrom.slice(0, 10)} → {data.windowTo.slice(0, 10)}
        </p>
      </div>

      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-stretch">
        {PIPELINE_STAGES.map((stage, index) => (
          <div className="contents" key={stage.id}>
            {index > 0 ? (
              <div className="hidden shrink-0 items-center lg:flex" aria-hidden>
                <ArrowRightIcon className="size-4 text-slate-300" />
              </div>
            ) : null}
            <StageBox
              footer={stageFooter(stage.id, data)}
              latency={stageLatency(stage.id, data)}
              name={stage.name}
              number={stage.number}
              represents={stage.represents}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
