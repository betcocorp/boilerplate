import { after } from 'next/server';

import {
  authenticateApiToken,
  unauthorizedResponse,
  type ApiAuthContext,
} from '~/lib/api/client-auth';
import {
  countAppRequestsInWindow,
  evaluateRateLimit,
  rateLimitedResponse,
} from '~/lib/api/rate-limit';
import {
  touchApiKeyLastUsed,
  writeApiRequestLog,
  type ApiTokenUsage,
} from '~/lib/api/request-log';

/**
 * Shared wrapper for every `/api/v1/*` route handler (B0-115 auth + B0-117 logging).
 *
 * It authenticates the client token, and — after the response is sent (`after()`) — writes an
 * `api_request_log` row and refreshes the token's `last_used_at`, so logging adds no latency and
 * can never fail the request. Authenticated calls always log; a failed-but-resolvable token
 * (revoked / expired / deactivated app or project) logs its attempt; missing/malformed/unknown
 * tokens return 401 without creating an orphan log row.
 *
 * The wrapped handler receives the auth context plus `recordUsage`, which it calls to attach LLM
 * token usage to the log row when the workflow reports it.
 */

export type ApiV1HandlerContext = {
  auth: ApiAuthContext;
  recordUsage: (usage: ApiTokenUsage) => void;
};

export type ApiV1Handler = (
  request: Request,
  ctx: ApiV1HandlerContext,
) => Response | Promise<Response>;

export function withApiV1(handler: ApiV1Handler) {
  return async function apiV1Route(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const method = request.method;
    const path = new URL(request.url).pathname;

    const auth = await authenticateApiToken(request);

    if (!auth.ok) {
      const response = unauthorizedResponse();
      const attribution = auth.attribution;
      if (attribution) {
        after(() =>
          writeApiRequestLog({
            keyId: attribution.keyId,
            appId: attribution.appId,
            projectId: attribution.projectId,
            method,
            path,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            error: auth.reason,
          }),
        );
      }
      return response;
    }

    const { keyId, appId, projectId, rateLimitPerMinute } = auth.context;
    let usage: ApiTokenUsage | null = null;

    const finalize = (status: number, error: string | null) => {
      after(async () => {
        await Promise.all([
          writeApiRequestLog({
            keyId,
            appId,
            projectId,
            method,
            path,
            status,
            latencyMs: Date.now() - startedAt,
            error,
            usage,
          }),
          touchApiKeyLastUsed(keyId),
        ]);
      });
    };

    // B0-119 — per-app rate limit. Unlimited apps skip the count entirely (no added latency).
    if (rateLimitPerMinute != null && rateLimitPerMinute > 0) {
      const recentCount = await countAppRequestsInWindow(appId);
      const decision = evaluateRateLimit({ limitPerMinute: rateLimitPerMinute, recentCount });
      if (decision.limited) {
        const response = rateLimitedResponse(decision.retryAfterSeconds);
        finalize(response.status, 'rate_limited');
        return response;
      }
    }

    let response: Response;
    try {
      response = await handler(request, {
        auth: auth.context,
        recordUsage: (next) => {
          usage = next;
        },
      });
    } catch (error) {
      finalize(500, error instanceof Error ? error.message : 'Handler error');
      throw error;
    }

    finalize(response.status, response.status >= 400 ? 'request_failed' : null);
    return response;
  };
}
