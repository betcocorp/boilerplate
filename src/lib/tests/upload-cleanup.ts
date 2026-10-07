import { logError } from '~/lib/observability/logger';

/**
 * B0-655 — the CSV and JSON/multi-turn import branches in `~/app/(authenticated)/admin/tests/actions.ts`
 * both call `createTestRecord` (a real, immediately-committed insert) and then run further steps
 * (S3 upload, `insertTestItems`) that can throw. Before this helper, a throw after the parent row was
 * created left it permanently orphaned: `status: 'uploading'`, `row_count: 0`, zero `test_items` —
 * a phantom set that clutters `/admin/tests` and can never be run.
 *
 * `runCreatedRecordOrCleanup` makes that failure mode non-persistent: if `run` throws after `create`
 * succeeds, the just-created row is deleted (its `test_items`/`test_results` cascade via FK — see
 * `20260827010100_b0464_reconcile_test_items_table.sql` / `...test_results_table.sql`) before the
 * original error is rethrown. A failure during cleanup itself is logged, never swallows the original
 * error, and never throws in its place — the caller always sees the real cause (S3 credentials, a bad
 * CSV row, etc.), not a cleanup failure.
 */
export async function runCreatedRecordOrCleanup<TCreated extends { id: string }, TResult>(params: {
  create: () => Promise<TCreated>;
  run: (created: TCreated) => Promise<TResult>;
  deleteById: (id: string) => Promise<void>;
}): Promise<TResult> {
  const created = await params.create();

  try {
    return await params.run(created);
  } catch (error) {
    try {
      await params.deleteById(created.id);
    } catch (cleanupError) {
      logError('test_upload_orphan_cleanup_failed', {
        testId: created.id,
        cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
