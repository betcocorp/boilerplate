import { getErrorMessage } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-119 — per-app rate limiting for `/api/v1/*`.
 *
 * Enforcement is a Postgres-only rolling window: count the app's `api_request_log` rows in the last
 * `windowSeconds` (indexed on app_id + created_at) and reject when the count reaches the app's
 * `rate_limit_per_minute`. Null/≤0 limit = unlimited (no query, no latency). The realistic threat
 * is a consuming app's runaway retry loop running up the OpenAI bill overnight; limiting per app
 * means one app tripping its cap never throttles its siblings.
 */

export const RATE_LIMIT_WINDOW_SECONDS = 60;

export type RateLimitDecision = { limited: boolean; retryAfterSeconds: number };

/** Pure: given the per-minute cap and the count already in the window, decide. */
export function evaluateRateLimit(input: {
  limitPerMinute: number | null;
  recentCount: number;
  windowSeconds?: number;
}): RateLimitDecision {
  const windowSeconds = input.windowSeconds ?? RATE_LIMIT_WINDOW_SECONDS;
  if (input.limitPerMinute == null || input.limitPerMinute <= 0) {
    return { limited: false, retryAfterSeconds: 0 };
  }
  const limited = input.recentCount >= input.limitPerMinute;
  return { limited, retryAfterSeconds: limited ? windowSeconds : 0 };
}

/**
 * Count an app's request-log rows in the last `windowSeconds`. Fails **open** (returns 0) on a
 * query error — a counting hiccup must never block legitimate traffic.
 */
export async function countAppRequestsInWindow(
  appId: string,
  windowSeconds: number = RATE_LIMIT_WINDOW_SECONDS,
): Promise<number> {
  try {
    const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const supabase = getSupabaseServiceRoleClient();
    const { count, error } = await supabase
      .from('api_request_log')
      .select('id', { count: 'exact', head: true })
      .eq('app_id', appId)
      .gte('created_at', since);
    if (error) throw new Error(error.message);
    return count ?? 0;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'api_rate_limit_count_failed',
        app_id: appId,
        message: getErrorMessage(err),
      }),
    );
    return 0;
  }
}

/** The single 429 response an over-limit `/api/v1/*` caller receives. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    },
  });
}
