import type { ToolTraceEntry } from '~/lib/audit/trace';

/**
 * B0-488 — per-run alias-resolution hit/miss rate for the eval harness. Coordinated with (not
 * duplicating) B0-383's tool-routing instrumentation (`~/lib/tests/tool-routing.ts`): same source
 * of truth (the agent step's persisted `toolTrace`, which lives on
 * `workflow_steps.output.toolTrace` keyed by `workflow_run_id` — never on
 * `test_result_items.response_payload` itself), same parse-tolerantly-then-reduce shape, so the
 * caller (`[testId]/runs/[runId]/page.tsx`) reuses the exact same `workflow_steps` fetch and
 * `parseAgentStepToolTrace` output that already feeds `computeToolRoutingReport`.
 *
 * Each product-tool call's JSON payload carries a small `aliasResolution: { attempted, outcome }`
 * field (`~/lib/tools/product-tools.ts`'s `resolveProductEntityWithAliasTelemetry`), placed near
 * the front of the returned object so it reliably survives the tool trace's 4,000-char
 * `outputPreview` truncation (`~/lib/tools/execute-tool-call.ts`). This module parses that field
 * back out of every call in a run's trace and reduces it into a hit-rate report.
 */

/**
 * The four outcome categories the ticket (B0-488) asks the metric to distinguish:
 * - `alias_exact` / `alias_fuzzy` — `rag.product_alias` actually resolved the query (fuzzy covers
 *   both the tokenized and trigram-RPC tiers; see `~/lib/tools/product-tools.ts`).
 * - `no_alias_match` — the alias table had nothing for this query (whether or not a legacy
 *   prod_line_id/title fallback still anchored the retrieval).
 * - `ambiguous_alias` — alias candidates existed but spanned multiple product lines and were
 *   rejected by the verified-tiebreak gate (`~/lib/rag/entity-context.ts`'s `ambiguousAlias`).
 */
export type AliasResolutionOutcome = 'alias_exact' | 'alias_fuzzy' | 'no_alias_match' | 'ambiguous_alias';

const ALIAS_RESOLUTION_OUTCOMES: ReadonlySet<string> = new Set([
  'alias_exact',
  'alias_fuzzy',
  'no_alias_match',
  'ambiguous_alias',
]);

function isAliasResolutionOutcome(value: unknown): value is AliasResolutionOutcome {
  return typeof value === 'string' && ALIAS_RESOLUTION_OUTCOMES.has(value);
}

export type AliasResolutionCallEntry = {
  toolName: string;
  outcome: AliasResolutionOutcome;
};

/**
 * Extracts the alias-resolution outcome from every tool call in one agent step's trace that
 * actually attempted a resolution (`aliasResolution.attempted === true`). Tolerant of every shape
 * that's actually on file — `outputPreview` failing to parse (truncated mid-object), a run that
 * predates this field entirely, or a tool that never resolves a product name at all — skips that
 * call rather than throwing, since a harness report must never fail to render because one
 * historical row doesn't parse (same tolerance policy as `parseAgentStepToolTrace`).
 */
export function extractAliasResolutionCallsFromToolTrace(
  toolTrace: ToolTraceEntry[] | null,
): AliasResolutionCallEntry[] {
  if (!toolTrace) {
    return [];
  }

  const entries: AliasResolutionCallEntry[] = [];
  for (const call of toolTrace) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.outputPreview);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }

    const aliasResolution = (parsed as Record<string, unknown>).aliasResolution;
    if (!aliasResolution || typeof aliasResolution !== 'object' || Array.isArray(aliasResolution)) {
      continue;
    }

    const { attempted, outcome } = aliasResolution as Record<string, unknown>;
    if (attempted !== true || !isAliasResolutionOutcome(outcome)) {
      continue;
    }

    entries.push({ toolName: call.toolName, outcome });
  }
  return entries;
}

export type AliasResolutionReport = {
  /** Total alias-resolution attempts across every item in the run (tool calls carrying a
   * non-empty product name/id, regardless of outcome). */
  totalAttempts: number;
  counts: Record<AliasResolutionOutcome, number>;
  /** `(alias_exact + alias_fuzzy) / totalAttempts`, or null when nothing in the run attempted an
   * alias resolution. */
  hitRate: number | null;
  /** `ambiguous_alias / totalAttempts`, or null when nothing attempted a resolution. */
  ambiguousRate: number | null;
};

const EMPTY_COUNTS: Record<AliasResolutionOutcome, number> = {
  alias_exact: 0,
  alias_fuzzy: 0,
  no_alias_match: 0,
  ambiguous_alias: 0,
};

/**
 * Pure reducer: one run's worth of per-item agent-step tool traces (`null` for items with no trace
 * on file, e.g. early-declines) -> the alias-resolution hit-rate report.
 */
export function computeAliasResolutionReport(
  toolTraces: Array<ToolTraceEntry[] | null>,
): AliasResolutionReport {
  const counts: Record<AliasResolutionOutcome, number> = { ...EMPTY_COUNTS };
  let totalAttempts = 0;

  for (const toolTrace of toolTraces) {
    for (const entry of extractAliasResolutionCallsFromToolTrace(toolTrace)) {
      counts[entry.outcome] += 1;
      totalAttempts += 1;
    }
  }

  const hits = counts.alias_exact + counts.alias_fuzzy;

  return {
    totalAttempts,
    counts,
    hitRate: totalAttempts > 0 ? hits / totalAttempts : null,
    ambiguousRate: totalAttempts > 0 ? counts.ambiguous_alias / totalAttempts : null,
  };
}
