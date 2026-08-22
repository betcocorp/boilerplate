/**
 * B0-629 — the Mission Control "pipeline" panel: a denser five-column form of the Bex Health
 * stage strip (B0-582), with the median as the headline figure and a proportional stage-share bar
 * underneath.
 *
 * Async server component; presentation only. Every number comes from
 * `getPipelineStageStripData`, which composes the same aggregate functions
 * `/admin/observability` renders from, and the stage list is driven by `PIPELINE_STAGES` — no
 * stage name or `workflow_steps.step_name` is written out in this file, so remapping a stage there
 * needs no change here.
 *
 * THE STAGE-SHARE BAR IS NOT A WALL-CLOCK BREAKDOWN. Per the mapping documented at the top of
 * `~/lib/observability/pipeline-stages.ts`, `generate` is the whole `openai_responses_agent` tool
 * loop and therefore CONTAINS `retrieve`, and `gate` (`early_decline_gate`) is an alternative
 * terminal branch most runs never enter. The segments therefore overlap and do not partition a
 * run's duration; the bar shows each stage's share of the SUMMED STAGE MEDIANS, and the caption
 * says so rather than implying a decomposition.
 */

import {
  getPipelineStageStripData,
  PIPELINE_STAGES,
  type PipelineStageId,
  type PipelineStageStripData,
  type StageLatency,
} from '~/lib/observability/pipeline-stages';

import { EM_DASH, formatCount, formatMs, formatTokensPerRun } from './format';

import type { HealthPanelProps } from '~/lib/bex-health/search-params';

/**
 * Verified against `getPipelineStageStripData` and the aggregate scans it composes; keep in sync
 * with them (see `PIPELINE_STAGES` for the stage → step mapping). Rendered by the page's
 * consolidated provenance footer, not by this component.
 */
export const PIPELINE_PANEL_SOURCES = [
  'Stage timings (median/p95/n): workflow_steps (started_at → completed_at); Retrieve has NO step row — its timing and failed-call count come from audit_logs tool_called → tool_succeeded/tool_failed pairs',
  'Forced to review: review_tasks (distinct runs); validator skips/bypasses: workflow_steps.output.issues',
  'Stage footers (ambiguous routes, tokens/run, mean confidence): workflow_runs — final_output.routingDecision, final_output.usage, confidence',
  'Stage-share bar: shares of the SUMMED stage medians above — Generate contains Retrieve and Gate is an alternative branch, so the segments overlap and are not a wall-clock breakdown',
];

type FooterTone = 'neutral' | 'warning' | 'critical';

const FOOTER_TONE_STYLES: Record<FooterTone, string> = {
  neutral: 'text-muted-foreground',
  warning: 'text-amber-700 dark:text-amber-400',
  critical: 'text-destructive',
};

/** Token colour per stage, in `PIPELINE_STAGES` order. */
const STAGE_BAR_COLORS: Record<PipelineStageId, string> = {
  route: 'var(--color-chart-1)',
  retrieve: 'var(--color-chart-2)',
  generate: 'var(--color-chart-4)',
  validate: 'var(--color-chart-3)',
  gate: 'var(--color-chart-5)',
};

/**
 * One line of stage-specific footer text per stage, with a tone. The wording is lifted verbatim
 * from `PipelineStageStrip`'s `stageFooter` so the two surfaces phrase the same figure the same
 * way; only the tone is new.
 */
function stageFooter(
  id: PipelineStageId,
  data: PipelineStageStripData,
): { text: string; tone: FooterTone } {
  switch (id) {
    case 'route': {
      const count = data.route.ambiguousRouteCount;
      return {
        text: `${formatCount(count)} ambiguous route${count === 1 ? '' : 's'}`,
        tone: count > 0 ? 'warning' : 'neutral',
      };
    }
    case 'retrieve': {
      const count = data.retrieve.failedToolCallCount;
      return {
        text: `${formatCount(count)} failed tool call${count === 1 ? '' : 's'}`,
        tone: count > 0 ? 'critical' : 'neutral',
      };
    }
    case 'generate':
      return {
        text:
          data.generate.avgTotalTokens === null
            ? `${EM_DASH} tokens/run (no runs recorded usage)`
            : `${formatTokensPerRun(data.generate.avgTotalTokens)} (n=${formatCount(data.generate.tokenSampleSize)})`,
        tone: 'neutral',
      };
    case 'validate': {
      const count = data.validate.skippedOrBypassedCount;
      return {
        text: `${formatCount(count)} skipped or bypassed`,
        tone: count > 0 ? 'warning' : 'neutral',
      };
    }
    case 'gate': {
      const confidence =
        data.gate.meanFinalConfidence === null
          ? `${EM_DASH} mean confidence`
          : `${(data.gate.meanFinalConfidence * 100).toFixed(1)}% mean confidence`;
      return {
        text: `${confidence} · ${formatCount(data.gate.forcedToReviewCount)} forced to review`,
        tone: data.gate.forcedToReviewCount > 0 ? 'warning' : 'neutral',
      };
    }
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
  tinted,
}: {
  number: string;
  name: string;
  represents: string;
  latency: StageLatency;
  footer: { text: string; tone: FooterTone };
  tinted: boolean;
}) {
  return (
    <article
      className={[
        'flex min-w-0 flex-col rounded-2xl border border-border/60 p-3.5',
        tinted ? 'bg-primary/5' : 'bg-background',
      ].join(' ')}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        <span className="tabular-nums">{number}</span> {name}
      </p>
      {latency === null ? (
        // Never `0ms`: an unmeasured stage says so.
        <p className="mt-2 text-xl font-semibold text-muted-foreground">No samples</p>
      ) : (
        <>
          <p className="mt-2 text-xl font-semibold tabular-nums tracking-tight text-foreground">
            {formatMs(latency.p50DurationMs)}
          </p>
          <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
            p95 {formatMs(latency.p95DurationMs)} · n={formatCount(latency.sampleSize)}
          </p>
        </>
      )}
      <p
        className={[
          'mt-auto pt-2.5 text-[11px] leading-4 tabular-nums',
          FOOTER_TONE_STYLES[footer.tone],
        ].join(' ')}
      >
        {footer.text}
      </p>
      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/70" title={represents}>
        {represents}
      </p>
    </article>
  );
}

export async function PipelinePanel({ window, version }: HealthPanelProps) {
  const data = await getPipelineStageStripData(
    { from: window.from.toISOString(), to: window.to.toISOString() },
    version,
  );

  // Shares of summed medians. Stages with no samples (or a zero median) are skipped outright
  // rather than rendered as an unreadable sliver.
  const measured = PIPELINE_STAGES.map((stage) => ({
    stage,
    median: stageLatency(stage.id, data)?.p50DurationMs ?? 0,
  })).filter((entry) => entry.median > 0);
  const medianTotal = measured.reduce((sum, entry) => sum + entry.median, 0);
  const shares = measured.map((entry) => ({
    ...entry,
    share: medianTotal > 0 ? (entry.median / medianTotal) * 100 : 0,
  }));

  return (
    <section className="rounded-3xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">The pipeline</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Median and p95 time in each stage of a product-support run, from the same{' '}
            <code className="font-mono">workflow_steps</code> rows and tool-call audit pairs
            /admin/observability aggregates.
          </p>
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">
          {formatCount(data.totalRuns)} run{data.totalRuns === 1 ? '' : 's'} ·{' '}
          {data.windowFrom.slice(0, 10)} → {data.windowTo.slice(0, 10)}
        </p>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {PIPELINE_STAGES.map((stage) => (
          <StageBox
            footer={stageFooter(stage.id, data)}
            key={stage.id}
            latency={stageLatency(stage.id, data)}
            name={stage.name.toUpperCase()}
            number={stage.number}
            represents={stage.represents}
            tinted={stage.id === 'generate'}
          />
        ))}
      </div>

      <div className="mt-6">
        <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
          Share of summed stage medians
        </p>

        {shares.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No stage has a measured median in this window — nothing to apportion.
          </p>
        ) : (
          <>
            <div
              aria-hidden
              className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
            >
              {shares.map((entry) => (
                <div
                  key={entry.stage.id}
                  style={{
                    backgroundColor: STAGE_BAR_COLORS[entry.stage.id],
                    width: `${entry.share}%`,
                  }}
                />
              ))}
            </div>

            {/* Text equivalent — the bar is decorative, these figures are the content. */}
            <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
              {shares.map((entry) => (
                <li className="flex items-center gap-1.5" key={entry.stage.id}>
                  <span
                    aria-hidden
                    className="inline-block size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: STAGE_BAR_COLORS[entry.stage.id] }}
                  />
                  <span className="font-mono uppercase">{entry.stage.name}</span>
                  <span>
                    {entry.share.toFixed(1)}% · {formatMs(entry.median)} median
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="mt-2.5 text-[11px] leading-4 text-muted-foreground">
          Not a breakdown of wall-clock time. These are shares of the summed medians above, and the
          segments overlap: Generate is the whole tool loop, so it CONTAINS Retrieve. Gate is an
          alternative terminal branch that most runs never enter, so its share reflects only the
          runs that did.
        </p>
      </div>
    </section>
  );
}
