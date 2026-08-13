import { NextResponse } from 'next/server';

import {
  guardPermissionsAdmin,
  parseJsonBody,
  repositoryFailed,
} from '~/app/api/admin/permissions/_lib/route-support';
import { bulkAssignSchema } from '~/app/api/admin/permissions/_lib/schemas';
import { postPermissionsBulkAssign } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/permissions/users/bulk-assign — add groups/permissions to several users at once,
 * skipping assignments they already hold.
 *
 * `bulkAssignSchema` already guarantees a non-empty `userIds` and at least one target, which are the
 * repository's own two guard conditions — so a `{ success: false }` here can only be a query
 * failure, and 500 is the honest status (unlike the other mutations, which cannot tell).
 */
export async function POST(request: Request) {
  const denied = await guardPermissionsAdmin(
    'POST /api/admin/permissions/users/bulk-assign',
  );
  if (denied) return denied;

  const body = await parseJsonBody(request, bulkAssignSchema);
  if (!body.ok) return body.response;

  const result = await postPermissionsBulkAssign(
    body.data.userIds,
    body.data.permissionGroupIds,
    body.data.permissionIds,
  );
  if (!result.success) return repositoryFailed('Failed to bulk assign');
  return NextResponse.json({
    success: true,
    message: 'Bulk assign complete',
    added: result.added ?? 0,
  });
}
