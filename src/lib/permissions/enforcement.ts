/**
 * `BEX_PERMISSIONS_ENFORCED` — the single switch for the ported permission system (epic B0-401).
 *
 * Phase 1 ships in **shadow mode**: every enforcement site (API route gates, the admin sidebar,
 * the NextAuth sign-in gate, the auth-user cookie check) computes its verdict and records it, but
 * nothing is denied and nobody can be locked out.
 *
 * | Value                            | Behaviour                                          |
 * | -------------------------------- | -------------------------------------------------- |
 * | unset / anything but `'true'`    | shadow — evaluate + record, always allow            |
 * | `'true'`                         | enforce — deny (403 / sign-in redirect / hidden nav)|
 *
 * The env var is read at **call time** (not module load) so tests and a dev env can flip it, and
 * through a static `process.env.BEX_PERMISSIONS_ENFORCED` property access so it also resolves in
 * the Edge runtime, where dynamic `process.env[key]` lookups are not inlined. Do not import this
 * module from `src/proxy.ts` though — `recordPermissionVerdict` pulls in the Supabase client.
 */

import { writeAuditLog } from '~/lib/audit/audit-log';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { logInfo, logWarn } from '~/lib/observability/logger';

/** Name of the single env var that governs enforcement (for docs/log payloads). */
export const PERMISSIONS_ENFORCED_ENV_VAR = 'BEX_PERMISSIONS_ENFORCED';

/** Structured log event emitted for every verdict, allowed or not. */
export const PERMISSION_VERDICT_LOG_EVENT = 'permission.verdict';

/** `audit_logs.event_type` for a would-be denial recorded while shadow mode is on. */
export const PERMISSION_SHADOW_VERDICT_EVENT = 'permission.shadow_verdict';

/** `audit_logs.event_type` for a denial that was actually served. */
export const PERMISSION_DENIED_EVENT = 'permission.denied';

/**
 * True only when `BEX_PERMISSIONS_ENFORCED` is exactly `'true'`. Everything else — unset, `'1'`,
 * `'TRUE'`, `''` — means shadow mode, so a typo can never lock users out.
 */
export function isPermissionsEnforced(): boolean {
  return process.env.BEX_PERMISSIONS_ENFORCED === 'true';
}

/** Which enforcement site produced the verdict. */
export type PermissionVerdictSurface = 'api' | 'nav' | 'auth';

/** Why the verdict came out the way it did (low cardinality — safe to group by). */
export type PermissionVerdictReason =
  | 'granted'
  | 'missing-permission'
  | 'permissions-unavailable'
  | 'user-not-found'
  | 'account-inactive'
  | 'no-identity'
  | 'lookup-failed';

export type PermissionVerdict = {
  surface: PermissionVerdictSurface;
  /** Selector(s) evaluated: one for a single gate, several for `requireAnyPermission` / the nav. */
  selector: string | string[];
  allowed: boolean;
  reason: PermissionVerdictReason;
  /** Route or surface the check guarded, e.g. `GET /api/bex/conversations`. */
  route?: string;
  /** Effective user (selected user when acting-as, else the auth user). */
  userId?: string | null;
  email?: string | null;
  /** Extra low-cardinality detail merged into the log/audit payload. */
  detail?: Record<string, unknown>;
};

function selectorKey(selector: string | string[]): string {
  return Array.isArray(selector) ? [...selector].sort().join(',') : selector;
}

/**
 * Audit-row de-duplication.
 *
 * Phase 1 needs the *set* of `(user, selector)` pairs that would break when the flag flips — not a
 * row per request. In shadow mode nearly every request by a user missing from the 130-row
 * `app_user` seed is a would-be denial, so "audit row on every deny" would add rows faster than
 * the ~67k already in `audit_logs`. Structured logs stay complete (they are free); the audit table
 * gets at most one row per (mode, surface, user, selector, verdict) per 24h per server instance.
 */
const AUDIT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const AUDIT_DEDUPE_MAX_ENTRIES = 5000;
const auditDedupe = new Map<string, number>();

function shouldWriteAuditRow(key: string, now: number): boolean {
  const seenAt = auditDedupe.get(key);
  if (seenAt !== undefined && now - seenAt < AUDIT_DEDUPE_TTL_MS) return false;

  if (auditDedupe.size >= AUDIT_DEDUPE_MAX_ENTRIES) {
    for (const [k, ts] of auditDedupe) {
      if (now - ts >= AUDIT_DEDUPE_TTL_MS) auditDedupe.delete(k);
    }
    // Still full of live entries: drop the oldest insertions (Map preserves insertion order).
    if (auditDedupe.size >= AUDIT_DEDUPE_MAX_ENTRIES) {
      let toDrop = Math.ceil(AUDIT_DEDUPE_MAX_ENTRIES / 4);
      for (const k of auditDedupe.keys()) {
        if (toDrop-- <= 0) break;
        auditDedupe.delete(k);
      }
    }
  }

  auditDedupe.set(key, now);
  return true;
}

/** Test seam: clears the audit de-duplication window. */
export function resetPermissionVerdictDedupe(): void {
  auditDedupe.clear();
}

/**
 * Record a permission verdict: always a structured log line, plus a de-duplicated `audit_logs`
 * row when the verdict is a denial (whether shadow-allowed or actually served).
 *
 * Never throws — a logging failure must not turn into a request failure.
 */
export async function recordPermissionVerdict(
  verdict: PermissionVerdict,
): Promise<void> {
  const enforced = isPermissionsEnforced();
  const mode = enforced ? 'enforced' : 'shadow';
  const { detail, ...rest } = verdict;
  const fields = {
    ...rest,
    userId: verdict.userId ?? null,
    email: verdict.email ?? null,
    mode,
    enforced,
    /** Whether the request actually proceeded (shadow mode allows denied verdicts through). */
    effect: verdict.allowed ? 'allow' : enforced ? 'deny' : 'shadow-allow',
    ...detail,
  };

  if (verdict.allowed) {
    logInfo(PERMISSION_VERDICT_LOG_EVENT, fields);
    return;
  }

  logWarn(PERMISSION_VERDICT_LOG_EVENT, fields);

  const key = [
    mode,
    verdict.surface,
    verdict.userId ?? verdict.email ?? 'anonymous',
    selectorKey(verdict.selector),
    verdict.reason,
  ].join('|');

  if (!shouldWriteAuditRow(key, Date.now())) return;

  try {
    await writeAuditLog(
      enforced ? PERMISSION_DENIED_EVENT : PERMISSION_SHADOW_VERDICT_EVENT,
      fields,
      { traceId: newCorrelationId() },
    );
  } catch {
    // writeAuditLog already swallows and logs its own failures; belt and braces so a permission
    // check can never fail the request it is only observing.
  }
}
