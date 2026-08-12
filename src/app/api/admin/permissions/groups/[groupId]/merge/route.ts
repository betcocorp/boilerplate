import { NextResponse } from 'next/server';

import {
  badRequest,
  errorResponseForMessage,
  guardPermissionsAdmin,
  parseJsonBody,
} from '~/app/api/admin/permissions/_lib/route-support';
import { groupMergeSchema } from '~/app/api/admin/permissions/_lib/schemas';
import { validateMergeIds } from '~/lib/permissions/group-merge';
import { mergePermissionGroups } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/permissions/groups/:groupId/merge — merge `sourceGroupId` into this (target)
 * group. `deleteSource` defaults to true (a recoverable soft delete of the source).
 *
 * `validateMergeIds` runs here as well as in the repository so a self-merge or a missing id is a
 * 400 before any DB work, with c360's exact message.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const denied = await guardPermissionsAdmin(
    'POST /api/admin/permissions/groups/:groupId/merge',
  );
  if (denied) return denied;

  const body = await parseJsonBody(request, groupMergeSchema);
  if (!body.ok) return body.response;

  const { groupId } = await context.params;
  const validation = validateMergeIds(groupId, body.data.sourceGroupId);
  if (!validation.ok) return badRequest(validation.error);

  const result = await mergePermissionGroups({
    targetGroupId: validation.targetGroupId,
    sourceGroupId: validation.sourceGroupId,
    deleteSource: body.data.deleteSource,
  });
  if (!result.success) {
    return errorResponseForMessage(result.error, 'Failed to merge groups');
  }
  return NextResponse.json({
    success: true,
    message: 'Groups merged',
    usersMerged: result.usersMerged ?? 0,
    permissionsMerged: result.permissionsMerged ?? 0,
    deletedSource: result.deletedSource ?? false,
    sourceSelector: result.sourceSelector ?? null,
    targetSelector: result.targetSelector ?? null,
  });
}
