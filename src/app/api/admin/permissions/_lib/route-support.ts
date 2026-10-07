/**
 * B0-409 (epic B0-401): shared plumbing for the `/api/admin/permissions/**` mutation handlers.
 *
 * In c360 these mutations were client `fetch('/api/proxy/permissions/...')` calls through an
 * unauthenticated catch-all proxy (CCA-833). this app has no proxy: each handler is a dedicated route
 * that authenticates the browser session and checks the permission itself, then calls
 * `~/lib/permissions/repository`.
 *
 * Kept in a private `_lib` folder so it is colocated with the routes it serves without becoming a
 * route itself (Next.js excludes `_`-prefixed folders from the router).
 */

import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { z } from 'zod';

import { hasSession } from '~/lib/api/session-auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';

/**
 * Both gates for a permissions-admin route, in order. Returns the response to send when the caller
 * is rejected, or `null` to continue. `route` is the verdict label (e.g.
 * `'PUT /api/admin/permissions/:permissionId'`) recorded by `recordPermissionVerdict`.
 *
 * The two axes fail differently and deliberately so:
 *
 * - **Session** (`hasSession`) is absolute. No NextAuth session -> 401, always, on every method
 *   and path here, independent of any feature flag.
 * - **Permission** (`gateRoute` -> `requirePermission`) is subject to shadow mode (B0-408). While
 *   `PERMISSIONS_ENFORCED` is off, the verdict is evaluated, logged and audited but never
 *   returned as a response, so a signed-in user without `admin.card.permissions` gets through. That
 *   is the point of shadow mode; this call site does not change when the flag flips.
 */
export async function guardPermissionsAdmin(
  route: string,
): Promise<NextResponse | null> {
  if (!(await hasSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return gateRoute(PERMISSIONS.ADMIN_CARD_PERMISSIONS, route);
}

export type ParsedBody<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

/**
 * Read + `safeParse` a JSON request body. Malformed JSON and schema violations are both 400s; only
 * the schema violation carries `issues`, so a client can tell them apart.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<ParsedBody<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 },
      ),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          error: 'Invalid request body',
          issues: parsed.error.issues,
        },
        { status: 400 },
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

export type ParsedId =
  | { ok: true; id: string }
  | { ok: false; response: NextResponse };

/**
 * Trim + require a dynamic route segment. A segment can only be empty when the URL was hand-built,
 * so this mirrors c360's `'<name> required'` 400 rather than 404-ing.
 */
export function parseIdParam(name: string, raw: unknown): ParsedId {
  const parsed = z.string().trim().min(1).safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: `${name} required` },
        { status: 400 },
      ),
    };
  }
  return { ok: true, id: parsed.data };
}

/** 400 for a validation failure the repository/`group-merge` helpers reported by message. */
export function badRequest(error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status: 400 });
}

/**
 * `{ success: false }` with no message from the repository.
 *
 * The repository swallows failures into an empty-but-valid envelope, so "target row missing or
 * soft-deleted" and "the query failed" arrive identically. Every mutation here is scoped to a live
 * row, which makes a missing target by far the likelier cause, and c360 answered 404 for it — so
 * that is the status used. A genuine transport failure therefore also reads as 404 here; the cause
 * is in the server log, which is where the repository put it.
 */
export function unresolvedTarget(error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status: 404 });
}

/** 500 for a repository failure that could not be anything else. */
export function repositoryFailed(error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status: 500 });
}

/**
 * Status for a repository envelope that *did* carry an `error` string (merge/delete/user-update).
 * Those messages come from `group-merge` validation, a `raise exception` inside the Postgres merge
 * functions, or the repository's own fallbacks, so the message is the only signal available.
 */
export function errorResponseForMessage(
  error: string | undefined,
  fallback: string,
): NextResponse {
  const message = error?.trim() ? error : fallback;
  if (/not found/i.test(message)) return unresolvedTarget(message);
  if (/required|merged into itself/i.test(message)) return badRequest(message);
  return repositoryFailed(message);
}
