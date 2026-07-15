import { NextResponse } from 'next/server';

import {
  extractBearerToken,
  hashApiToken,
  looksLikeApiToken,
} from '~/lib/api/api-tokens';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * Client-token authentication for `/api/v1/*`.
 *
 * Verifies the presented bearer token against the project/app/token registry
 * with a chain check: the token must exist and be neither revoked nor expired,
 * its app must be active, and its project must be active. Any break in the
 * chain fails closed. Callers receive a single uniform 401 (see
 * {@link unauthorizedResponse}) — the specific `reason` is for internal
 * observability only and must never be surfaced to the caller.
 *
 * A chain failure on a *resolvable-but-dead* token (revoked, expired, or under a
 * deactivated app/project) carries `attribution` so the request logger (B0-117)
 * can record the attempt — that is how a stale or stolen token shows up. Failures
 * with no resolvable token (missing/malformed/unknown) carry no attribution and
 * so never create orphan log rows.
 */

export interface ApiAuthContext {
  keyId: string;
  appId: string;
  projectId: string;
  /** Per-app rate limit (requests/minute); null = unlimited (B0-119). */
  rateLimitPerMinute: number | null;
}

/** Best-effort project/app/token identity for logging a failed-but-resolvable attempt. */
export interface ApiLogAttribution {
  keyId: string;
  appId: string | null;
  projectId: string | null;
}

export type ApiAuthFailureReason =
  | 'missing_token'
  | 'malformed_token'
  | 'unknown_token'
  | 'revoked'
  | 'expired'
  | 'app_inactive'
  | 'project_inactive'
  | 'lookup_error';

export type ApiAuthResult =
  | { ok: true; context: ApiAuthContext }
  | { ok: false; reason: ApiAuthFailureReason; attribution?: ApiLogAttribution };

export async function authenticateApiToken(
  request: Request,
): Promise<ApiAuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return { ok: false, reason: 'missing_token' };
  }
  if (!looksLikeApiToken(token)) {
    return { ok: false, reason: 'malformed_token' };
  }

  const supabase = getSupabaseServiceRoleClient();
  const tokenHash = hashApiToken(token);

  const { data: key, error: keyError } = await supabase
    .from('api_key')
    .select('id, app_id, revoked_at, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (keyError) {
    return { ok: false, reason: 'lookup_error' };
  }
  if (!key) {
    return { ok: false, reason: 'unknown_token' };
  }
  // From here the token resolves to a real key, so failures carry attribution.
  if (key.revoked_at) {
    return {
      ok: false,
      reason: 'revoked',
      attribution: { keyId: key.id, appId: key.app_id, projectId: null },
    };
  }
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) {
    return {
      ok: false,
      reason: 'expired',
      attribution: { keyId: key.id, appId: key.app_id, projectId: null },
    };
  }

  const { data: app, error: appError } = await supabase
    .from('api_app')
    .select('id, project_id, is_active, rate_limit_per_minute')
    .eq('id', key.app_id)
    .maybeSingle();

  if (appError) {
    return { ok: false, reason: 'lookup_error' };
  }
  if (!app || !app.is_active) {
    return {
      ok: false,
      reason: 'app_inactive',
      attribution: {
        keyId: key.id,
        appId: app?.id ?? key.app_id,
        projectId: app?.project_id ?? null,
      },
    };
  }

  const { data: project, error: projectError } = await supabase
    .from('api_project')
    .select('id, is_active')
    .eq('id', app.project_id)
    .maybeSingle();

  if (projectError) {
    return { ok: false, reason: 'lookup_error' };
  }
  if (!project || !project.is_active) {
    return {
      ok: false,
      reason: 'project_inactive',
      attribution: {
        keyId: key.id,
        appId: app.id,
        projectId: project?.id ?? app.project_id,
      },
    };
  }

  return {
    ok: true,
    context: {
      keyId: key.id,
      appId: app.id,
      projectId: project.id,
      rateLimitPerMinute: app.rate_limit_per_minute,
    },
  };
}

/** The single response every unauthenticated `/api/v1/*` caller receives. */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
