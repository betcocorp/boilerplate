import {
  percentileNearestRank,
  roundTo,
  scanWorkflowRuns,
  scanWorkflowStepOutputsByName,
  type AggregateWindow,
  type NamedStepScanRow,
  type VersionFilter,
} from '~/lib/observability/aggregates';
import { isKnownToolName, parseAgentStepToolTrace } from '~/lib/tests/tool-routing';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';

/**
 * B0-629 — per-tool call/failure/latency health for the Mission Control "Tool health" panel.
 *
 * Same pure-reducer + thin-reader split as `~/lib/observability/pipeline-stages.ts`:
 * `buildToolHealthData` does all the arithmetic over rows handed to it (no I/O, unit-testable
 * without a database), and `getToolHealthData` is the only part that touches Supabase.
 *
 * Source of truth is `workflow_steps.output.toolTrace` on the `openai_responses_agent` step
 * (written by `~/lib/workflows/product-support/run-product-support-workflow.ts`), whose element
 * shape is `toolTraceEntrySchema` in `~/lib/audit/trace.ts`.
 *
 * ## Honesty caveats this module deliberately encodes
 *
 * 1. **Zero traffic is not proof a tool is unused.** `productSupportToolsForRoute`
 *    (`~/lib/tools/definitions.ts`) hands the model route-dependent SUBSETS of the registry —
 *    `dilution`/`recommendations` are offered 11 of the 14, other routes all 14. A tool with no
 *    calls in the window may simply never have been OFFERED on the routes that window's traffic
 *    took. Hence `toolsWithTraffic` / `totalRegisteredTools` are reported as a ratio of
 *    *observed* traffic and this module never emits a per-tool "unused" verdict; the panel states
 *    the caveat in prose.
 * 2. **Speculative retrievals are not ordinary calls.** See `speculativeExcludedCount`.
 * 3. **A missing `durationMs` is not a fast call.** See `durationSampleSize` / percentile nulls.
 *
 * Verified against live data 2026-08-22 (`workflow_steps`, `step_name = 'openai_responses_agent'`,
 * 30-day window, 3,342 trace entries):
 *  - `durationMs` was present on **100%** of entries (3,342/3,342) — the duration rollout has
 *    fully caught up, so the p50/p95 columns are backed by essentially every retained call. The
 *    optional-duration handling below is still required by the schema and by older rows, but it
 *    is not currently the common path.
 *  - `speculative: true` was on 2,094 of 3,342 entries (63%) and was concentrated **entirely** in
 *    `search_product_docs` (2,821 entries → 727 after exclusion); every other tool was 100%
 *    non-speculative. Excluding them therefore changes one row dramatically and no other, which
 *    is exactly why `speculativeExcludedCount` is surfaced rather than left implicit.
 *  - `reusedSpeculativeResult` was never `true` on any live row, and 12 of the 14 registered
 *    tools saw traffic (`get_compatibility_rules` and `get_escalation_policy` did not).
 */

/** The step whose persisted `output.toolTrace` carries the agent's tool calls. */
export const TOOL_TRACE_STEP_NAME = 'openai_responses_agent';

export type ToolHealthRow = {
  toolName: string;
  /** Whether `toolName` is in `PRODUCT_TOOL_NAMES`; `false` flags a renamed/retired/rogue tool. */
  known: boolean;
  /** Ordinary calls only — speculative and reused-speculative entries are excluded. */
  callCount: number;
  /** Of `callCount`, how many carried `ok === false`. */
  failureCount: number;
  /**
   * `failureCount / callCount`, 0..1, rounded to 4dp. A row only exists when `callCount > 0`, so
   * unlike the latency columns a `0` here is a real measurement ("no failures"), not "no data".
   */
  failureRate: number;
  /** `null`, never `0`, when `durationSampleSize === 0` — the panel must render "no data". */
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  /** Of `callCount`, how many carried a usable `durationMs`. The percentile denominator. */
  durationSampleSize: number;
};

export type ToolHealthData = {
  windowFrom: string;
  windowTo: string;
  /** Most-called first; ties broken by tool name so the table order is deterministic. */
  rows: ToolHealthRow[];
  /**
   * Distinct REGISTERED tools with at least one ordinary call. Unknown tool names are excluded
   * so this stays comparable to `totalRegisteredTools` — an unrecognised name can never push the
   * numerator above the denominator.
   */
  toolsWithTraffic: number;
  /** `PRODUCT_TOOL_NAMES.length` — never hardcoded, so adding a tool moves this on its own. */
  totalRegisteredTools: number;
  /** Distinct tool names seen that are NOT in the registry (equals `rows.filter(r => !r.known)`). */
  unknownToolCount: number;
  /**
   * Trace entries dropped because `speculative === true` or `reusedSpeculativeResult === true`
   * (B0-436). Reported so this panel's call counts are reconcilable with surfaces that count
   * every trace entry, rather than silently disagreeing with them.
   */
  speculativeExcludedCount: number;
  /**
   * Retained (non-speculative) entries carrying no usable `durationMs`. The audit invariant is
   * `sum(callCount) === sum(durationSampleSize) + entriesMissingDuration`.
   */
  entriesMissingDuration: number;
};

/**
 * One `openai_responses_agent` step row. Structurally the `NamedStepScanRow` returned by
 * `scanWorkflowStepOutputsByName`, re-exported under a task-local name so tests can build
 * fixtures without importing the scan module's vocabulary.
 */
export type AgentStepToolTraceRow = NamedStepScanRow;

type ToolAccumulator = {
  toolName: string;
  known: boolean;
  callCount: number;
  failureCount: number;
  /** Collected unsorted; sorted once per tool at the end. */
  durations: number[];
};

/**
 * Pure reducer over already-fetched agent-step rows.
 *
 * Defensive by construction: a row whose `output` is absent, non-object, or carries a malformed
 * `toolTrace` is skipped (via `parseAgentStepToolTrace`, which `safeParse`s and returns `null`
 * rather than throwing), because an operator dashboard must never fail to render because one
 * historical row does not parse.
 */
export function buildToolHealthData(input: {
  window: AggregateWindow;
  agentSteps: AgentStepToolTraceRow[];
}): ToolHealthData {
  const { window, agentSteps } = input;

  const byTool = new Map<string, ToolAccumulator>();
  let speculativeExcludedCount = 0;
  let entriesMissingDuration = 0;

  for (const step of agentSteps) {
    const trace = parseAgentStepToolTrace(step.output);
    if (!trace) {
      continue;
    }

    for (const entry of trace) {
      // B0-436 — a speculative retrieval ran before the model asked for anything, and a reused
      // result is the SAME work counted twice (its `durationMs` is the speculative call's). Both
      // would inflate call counts and skew latency, so neither is an ordinary call here.
      if (entry.speculative === true || entry.reusedSpeculativeResult === true) {
        speculativeExcludedCount += 1;
        continue;
      }

      let accumulator = byTool.get(entry.toolName);
      if (!accumulator) {
        accumulator = {
          toolName: entry.toolName,
          // Kept rather than dropped when unrecognised: an unknown tool name in production is a
          // signal (a rename that never reached the registry), not noise to be filtered away.
          known: isKnownToolName(entry.toolName),
          callCount: 0,
          failureCount: 0,
          durations: [],
        };
        byTool.set(entry.toolName, accumulator);
      }

      accumulator.callCount += 1;
      if (!entry.ok) {
        accumulator.failureCount += 1;
      }

      // `durationMs` is optional on the schema. A missing one is UNKNOWN latency, never 0 —
      // defaulting it would fabricate an instant call and drag every percentile down.
      const duration = entry.durationMs;
      if (typeof duration === 'number' && Number.isFinite(duration)) {
        accumulator.durations.push(Math.max(0, duration));
      } else {
        entriesMissingDuration += 1;
      }
    }
  }

  const rows: ToolHealthRow[] = [...byTool.values()]
    .map((accumulator) => {
      const sorted = [...accumulator.durations].sort((a, b) => a - b);
      const hasSample = sorted.length > 0;

      return {
        toolName: accumulator.toolName,
        known: accumulator.known,
        callCount: accumulator.callCount,
        failureCount: accumulator.failureCount,
        failureRate: roundTo(accumulator.failureCount / accumulator.callCount, 4),
        // `percentileNearestRank` returns 0 for an empty array; that 0 is indistinguishable from
        // a genuine 0ms call, so the sample size — not the helper — decides "no data" here.
        p50DurationMs: hasSample ? percentileNearestRank(sorted, 0.5) : null,
        p95DurationMs: hasSample ? percentileNearestRank(sorted, 0.95) : null,
        durationSampleSize: sorted.length,
      } satisfies ToolHealthRow;
    })
    .sort((a, b) => b.callCount - a.callCount || a.toolName.localeCompare(b.toolName));

  return {
    windowFrom: window.from,
    windowTo: window.to,
    rows,
    toolsWithTraffic: rows.filter((row) => row.known && row.callCount > 0).length,
    totalRegisteredTools: PRODUCT_TOOL_NAMES.length,
    unknownToolCount: rows.filter((row) => !row.known).length,
    speculativeExcludedCount,
    entriesMissingDuration,
  };
}

/**
 * Reader half: the window's runs (so the version filter and window semantics match every other
 * health panel exactly), then that run set's `openai_responses_agent` step outputs.
 */
export async function getToolHealthData(
  window: AggregateWindow,
  version?: VersionFilter,
): Promise<ToolHealthData> {
  const runs = await scanWorkflowRuns(window, version);
  const runIds = new Set(runs.map((run) => run.id));
  const agentSteps = await scanWorkflowStepOutputsByName(window, runIds, TOOL_TRACE_STEP_NAME);

  return buildToolHealthData({ window, agentSteps });
}
