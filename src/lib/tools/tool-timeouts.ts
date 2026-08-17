/**
 * B0-380 — wall-clock budget for a single tool execution.
 *
 * `executeToolCall` had no timeout, so one hung downstream call (Supabase, embedding provider, web
 * search) stalled the whole turn until the route's own `maxDuration` (300s). Wrapping the tool in a
 * bounded race turns a hang into the same structured `{"ok":false,"error":…}` failure every other
 * tool error already produces, so the model degrades gracefully and the workflow's existing
 * `tool_failed` audit path fires unchanged.
 */

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Per-tool defaults that deviate from `DEFAULT_TOOL_TIMEOUT_MS`.
 *
 * `recommend_cross_reference` is a multi-step pipeline (web search → spec extraction → LLM
 * recommendation → persistence), routinely slower than any retrieval tool; cutting it at 30s would
 * fail healthy runs.
 */
const PER_TOOL_DEFAULT_TIMEOUT_MS: Record<string, number> = {
  recommend_cross_reference: 120_000,
};

function parsePositiveMsEnv(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Env override key for one tool, e.g. `BEX_TOOL_TIMEOUT_MS_RECOMMEND_CROSS_REFERENCE`. */
function perToolTimeoutEnvKey(toolName: string): string {
  return `BEX_TOOL_TIMEOUT_MS_${toolName.toUpperCase()}`;
}

/**
 * Precedence: per-tool env → per-tool code default → global env (`BEX_TOOL_TIMEOUT_MS`) → global
 * default. The per-tool code default outranks the global env on purpose: an operator loosening or
 * tightening the fleet-wide knob must not silently choke `recommend_cross_reference`'s known-slow
 * pipeline — overriding that one requires naming it.
 */
export function resolveToolTimeoutMs(toolName: string): number {
  return (
    parsePositiveMsEnv(process.env[perToolTimeoutEnvKey(toolName)]) ??
    PER_TOOL_DEFAULT_TIMEOUT_MS[toolName] ??
    parsePositiveMsEnv(process.env.BEX_TOOL_TIMEOUT_MS) ??
    DEFAULT_TOOL_TIMEOUT_MS
  );
}

/** Message shape is load-bearing: it becomes the `error` the model (and B0-363 audit rows) see. */
export class ToolTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
    this.timeoutMs = timeoutMs;
    void toolName;
  }
}

export function isToolTimeoutError(err: unknown): err is ToolTimeoutError {
  return err instanceof ToolTimeoutError;
}

/**
 * Races `run` against the tool's timeout. The losing promise is not cancelled (the underlying I/O
 * has no abort handle at this layer) — it is simply no longer awaited, which is exactly the
 * degrade-gracefully behavior the ticket asks for.
 */
export async function withToolTimeout<T>(
  run: Promise<T>,
  toolName: string,
  timeoutMs: number = resolveToolTimeoutMs(toolName),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(toolName, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
