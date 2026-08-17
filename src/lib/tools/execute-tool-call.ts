import { getErrorMessage } from '~/lib/utils';
import { PRODUCT_TOOL_NAMES, type ProductToolName } from '~/lib/tools/tool-schemas';
import { buildModelToolPayload } from '~/lib/tools/model-tool-payload';
import { executeProductTool } from '~/lib/tools/product-tools';

import type { ToolCallOrigin, ToolRetrievalParams, ToolTraceEntry } from '~/lib/audit/trace';
import { toolRetrievalParamsSchema } from '~/lib/audit/trace';
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
  /** B0-493 — retrieval parameters extracted from the FULL (untruncated) payload. */
  retrieval?: ToolRetrievalParams;
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
    ...(input.retrieval ? { retrieval: input.retrieval } : {}),
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
      retrieval,
    });

  try {
    if (!isProductTool(input.name)) {
      const msg = JSON.stringify({
        ok: false,
        error: `Unsupported tool: ${input.name}`,
      });
      return { output: msg, trace: traceFor(msg, false) };
    }

    const payload = await executeProductTool(input.name, args, input.auditCtx);
    const out = JSON.stringify(payload);

    // B0-437 — only carry a model variant when it is actually smaller; an equal-size variant would
    // just be a second copy of the same string.
    const modelPayload = buildModelToolPayload(payload);
    const modelOut = modelPayload ? JSON.stringify(modelPayload) : null;
    const useModelOut = modelOut !== null && modelOut.length < out.length;
    // B0-493 — read off the FULL payload object, never the (possibly truncated) `out` string.
    const retrieval = extractToolRetrievalParams(payload);

    return {
      output: out,
      ...(useModelOut ? { modelOutput: modelOut } : {}),
      trace: traceFor(out, true, useModelOut ? modelOut.length : undefined, retrieval),
    };
  } catch (err) {
    const message = getErrorMessage(err);
    const out = JSON.stringify({ ok: false, error: message });

    return { output: out, trace: traceFor(out, false) };
  }
}
