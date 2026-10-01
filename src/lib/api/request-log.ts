import { getErrorMessage } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * Per-request logging for `/api/v1/*` (B0-117).
 *
 * Rows are written to `public.api_request_log` **after the response is sent** (the caller
 * schedules this via `after()`), so logging never adds latency and a logging failure never
 * fails a request — every write here is best-effort and swallows its own errors. Only request
 * metadata + LLM token usage are stored; **no request or response bodies**.
 */

export type ApiTokenUsage = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
};

export type ApiRequestLogInput = {
  keyId: string | null;
  appId: string | null;
  projectId: string | null;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  error?: string | null;
  usage?: ApiTokenUsage | null;
};

/** Shape a log input into the `api_request_log` insert row (pure; unit-testable). */
export function buildApiRequestLogRow(input: ApiRequestLogInput) {
  return {
    key_id: input.keyId,
    app_id: input.appId,
    project_id: input.projectId,
    method: input.method,
    path: input.path,
    status: input.status,
    latency_ms: Number.isFinite(input.latencyMs) ? Math.max(0, Math.round(input.latencyMs)) : null,
    prompt_tokens: input.usage?.promptTokens ?? null,
    completion_tokens: input.usage?.completionTokens ?? null,
    total_tokens: input.usage?.totalTokens ?? null,
    error: input.error ?? null,
  };
}

export async function writeApiRequestLog(input: ApiRequestLogInput): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    await supabase.from('api_request_log').insert(buildApiRequestLogRow(input));
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'api_request_log_write_failed',
        message: getErrorMessage(err),
      }),
    );
  }
}

/** Maintain `api_key.last_used_at` so a token going quiet during rotation is visible. */
export async function touchApiKeyLastUsed(keyId: string): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    await supabase
      .from('api_key')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', keyId);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'api_key_last_used_update_failed',
        message: getErrorMessage(err),
      }),
    );
  }
}
