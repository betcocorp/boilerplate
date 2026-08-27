import { toolTraceSchema, type ToolTraceEntry } from '~/lib/audit/trace';
import { PRODUCT_TOOL_NAMES, type ProductToolName } from '~/lib/tools/tool-schemas';

/**
 * B0-383 — per-tool routing accuracy for the eval harness.
 *
 * The agent's tool call trace (`ToolTraceEntry[]`) is persisted on the `openai_responses_agent`
 * `workflow_steps` row (`output.toolTrace`, B0-331/B0-390) — never on `test_result_items.response_payload`
 * itself. This module is the pure (unit-testable) half of the feature: it turns
 * `{ expectedTool, toolTrace }` per test item into a frequency table + routing-accuracy score +
 * mismatch list. The I/O half (fetching the `workflow_steps` rows by `workflow_run_id`) lives in
 * `~/lib/tests/repository.ts` (`listAgentStepOutputsByWorkflowRunIds`), matching the existing split
 * between `response-payload.ts` (pure extraction) and `repository.ts` (Supabase reads).
 */

const KNOWN_TOOL_NAME_SET: ReadonlySet<string> = new Set(PRODUCT_TOOL_NAMES);

/** True when `name` is one of the 14 live function tools in `~/lib/tools/tool-schemas.ts`. */
export function isKnownToolName(name: string): name is ProductToolName {
  return KNOWN_TOOL_NAME_SET.has(name);
}

/**
 * Normalizes a `test_items.expected_tool` column value. Returns the raw trimmed string even when
 * it doesn't match a known tool name (surfaced separately as `unknownExpectedTools` in the report)
 * so a typo'd tool name is visible instead of silently treated as "no expectation".
 */
export function extractExpectedTool(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Parses one `workflow_steps.output` value (the `openai_responses_agent` step) into its
 * `toolTrace` array. Tolerant of every shape that's actually on file: absent entirely (run never
 * reached the agent step — early decline), present but predating B0-331 capture, or malformed —
 * all return `null` rather than throwing, since a harness report must never fail to render because
 * one historical row doesn't parse.
 */
export function parseAgentStepToolTrace(output: unknown): ToolTraceEntry[] | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null;
  }
  const candidate = (output as Record<string, unknown>).toolTrace;
  if (!Array.isArray(candidate)) {
    return null;
  }
  const parsed = toolTraceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export type ToolCallFrequencyDatum = {
  toolName: string;
  /** Total number of calls across every item in this run (a question can call the same tool twice). */
  callCount: number;
  /** Number of distinct test result items that called this tool at least once. */
  itemCount: number;
  known: boolean;
};

export type ToolRoutingMismatch = {
  resultItemId: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
  expectedTool: string;
  /** Tool names the run actually called for this question, in call order (`[]` = no tool called at all). */
  calledTools: string[];
};

export type ToolRoutingReport = {
  /** Per-tool call frequency across every scored + unscored item in the run, most-called first. */
  frequency: ToolCallFrequencyDatum[];
  /** Items with an `expected_tool` set — the denominator for `routingAccuracy`. */
  scoredItemCount: number;
  /** Of `scoredItemCount`, how many called the expected tool at least once. */
  matchedItemCount: number;
  /** `matchedItemCount / scoredItemCount`, or `null` when no item in the run has an expectation set. */
  routingAccuracy: number | null;
  /** Scored items whose call trace never included the expected tool — the offending call is `calledTools`. */
  mismatches: ToolRoutingMismatch[];
  /** Distinct `expected_tool` values on file that aren't one of the 14 live tool names (likely typos). */
  unknownExpectedTools: string[];
};

export type ToolRoutingReportInput = {
  resultItemId: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
  /** From `extractExpectedTool(testItem.expected_tool)`; `null` = this question has no routing expectation. */
  expectedTool: string | null;
  /** From `parseAgentStepToolTrace(...)`, keyed by this item's `workflow_run_id`; `null` = no trace on file. */
  toolTrace: ToolTraceEntry[] | null;
};

/**
 * Pure reducer: one run's worth of `{ expectedTool, toolTrace }` per item → the harness's
 * per-tool-call-frequency + routing-accuracy report (AC1) plus the mismatch list the failure
 * surface renders (AC2). A question with no `expected_tool` still contributes to `frequency` but
 * is excluded from `routingAccuracy` and can never appear in `mismatches` — there is nothing to be
 * wrong about.
 */
export function computeToolRoutingReport(items: ToolRoutingReportInput[]): ToolRoutingReport {
  const frequencyByName = new Map<string, { callCount: number; itemIds: Set<string> }>();
  const unknownExpectedTools = new Set<string>();
  let scoredItemCount = 0;
  let matchedItemCount = 0;
  const mismatches: ToolRoutingMismatch[] = [];

  for (const item of items) {
    const calledTools = (item.toolTrace ?? []).map((entry) => entry.toolName);

    for (const toolName of calledTools) {
      const entry = frequencyByName.get(toolName) ?? { callCount: 0, itemIds: new Set<string>() };
      entry.callCount += 1;
      entry.itemIds.add(item.resultItemId);
      frequencyByName.set(toolName, entry);
    }

    if (!item.expectedTool) {
      continue;
    }

    if (!isKnownToolName(item.expectedTool)) {
      unknownExpectedTools.add(item.expectedTool);
    }

    scoredItemCount += 1;
    const matched = calledTools.includes(item.expectedTool);
    if (matched) {
      matchedItemCount += 1;
    } else {
      mismatches.push({
        resultItemId: item.resultItemId,
        testItemId: item.testItemId,
        rowIndex: item.rowIndex,
        prompt: item.prompt,
        expectedTool: item.expectedTool,
        calledTools,
      });
    }
  }

  const frequency: ToolCallFrequencyDatum[] = [...frequencyByName.entries()]
    .map(([toolName, entry]) => ({
      toolName,
      callCount: entry.callCount,
      itemCount: entry.itemIds.size,
      known: isKnownToolName(toolName),
    }))
    .sort((a, b) => b.callCount - a.callCount || a.toolName.localeCompare(b.toolName));

  return {
    frequency,
    scoredItemCount,
    matchedItemCount,
    routingAccuracy: scoredItemCount > 0 ? matchedItemCount / scoredItemCount : null,
    mismatches: mismatches.sort((a, b) => a.rowIndex - b.rowIndex),
    unknownExpectedTools: [...unknownExpectedTools].sort((a, b) => a.localeCompare(b)),
  };
}
