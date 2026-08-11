import { getErrorMessage } from '~/lib/utils';
import { PRODUCT_TOOL_NAMES, type ProductToolName } from '~/lib/tools/tool-schemas';
import { buildModelToolPayload } from '~/lib/tools/model-tool-payload';
import { executeProductTool } from '~/lib/tools/product-tools';

import type { ToolTraceEntry } from '~/lib/audit/trace';

function isProductTool(name: string): name is ProductToolName {
  return (PRODUCT_TOOL_NAMES as readonly string[]).includes(name);
}

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

export async function executeToolCall(input: {
  name: string;
  argumentsJson: string;
  callId: string;
}): Promise<ExecutedToolCall> {
  const started = Date.now();
  let args: unknown;

  try {
    args = JSON.parse(input.argumentsJson || '{}') as unknown;
  } catch {
    args = {};
  }

  const preview = (input.argumentsJson || '').slice(0, 1800);

  try {
    if (!isProductTool(input.name)) {
      const msg = JSON.stringify({
        ok: false,
        error: `Unsupported tool: ${input.name}`,
      });
      return {
        output: msg,
        trace: {
          toolName: input.name,
          callId: input.callId,
          argumentsPreview: preview,
          outputPreview: msg,
          ok: false,
          durationMs: Date.now() - started,
        },
      };
    }

    const payload = await executeProductTool(input.name, args);
    const out = JSON.stringify(payload);

    // B0-437 — only carry a model variant when it is actually smaller; an equal-size variant would
    // just be a second copy of the same string.
    const modelPayload = buildModelToolPayload(payload);
    const modelOut = modelPayload ? JSON.stringify(modelPayload) : null;
    const useModelOut = modelOut !== null && modelOut.length < out.length;

    return {
      output: out,
      ...(useModelOut ? { modelOutput: modelOut } : {}),
      trace: {
        toolName: input.name,
        callId: input.callId,
        argumentsPreview: preview,
        // The preview is of the FULL payload: it is the audit record of what was retrieved.
        outputPreview: out.slice(0, 4000),
        ok: true,
        durationMs: Date.now() - started,
        ...(useModelOut ? { modelOutputChars: modelOut.length } : {}),
      },
    };
  } catch (err) {
    const message = getErrorMessage(err);
    const out = JSON.stringify({ ok: false, error: message });

    return {
      output: out,
      trace: {
        toolName: input.name,
        callId: input.callId,
        argumentsPreview: preview,
        outputPreview: out,
        ok: false,
        durationMs: Date.now() - started,
      },
    };
  }
}
