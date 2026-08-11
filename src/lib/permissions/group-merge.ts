/**
 * B0-411: pure validation helpers for the permission-group merge / delete flows.
 *
 * Port of the side-effect-free half of c360's `snowflake-api/src/lib/permissionGroupMerge.ts` and
 * `permissionGroupDelete.ts`. The SQL-builder half of those modules has no equivalent here — the
 * statements now live inside the `merge_permission_groups` /
 * `delete_permission_group_with_resources` Postgres functions so they run in one transaction (see
 * `src/supabase/migrations/20260811100000_permission_group_merge_delete_b0411.sql`).
 *
 * These live outside `repository.ts` because that module is `'use server'`, which may only export
 * async functions.
 */

/** `audit_logs.event_type` written by `merge_permission_groups`. */
export const PERMISSION_GROUP_MERGED_EVENT = 'permission_group.merged';

/** `audit_logs.event_type` written by `delete_permission_group_with_resources`. */
export const PERMISSION_GROUP_DELETED_EVENT = 'permission_group.deleted';

export type MergeIdValidationResult =
  | { ok: true; targetGroupId: string; sourceGroupId: string }
  | { ok: false; error: string };

/**
 * Trim + validate the target/source ids. Port of c360 `validateMergeRequest`: rejects a self-merge
 * (after trimming) with the same user-facing message, and treats non-string input as missing.
 */
export function validateMergeIds(
  rawTargetGroupId: unknown,
  rawSourceGroupId: unknown,
): MergeIdValidationResult {
  const targetGroupId =
    typeof rawTargetGroupId === 'string' ? rawTargetGroupId.trim() : '';
  const sourceGroupId =
    typeof rawSourceGroupId === 'string' ? rawSourceGroupId.trim() : '';

  if (!targetGroupId) return { ok: false, error: 'targetGroupId required' };
  if (!sourceGroupId) return { ok: false, error: 'sourceGroupId required' };
  if (targetGroupId === sourceGroupId) {
    return {
      ok: false,
      error:
        'A group cannot be merged into itself. Choose a different source and target group.',
    };
  }
  return { ok: true, targetGroupId, sourceGroupId };
}

export type GroupIdValidationResult =
  | { ok: true; groupId: string }
  | { ok: false; error: string };

/** Trim + require a group id. Port of c360 `validateGroupId`. */
export function validateGroupId(raw: unknown): GroupIdValidationResult {
  const groupId = typeof raw === 'string' ? raw.trim() : '';
  if (!groupId) return { ok: false, error: 'groupId required' };
  return { ok: true, groupId };
}
