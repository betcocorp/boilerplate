/**
 * B0-629 — the Routing panel of the `/admin` Mission Control dashboard.
 *
 * Two questions, one window:
 *  1. Where did the orchestrator send traffic? (`rows` — the horizontal bar chart)
 *  2. Is the LLM router trustworthy? (`agreement` — live keyword-vs-LLM agreement and the
 *     classifier's own mean confidence)
 *
 * Read-only and folded in Node, for the same reason documented at the top of
 * `~/lib/observability/aggregates.ts`. `buildRoutingHealthData` is pure so the correctness
 * traps below are unit-testable without a database; only `getRoutingHealthData` does I/O.
 */

import { SME_AGENT_IDS, V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import {
  type AggregateWindow,
  buildRoutingDistribution,
  type RunScanRow,
  roundTo,
  scanWorkflowRuns,
  scanWorkflowStepOutputsByName,
  type VersionFilter,
} from '~/lib/observability/aggregates';
import { readStepGateRecords } from '~/lib/workflows/product-support/product-support-schemas';

/**
 * A classifier confidence under this is "the router guessed". Deliberately the same 0.4 the
 * regulated-claim clamp uses in `run-product-support-workflow.ts`, so "low confidence" means
 * one thing across the admin surfaces.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

/**
 * The step and gate that record a LIVE routing decision. Confirmed against the live DB
 * (2026-08-22): 1,348 `llm_intent_classifier_live` records exist on `orchestration_planner`
 * step rows, first seen 2026-08-18 (the B0-511 cutover) — so this stat is only populated for
 * traffic after that date, and a longer window will show a `comparableCount` well below
 * `totalRuns`. The shadow-mode predecessor (`llm_intent_classifier_shadow`) is deliberately
 * NOT read: it recorded what the classifier *would* have done, not what routed the turn.
 */
const PLANNER_STEP_NAME = 'orchestration_planner';
const LIVE_CLASSIFIER_GATE_ID = 'llm_intent_classifier_live';

/** `gateRecordSchema.verdict` is a free string; these are the two the live gate writes. */
const AGREES_VERDICT = 'agrees_with_keyword_router';
const DISAGREES_VERDICT = 'disagrees_with_keyword_router';

/**
 * `inputs.classifierSource`. Only `'llm'` rows may feed the confidence mean:
 * `fallbackClassification` (`~/lib/orchestrator/intent-classifier.ts`) hard-codes
 * `confidence: 0` whenever the LLM router is disabled, times out or errors, so counting
 * `keyword_fallback` rows would fabricate zeros into both the mean and the low-confidence
 * count. They are reported separately as `fallbackCount` instead.
 */
const LLM_SOURCE = 'llm';
const KEYWORD_FALLBACK_SOURCE = 'keyword_fallback';

/** Buckets used by `buildRoutingDistribution`, neither of which is an SME agent. */
const AMBIGUOUS_ROUTE = 'ambiguous';
const UNROUTED_ROUTE = 'unrouted';

const AGENT_LABELS = new Map<string, string>(
  V1_AGENT_REGISTRY.map((agent) => [agent.id, agent.label]),
);
const AGENT_IDS = new Set<string>(SME_AGENT_IDS);

export type RoutingHealthRow = {
  /** `SmeAgentId | 'ambiguous' | 'unrouted'` — or any other literal a historical run persisted. */
  route: string;
  label: string;
  isAgent: boolean;
  count: number;
  /** Share of `totalRuns`, 0..1. */
  share: number;
  avgConfidence: number | null;
};

export type RouterAgreementSummary = {
  /** LLM-sourced live-gate records carrying one of the two agreement verdicts. */
  comparableCount: number;
  agreementCount: number;
  /** `null` when nothing was comparable — never 0, which would read as "the router never agrees". */
  agreementRate: number | null;
  /** Mean `inputs.classifierConfidence` over `classifierSource === 'llm'` records ONLY. */
  meanLlmConfidence: number | null;
  llmConfidenceSampleSize: number;
  lowConfidenceCount: number;
  fallbackCount: number;
};

export type RoutingHealthData = {
  windowFrom: string;
  windowTo: string;
  totalRuns: number;
  /** Desc by count. `'ambiguous'` (a real classifier outcome) and `'unrouted'` (no decision recorded) stay distinct. */
  rows: RoutingHealthRow[];
  agreement: RouterAgreementSummary;
};

/** One `orchestration_planner` step row: the shape `scanWorkflowStepOutputsByName` returns. */
export type RoutingPlannerScanRow = { workflow_run_id: string; output: unknown };

function labelForRoute(route: string): string {
  if (route === AMBIGUOUS_ROUTE) {
    return 'Ambiguous (no specialist)';
  }
  if (route === UNROUTED_ROUTE) {
    return 'No decision recorded';
  }
  // Falls back to the raw value so a route persisted by an older build is still visible.
  return AGENT_LABELS.get(route) ?? route;
}

/** `inputs` is `Record<string, unknown>` by schema, so every read narrows rather than dots into `any`. */
function readString(inputs: Record<string, unknown>, key: string): string | null {
  const value = inputs[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A confidence must be a finite 0..1 number to count; anything else is absent, not zero. */
function readConfidence(inputs: Record<string, unknown>): number | null {
  const value = inputs.classifierConfidence;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

/**
 * Live keyword-vs-LLM agreement plus classifier confidence, over the live-gate records on the
 * scanned planner steps.
 *
 * Counted per GATE RECORD, not per run: one record is one classification event, and a run with
 * two planner steps genuinely classified twice. `readStepGateRecords` already degrades an
 * unparseable/absent `output` to `[]`, so a malformed row contributes nothing and never throws.
 */
function buildRouterAgreement(plannerSteps: RoutingPlannerScanRow[]): RouterAgreementSummary {
  let comparableCount = 0;
  let agreementCount = 0;
  let confidenceSum = 0;
  let llmConfidenceSampleSize = 0;
  let lowConfidenceCount = 0;
  let fallbackCount = 0;

  for (const step of plannerSteps) {
    for (const record of readStepGateRecords(step.output)) {
      if (record.gate !== LIVE_CLASSIFIER_GATE_ID) {
        continue;
      }

      const source = readString(record.inputs, 'classifierSource');

      if (source === KEYWORD_FALLBACK_SOURCE) {
        fallbackCount += 1;
        // Degraded routing: no comparison, and its confidence is a fabricated 0. Nothing else to do.
        continue;
      }

      if (source !== LLM_SOURCE) {
        // Unknown/absent source — cannot be attributed, so it is not comparable either way.
        continue;
      }

      if (record.verdict === AGREES_VERDICT || record.verdict === DISAGREES_VERDICT) {
        comparableCount += 1;
        if (record.verdict === AGREES_VERDICT) {
          agreementCount += 1;
        }
      }

      const confidence = readConfidence(record.inputs);
      if (confidence !== null) {
        confidenceSum += confidence;
        llmConfidenceSampleSize += 1;
        if (confidence < LOW_CONFIDENCE_THRESHOLD) {
          lowConfidenceCount += 1;
        }
      }
    }
  }

  return {
    comparableCount,
    agreementCount,
    agreementRate: comparableCount > 0 ? roundTo(agreementCount / comparableCount, 4) : null,
    meanLlmConfidence:
      llmConfidenceSampleSize > 0 ? roundTo(confidenceSum / llmConfidenceSampleSize, 4) : null,
    llmConfidenceSampleSize,
    lowConfidenceCount,
    fallbackCount,
  };
}

/**
 * Pure reducer — no I/O, so every trap above is unit-testable. Mirrors
 * `buildRoutingDistribution` / `buildPipelineStageStripData`.
 *
 * KNOWN CONTAMINATION (documented, not silently fixed): `final_output.routingDecision` also
 * holds a FORCED `agentMode` when an admin bypasses the router
 * (`run-product-support-workflow.ts`, `runtimeConfig.routedDirectly`). Those runs are not router
 * decisions, but `RunScanRow` — the shared `scanWorkflowRuns` projection, owned by
 * `aggregates.ts` — does not select `final_output.runtimeConfig.routedDirectly`, so this reducer
 * cannot tell them apart from routed runs. Measured on the live DB (2026-08-22): 6 of 2,780 runs
 * in the last 14 days, ~0.2%, so the bar chart is very slightly inflated on the forced route and
 * a handful of live-gate records belong to turns the router did not actually decide. Fix, when it
 * matters: add `routed_directly:final_output->runtimeConfig->>routedDirectly` to `scanWorkflowRuns`
 * and filter here — do not add a second scan for it.
 */
export function buildRoutingHealthData(input: {
  window: AggregateWindow;
  runs: RunScanRow[];
  plannerSteps: RoutingPlannerScanRow[];
}): RoutingHealthData {
  const totalRuns = input.runs.length;

  const rows: RoutingHealthRow[] = buildRoutingDistribution(input.runs)
    .map((datum) => ({
      route: datum.routingDecision,
      label: labelForRoute(datum.routingDecision),
      isAgent: AGENT_IDS.has(datum.routingDecision),
      count: datum.count,
      share: totalRuns > 0 ? roundTo(datum.count / totalRuns, 4) : 0,
      avgConfidence: datum.avgConfidence,
    }))
    .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));

  return {
    windowFrom: input.window.from,
    windowTo: input.window.to,
    totalRuns,
    rows,
    agreement: buildRouterAgreement(input.plannerSteps),
  };
}

/** Window scan + the one child scan the agreement stats need, then the pure fold above. */
export async function getRoutingHealthData(
  window: AggregateWindow,
  version?: VersionFilter,
): Promise<RoutingHealthData> {
  const runs = await scanWorkflowRuns(window, version);
  const plannerSteps = await scanWorkflowStepOutputsByName(
    window,
    new Set(runs.map((run) => run.id)),
    PLANNER_STEP_NAME,
  );

  return buildRoutingHealthData({ window, runs, plannerSteps });
}
