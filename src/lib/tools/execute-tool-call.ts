import { getErrorMessage } from '~/lib/utils';
import { logWarn } from '~/lib/observability/logger';
import { PRODUCT_TOOL_NAMES, type ProductToolName } from '~/lib/tools/tool-schemas';
import { buildModelToolPayload } from '~/lib/tools/model-tool-payload';
import { executeProductTool } from '~/lib/tools/product-tools';
import { enforceToolOutputBudget } from '~/lib/tools/tool-output-budget';
import {
  isToolTimeoutError,
  resolveToolTimeoutMs,
  withToolTimeout,
} from '~/lib/tools/tool-timeouts';

import type {
  ToolCallOrigin,
  ToolRetrievalParams,
  ToolTraceEntry,
  ToolWebSearchParams,
} from '~/lib/audit/trace';
import { toolRetrievalParamsSchema, toolWebSearchParamsSchema } from '~/lib/audit/trace';
import type { AuditContext } from '~/lib/audit/audit-log';

function isProductTool(name: string): name is ProductToolName {
  return (PRODUCT_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * B0-493 — pulls retrieval parameters/strategy off the FULL tool payload (before it is
 * JSON.stringify'd and truncated into `outputPreview`). Product tools that ran a RAG search carry
 * `retrieval: { search: {...}, selection: {...}, ... }` (see `ProductKnowledgeRetrievalSummary` in
 * `~/lib/retrieval/product-knowledge.ts`); this flattens that into the trace entry's own
 * `retrieval` shape. Returns `undefined` (not persisted) for every other tool, and tolerates a
 * malformed/missing block rather than throwing.
 */
function extractToolRetrievalParams(
  payload: Record<string, unknown>,
): ToolRetrievalParams | undefined {
  const retrieval = payload.retrieval;
  if (!retrieval || typeof retrieval !== 'object' || Array.isArray(retrieval)) {
    return undefined;
  }
  const { search, selection } = retrieval as Record<string, unknown>;
  if (!search || typeof search !== 'object' || Array.isArray(search)) {
    return undefined;
  }
  const parsed = toolRetrievalParamsSchema.safeParse({
    ...(search as Record<string, unknown>),
    selection,
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * B0-292 — mirrors `extractToolRetrievalParams` for web-search results: pulls the search query,
 * result list, and searches-used/escalation telemetry off the FULL tool payload's `evidence` block
 * (`recommend-cross-reference.ts` sets `evidence.webSearchResults` = `{ query, results }` and
 * `evidence.webSearch` = `{ searchesUsed, escalated, ... }`), never the truncated `outputPreview`.
 * Returns `undefined` (not persisted) for any tool/run without both pieces, and tolerates a
 * malformed block rather than throwing.
 */
function extractToolWebSearch(payload: Record<string, unknown>): ToolWebSearchParams | undefined {
  const evidence = payload.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return undefined;
  }
  const { webSearchResults, webSearch } = evidence as Record<string, unknown>;
  if (
    !webSearchResults ||
    typeof webSearchResults !== 'object' ||
    Array.isArray(webSearchResults)
  ) {
    return undefined;
  }
  const telemetry =
    webSearch && typeof webSearch === 'object' && !Array.isArray(webSearch)
      ? (webSearch as Record<string, unknown>)
      : {};
  const parsed = toolWebSearchParamsSchema.safeParse({
    ...(webSearchResults as Record<string, unknown>),
    searchesUsed: telemetry.searchesUsed,
    escalated: telemetry.escalated,
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * B0-390 — preview budgets for the persisted trace. Exported because the truncation FLAG on the
 * trace entry is only meaningful next to the limit that produced it, and because callers that
 * record a tool call executed outside this module must use the same limits.
 */
export const TOOL_ARGUMENTS_PREVIEW_MAX_CHARS = 1_800;
export const TOOL_OUTPUT_PREVIEW_MAX_CHARS = 4_000;

/**
 * B0-437 — `output` is the authoritative payload: it is what gets persisted and what the validator
 * and the regulated-claim guardrail read. `modelOutput`, when present, is a slimmer projection of the
 * same data that goes to the model instead (see `~/lib/tools/model-tool-payload`). Consumers that
 * need the full evidence must use `output`; only the generation runtimes use `modelOutput`.
 */
export type ExecutedToolCall = {
  output: string;
  modelOutput?: string;
  trace: ToolTraceEntry;
};

/**
 * B0-390 — single construction site for a trace entry, so `argumentsTruncated` / `outputTruncated`
 * can never drift from the slice that produced the preview. Values are sliced, never reformatted:
 * a dilution ratio, EPA registration number, ppm or contact time inside a preview is exactly the
 * text the tool returned (possibly cut, in which case the flag says so).
 *
 * B0-437 — the preview always describes the FULL payload (the audit record of what was retrieved),
 * never the slimmed model-facing variant; `modelOutputChars` records that variant's size so the
 * model-vs-persisted split stays verifiable from the trace alone.
 */
export function buildToolTraceEntry(input: {
  toolName: string;
  callId: string;
  argumentsJson: string;
  output: string;
  ok: boolean;
  durationMs: number;
  origin?: ToolCallOrigin;
  modelOutputChars?: number;
  /** B0-382 — the model-facing output was capped by the tool-output size budget. */
  modelOutputBudgetApplied?: boolean;
  /** B0-493 — retrieval parameters extracted from the FULL (untruncated) payload. */
  retrieval?: ToolRetrievalParams;
  /** B0-292 — web-search results extracted from the FULL (untruncated) payload. */
  webSearch?: ToolWebSearchParams;
}): ToolTraceEntry {
  const argumentsJson = input.argumentsJson || '';
  const argumentsTruncated = argumentsJson.length > TOOL_ARGUMENTS_PREVIEW_MAX_CHARS;
  const outputTruncated = input.output.length > TOOL_OUTPUT_PREVIEW_MAX_CHARS;

  return {
    toolName: input.toolName,
    callId: input.callId,
    argumentsPreview: argumentsJson.slice(0, TOOL_ARGUMENTS_PREVIEW_MAX_CHARS),
    outputPreview: input.output.slice(0, TOOL_OUTPUT_PREVIEW_MAX_CHARS),
    ok: input.ok,
    durationMs: input.durationMs,
    ...(input.origin ? { origin: input.origin } : {}),
    argumentsTruncated,
    outputTruncated,
    ...(input.modelOutputChars !== undefined
      ? { modelOutputChars: input.modelOutputChars }
      : {}),
    ...(input.modelOutputBudgetApplied ? { modelOutputBudgetApplied: true } : {}),
    ...(input.retrieval ? { retrieval: input.retrieval } : {}),
    ...(input.webSearch ? { webSearch: input.webSearch } : {}),
  };
}

export async function executeToolCall(input: {
  name: string;
  argumentsJson: string;
  callId: string;
  /** B0-390 — why this call happened; defaults to a model-chosen call. */
  origin?: ToolCallOrigin;
  /** B0-488 — the calling workflow's audit context (traceId/workflowRunId/...), so
   * `executeProductTool` can log an alias-resolution hit. Undefined for callers with no run
   * context (e.g. unit tests) — the call still executes, only that logging is skipped. */
  auditCtx?: AuditContext;
}): Promise<ExecutedToolCall> {
  const started = Date.now();
  let args: unknown;

  try {
    args = JSON.parse(input.argumentsJson || '{}') as unknown;
  } catch {
    args = {};
  }

  const traceFor = (
    output: string,
    ok: boolean,
    modelOutputChars?: number,
    retrieval?: ToolRetrievalParams,
    modelOutputBudgetApplied?: boolean,
    webSearch?: ToolWebSearchParams,
  ) =>
    buildToolTraceEntry({
      toolName: input.name,
      callId: input.callId,
      argumentsJson: input.argumentsJson,
      output,
      ok,
      durationMs: Date.now() - started,
      origin: input.origin ?? 'model_chosen',
      modelOutputChars,
      modelOutputBudgetApplied,
      retrieval,
      webSearch,
    });

  try {
    if (!isProductTool(input.name)) {
      const msg = JSON.stringify({
        ok: false,
        error: `Unsupported tool: ${input.name}`,
      });
      return { output: msg, trace: traceFor(msg, false) };
    }

    // B0-380 — bounded execution: a hung downstream call becomes a structured timeout failure
    // (thrown as ToolTimeoutError, serialized by the catch below) instead of stalling the turn.
    const payload = await withToolTimeout(
      executeProductTool(input.name, args, input.auditCtx),
      input.name,
      resolveToolTimeoutMs(input.name),
    );
    const out = JSON.stringify(payload);

    // B0-437 — only carry a model variant when it is actually smaller; an equal-size variant would
    // just be a second copy of the same string.
    const modelPayload = buildModelToolPayload(payload);
    const modelOut = modelPayload ? JSON.stringify(modelPayload) : null;
    const useModelOut = modelOut !== null && modelOut.length < out.length;
    // B0-493 — read off the FULL payload object, never the (possibly truncated) `out` string.
    const retrieval = extractToolRetrievalParams(payload);
    // B0-292 — same principle: the web-search result list off the FULL payload's `evidence` block.
    const webSearch = extractToolWebSearch(payload);

    // B0-382 — cap what enters the model context. Runs on the string the runtimes would actually
    // send (`modelOutput ?? output`); the persisted full `out` is never capped.
    const budget = enforceToolOutputBudget(useModelOut ? modelOut : out);
    if (budget.applied) {
      logWarn('tool_output_budget_applied', {
        tool_name: input.name,
        call_id: input.callId,
        original_chars: budget.originalChars,
        capped_chars: budget.output.length,
        truncated_documents: budget.truncatedDocuments,
        dropped_sources: budget.droppedSources,
      });
    }
    const modelFacing = budget.applied ? budget.output : useModelOut ? modelOut : null;

    return {
      output: out,
      ...(modelFacing !== null ? { modelOutput: modelFacing } : {}),
      trace: traceFor(
        out,
        true,
        modelFacing !== null ? modelFacing.length : undefined,
        retrieval,
        budget.applied || undefined,
        webSearch,
      ),
    };
  } catch (err) {
    const message = getErrorMessage(err);
    const out = JSON.stringify({ ok: false, error: message });

    // B0-380 — structured signal alongside the ordinary failure path; the workflow's `tool_failed`
    // audit row is emitted off `trace.ok` exactly like any other tool failure.
    if (isToolTimeoutError(err)) {
      logWarn('tool_timeout', {
        tool_name: input.name,
        call_id: input.callId,
        timeout_ms: err.timeoutMs,
        duration_ms: Date.now() - started,
      });
    }

    return { output: out, trace: traceFor(out, false) };
  }
}
