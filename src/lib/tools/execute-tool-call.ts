import { getErrorMessage } from '~/lib/utils';
import { PRODUCT_TOOL_NAMES, type ProductToolName } from '~/lib/tools/tool-schemas';
import { executeProductTool } from '~/lib/tools/product-tools';

import type { ToolTraceEntry } from '~/lib/audit/trace';

function isProductTool(name: string): name is ProductToolName {
  return (PRODUCT_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeToolCall(input: {
  name: string;
  argumentsJson: string;
  callId: string;
}): Promise<{ output: string; trace: ToolTraceEntry }> {
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

    return {
      output: out,
      trace: {
        toolName: input.name,
        callId: input.callId,
        argumentsPreview: preview,
        outputPreview: out.slice(0, 4000),
        ok: true,
        durationMs: Date.now() - started,
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
