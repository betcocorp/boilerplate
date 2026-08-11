import { getErrorMessage } from '~/lib/utils';
import { PRODUCT_TOOL_NAMES, type ProductToolName } from '~/lib/tools/tool-schemas';
import { executeProductTool } from '~/lib/tools/product-tools';

import type { ToolCallOrigin, ToolTraceEntry } from '~/lib/audit/trace';

function isProductTool(name: string): name is ProductToolName {
  return (PRODUCT_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * B0-390 — preview budgets for the persisted trace. Exported because the truncation FLAG on the
 * trace entry is only meaningful next to the limit that produced it, and because callers that
 * record a tool call executed outside this module must use the same limits.
 */
export const TOOL_ARGUMENTS_PREVIEW_MAX_CHARS = 1_800;
export const TOOL_OUTPUT_PREVIEW_MAX_CHARS = 4_000;

/**
 * B0-390 — single construction site for a trace entry, so `argumentsTruncated` / `outputTruncated`
 * can never drift from the slice that produced the preview. Values are sliced, never reformatted:
 * a dilution ratio, EPA registration number, ppm or contact time inside a preview is exactly the
 * text the tool returned (possibly cut, in which case the flag says so).
 */
export function buildToolTraceEntry(input: {
  toolName: string;
  callId: string;
  argumentsJson: string;
  output: string;
  ok: boolean;
  durationMs: number;
  origin?: ToolCallOrigin;
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
  };
}

export async function executeToolCall(input: {
  name: string;
  argumentsJson: string;
  callId: string;
  /** B0-390 — why this call happened; defaults to a model-chosen call. */
  origin?: ToolCallOrigin;
}): Promise<{ output: string; trace: ToolTraceEntry }> {
  const started = Date.now();
  let args: unknown;

  try {
    args = JSON.parse(input.argumentsJson || '{}') as unknown;
  } catch {
    args = {};
  }

  const traceFor = (output: string, ok: boolean) =>
    buildToolTraceEntry({
      toolName: input.name,
      callId: input.callId,
      argumentsJson: input.argumentsJson,
      output,
      ok,
      durationMs: Date.now() - started,
      origin: input.origin ?? 'model_chosen',
    });

  try {
    if (!isProductTool(input.name)) {
      const msg = JSON.stringify({
        ok: false,
        error: `Unsupported tool: ${input.name}`,
      });
      return { output: msg, trace: traceFor(msg, false) };
    }

    const payload = await executeProductTool(input.name, args);
    const out = JSON.stringify(payload);

    return { output: out, trace: traceFor(out, true) };
  } catch (err) {
    const message = getErrorMessage(err);
    const out = JSON.stringify({ ok: false, error: message });

    return { output: out, trace: traceFor(out, false) };
  }
}
