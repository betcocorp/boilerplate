import { NextResponse } from 'next/server';

import {
  guardPermissionsAdmin,
  parseIdParam,
  parseJsonBody,
  unresolvedTarget,
} from '~/app/api/admin/permissions/_lib/route-support';
import { groupAssignmentsSchema } from '~/app/api/admin/permissions/_lib/schemas';
import { putGroupAssignments } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /api/admin/permissions/groups/:groupId/assignments — replace the group's members and
 * permissions with the two lists in the body.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const denied = await guardPermissionsAdmin(
    'PUT /api/admin/permissions/groups/:groupId/assignments',
  );
  if (denied) return denied;

  const { groupId } = await context.params;
  const id = parseIdParam('groupId', groupId);
  if (!id.ok) return id.response;

  const body = await parseJsonBody(request, groupAssignmentsSchema);
  if (!body.ok) return body.response;

  const result = await putGroupAssignments(
    id.id,
    body.data.userIds,
    body.data.permissionIds,
  );
  if (!result.success) return unresolvedTarget('Permission group not found');
  return NextResponse.json({
    success: true,
    message: 'Group assignments updated',
    userIdCount: body.data.userIds.length,
    permissionCount: body.data.permissionIds.length,
  });
}
