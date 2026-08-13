import { NextResponse } from 'next/server';

import {
  badRequest,
  errorResponseForMessage,
  guardPermissionsAdmin,
} from '~/app/api/admin/permissions/_lib/route-support';
import { validateMergeIds } from '~/lib/permissions/group-merge';
import { getPermissionGroupMergePreview } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/permissions/groups/:groupId/merge-preview?sourceGroupId=… — dry run of a merge.
 *
 * Read-only, and not in B0-409's listed endpoints: added because it is part of the same c360 route
 * group (`GET /permissions/groups/:groupId/merge-preview`) and B0-410's `MergeGroupDialog` shows the
 * "X users and Y permissions will be added" counts before committing. Gated identically to the
 * mutations — the counts describe the permission graph and are not public.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const denied = await guardPermissionsAdmin(
    'GET /api/admin/permissions/groups/:groupId/merge-preview',
  );
  if (denied) return denied;

  const { groupId } = await context.params;
  const sourceGroupId = new URL(request.url).searchParams.get('sourceGroupId');
  const validation = validateMergeIds(groupId, sourceGroupId ?? '');
  if (!validation.ok) return badRequest(validation.error);

  const result = await getPermissionGroupMergePreview(
    validation.targetGroupId,
    validation.sourceGroupId,
  );
  if (!result.success) {
    return errorResponseForMessage(result.error, 'Failed to preview merge');
  }
  return NextResponse.json({
    success: true,
    usersToAdd: result.usersToAdd,
    permissionsToAdd: result.permissionsToAdd,
    sourceSelector: result.sourceSelector,
    targetSelector: result.targetSelector,
  });
}
