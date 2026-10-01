/**
 * B0-629 — "Routing" panel of the `/admin` Mission Control dashboard.
 *
 * Async server component; presentation only. Every figure comes from
 * `~/lib/observability/routing-health.ts`, whose `rows` arrive pre-sorted, pre-labelled and
 * pre-shared — this file renders them verbatim and never re-sorts, re-labels or merges them.
 *
 * Three honesty rules the mockup did not encode, all verified against live data (2026-08-22):
 *
 *  1. **Low agreement is not a defect.** The mockup drew "100%"; the live figure is ~37%
 *     (842 disagree / 499 agree). B0-511 made the LLM classifier authoritative and left the
 *     keyword router as a retired baseline, so divergence is the router working. The caption
 *     says so, because a bare "37%" reads as a fault.
 *  2. **The agreement rate does not cover every run.** `llm_intent_classifier_live` gate records
 *     only exist from the 2026-08-18 cutover, so any window reaching earlier has
 *     `comparableCount` far below `totalRuns`. The sample is therefore printed next to the rate,
 *     and `comparableCount === 0` renders "No data" rather than a misleading `0%`.
 *  3. **Keyword fallbacks are excluded from the confidence mean.** `fallbackClassification`
 *     hard-codes `confidence: 0`, so counting those turns would fabricate zeros. The reader drops
 *     them; this panel prints the count so the exclusion is auditable instead of invisible.
 */

import {
  getRoutingHealthData,
  LOW_CONFIDENCE_THRESHOLD,
  type RoutingHealthRow,
} from '~/lib/observability/routing-health';

import type { HealthPanelProps } from '~/lib/bex-health/search-params';

import { EM_DASH, formatCount, formatRatePercent } from './format';

/**
 * B0-629 — hand-verified against `getRoutingHealthData` and the scans it composes; keep in sync
 * with them. Composed into the page's consolidated provenance footer, not rendered here.
 */
export const ROUTING_SOURCES = [
  'Route distribution: workflow_runs — final_output.routingDecision, final_output.confidence (admin-forced routes are NOT excluded; ~0.2% of runs, see buildRoutingHealthData)',
  'Router agreement + LLM confidence: workflow_steps.output.gates on the orchestration_planner step, gate llm_intent_classifier_live — records exist only from the 2026-08-18 B0-511 cutover',
  'Route labels: V1_AGENT_REGISTRY (~/lib/agents/agent-registry); ambiguous/unrouted are buckets, not agents',
];

/**
 * Agent fills cycle `--chart-1..5`. The two non-agent buckets are semantically different and must
 * read that way: `ambiguous` is a real classifier outcome ("gave up"), so it is destructive;
 * `unrouted` means no decision was ever recorded, so it is a neutral muted tone.
 */
const AGENT_FILL_CLASSES = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
] as const;
const AMBIGUOUS_FILL_CLASS = 'bg-destructive';
const UNROUTED_FILL_CLASS = 'bg-muted-foreground/40';

/** The one non-agent bucket that IS a decision; the reader's other bucket is `unrouted`. */
const AMBIGUOUS_ROUTE = 'ambiguous';

/** A non-zero share always paints a visible sliver, so a 0.1% route is not an empty track. */
const MIN_VISIBLE_BAR_PERCENT = 0.75;

function fillClass(row: RoutingHealthRow, agentIndex: number): string {
  if (row.isAgent) {
    return AGENT_FILL_CLASSES[agentIndex % AGENT_FILL_CLASSES.length];
  }
  return row.route === AMBIGUOUS_ROUTE ? AMBIGUOUS_FILL_CLASS : UNROUTED_FILL_CLASS;
}

function barPercent(share: number): number {
  if (share <= 0) return 0;
  return Math.max(share * 100, MIN_VISIBLE_BAR_PERCENT);
}

/**
 * One route. The bar is decorative and `aria-hidden` — the label plus the trailing
 * `count · share` carry the whole datum for screen readers and for a colourblind reader.
 */
function RouteBar({ row, agentIndex }: { row: RoutingHealthRow; agentIndex: number }) {
  return (
    <li className="flex items-center gap-3">
      <span
        className="w-48 shrink-0 truncate font-mono text-[11px] text-foreground xl:w-56"
        title={row.label}
      >
        {row.label}
      </span>
      <div aria-hidden className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${fillClass(row, agentIndex)}`}
          style={{ width: `${barPercent(row.share)}%` }}
        />
      </div>
      <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatCount(row.count)} · {formatRatePercent(row.share)}
      </span>
    </li>
  );
}

function FooterStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

export async function RoutingPanel({ window, version }: HealthPanelProps) {
  const data = await getRoutingHealthData(
    { from: window.from.toISOString(), to: window.to.toISOString() },
    version,
  );
  const { agreement } = data;

  // Palette index computed up front over agent rows ONLY, so the chart colours cycle across
  // specialists and the two non-agent buckets never consume one.
  let seenAgents = 0;
  const bars = data.rows.map((row) => ({
    row,
    agentIndex: row.isAgent ? seenAgents++ : 0,
  }));

  const agreementValue =
    agreement.comparableCount === 0 ? 'No data' : formatRatePercent(agreement.agreementRate);
  const meanConfidenceValue =
    agreement.meanLlmConfidence === null ? EM_DASH : agreement.meanLlmConfidence.toFixed(2);

  return (
    <section className="rounded-3xl border border-border/60 bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">Routing</h2>
        <p className="text-xs tabular-nums text-muted-foreground">
          {formatCount(data.totalRuns)} run{data.totalRuns === 1 ? '' : 's'} ·{' '}
          {data.windowFrom.slice(0, 10)} → {data.windowTo.slice(0, 10)}
        </p>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Which specialist the orchestrator sent each turn to, and whether the LLM router that made
        the call looks trustworthy.
      </p>

      {data.rows.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No runs recorded in this window, so there is no routing to show.
        </p>
      ) : (
        <ul className="mt-5 space-y-2">
          {bars.map((bar) => (
            <RouteBar agentIndex={bar.agentIndex} key={bar.row.route} row={bar.row} />
          ))}
        </ul>
      )}

      <div className="mt-6 grid gap-6 border-t border-border/60 pt-4 sm:grid-cols-2">
        <FooterStat
          detail={`keyword vs LLM · ${formatCount(agreement.comparableCount)} comparable of ${formatCount(data.totalRuns)} runs`}
          label="Router agreement"
          value={agreementValue}
        />
        <FooterStat
          detail={`${formatCount(agreement.lowConfidenceCount)} runs under ${LOW_CONFIDENCE_THRESHOLD.toFixed(2)} · n=${formatCount(agreement.llmConfidenceSampleSize)}`}
          label="Mean LLM confidence"
          value={meanConfidenceValue}
        />
      </div>

      <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
        Agreement compares the live LLM router against the <strong>retired keyword baseline</strong>
        . Since the B0-511 cutover the LLM classifier is authoritative, so divergence is expected
        behaviour rather than a failure — read this as drift from the old heuristic, not an error
        rate. Gate records begin at the cutover, which is why the comparable sample is smaller than
        the run count.
      </p>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
        {formatCount(agreement.fallbackCount)} keyword-fallback turn
        {agreement.fallbackCount === 1 ? '' : 's'} (LLM router disabled, timed out or errored) are
        excluded from the confidence mean, because that path records a fabricated confidence of 0.
      </p>
    </section>
  );
}
