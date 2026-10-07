import { describe, expect, it, vi } from 'vitest';

/**
 * B0-655 — regression coverage for the orphaned-parent-row cleanup used by both the CSV and
 * JSON/multi-turn import branches in `~/app/(authenticated)/admin/tests/actions.ts`. Before this,
 * a throw after `createTestRecord` (S3 upload failure, a bad CSV/JSON row) left the just-created
 * `tests` row permanently stuck at `status: 'uploading'`/`row_count: 0` with zero `test_items` —
 * a phantom set nothing could run.
 */

vi.mock('~/lib/observability/logger', () => ({
  logError: vi.fn(),
}));

import { logError } from '~/lib/observability/logger';
import { runCreatedRecordOrCleanup } from '~/lib/tests/upload-cleanup';

describe('runCreatedRecordOrCleanup (B0-655)', () => {
  it('returns the run result and never deletes when run succeeds', async () => {
    const deleteById = vi.fn().mockResolvedValue(undefined);
    const result = await runCreatedRecordOrCleanup({
      create: async () => ({ id: 'test-1' }),
      run: async (created) => `ok:${created.id}`,
      deleteById,
    });

    expect(result).toBe('ok:test-1');
    expect(deleteById).not.toHaveBeenCalled();
  });

  it('deletes the just-created row and rethrows the original error when run throws', async () => {
    const deleteById = vi.fn().mockResolvedValue(undefined);
    const originalError = new Error('S3 upload failed: missing credentials');

    await expect(
      runCreatedRecordOrCleanup({
        create: async () => ({ id: 'test-2' }),
        run: async () => {
          throw originalError;
        },
        deleteById,
      }),
    ).rejects.toBe(originalError);

    expect(deleteById).toHaveBeenCalledTimes(1);
    expect(deleteById).toHaveBeenCalledWith('test-2');
  });

  it('still rethrows the original error, and logs (never throws) when cleanup itself fails', async () => {
    const originalError = new Error('insertTestItems: bad row at index 4');
    const cleanupError = new Error('delete failed: row locked');
    const deleteById = vi.fn().mockRejectedValue(cleanupError);

    await expect(
      runCreatedRecordOrCleanup({
        create: async () => ({ id: 'test-3' }),
        run: async () => {
          throw originalError;
        },
        deleteById,
      }),
    ).rejects.toBe(originalError);

    expect(deleteById).toHaveBeenCalledTimes(1);
    expect(deleteById).toHaveBeenCalledWith('test-3');
    expect(logError).toHaveBeenCalledWith(
      'test_upload_orphan_cleanup_failed',
      expect.objectContaining({
        testId: 'test-3',
        cleanupError: 'delete failed: row locked',
        originalError: 'insertTestItems: bad row at index 4',
      }),
    );
  });

  it('never calls deleteById when create itself throws (nothing was created to clean up)', async () => {
    const deleteById = vi.fn();
    const createError = new Error('duplicate name violates unique constraint');

    await expect(
      runCreatedRecordOrCleanup({
        create: async () => {
          throw createError;
        },
        run: async (created: { id: string }) => created,
        deleteById,
      }),
    ).rejects.toBe(createError);

    expect(deleteById).not.toHaveBeenCalled();
  });
});
