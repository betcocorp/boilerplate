import { describe, expect, it } from 'vitest';

import {
  PERMISSION_GROUP_DELETED_EVENT,
  PERMISSION_GROUP_MERGED_EVENT,
  validateGroupId,
  validateMergeIds,
} from './group-merge';

/**
 * B0-411: port of c360's `permissionGroupMerge.test.ts` / `permissionGroupDelete.test.ts` validation
 * suites. The SQL-builder assertions in those files have no counterpart — the statements moved into
 * the `merge_permission_groups` / `delete_permission_group_with_resources` Postgres functions, whose
 * behaviour is covered by `repository.test.ts` (rpc wiring) and by the migration's live verification.
 */

describe('validateMergeIds', () => {
  it('trims and accepts distinct ids', () => {
    expect(validateMergeIds('  target-1 ', 'source-1 ')).toEqual({
      ok: true,
      targetGroupId: 'target-1',
      sourceGroupId: 'source-1',
    });
  });

  it('rejects a missing target', () => {
    expect(validateMergeIds('', 'source-1')).toEqual({
      ok: false,
      error: 'targetGroupId required',
    });
  });

  it('rejects a missing source', () => {
    expect(validateMergeIds('target-1', '   ')).toEqual({
      ok: false,
      error: 'sourceGroupId required',
    });
  });

  it('rejects a self-merge (source == target) after trimming', () => {
    const result = validateMergeIds('group-1', ' group-1 ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/cannot be merged into itself/i);
    }
  });

  it('rejects non-string input', () => {
    expect(validateMergeIds(null, undefined).ok).toBe(false);
    expect(validateMergeIds(42, {}).ok).toBe(false);
  });
});

describe('validateGroupId', () => {
  it('trims and accepts a non-empty id', () => {
    expect(validateGroupId('  group-1 ')).toEqual({
      ok: true,
      groupId: 'group-1',
    });
  });

  it('rejects empty / non-string input', () => {
    expect(validateGroupId('   ')).toEqual({
      ok: false,
      error: 'groupId required',
    });
    expect(validateGroupId(null).ok).toBe(false);
    expect(validateGroupId(123).ok).toBe(false);
  });
});

describe('audit event types', () => {
  it('are the bex audit_logs event_type values the Postgres functions insert', () => {
    expect(PERMISSION_GROUP_MERGED_EVENT).toBe('permission_group.merged');
    expect(PERMISSION_GROUP_DELETED_EVENT).toBe('permission_group.deleted');
  });
});
