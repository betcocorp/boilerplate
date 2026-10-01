import { NextResponse } from 'next/server';

import {
  badRequest,
  errorResponseForMessage,
  guardPermissionsAdmin,
} from '~/app/api/admin/permissions/_lib/route-support';
import { validateGroupId } from '~/lib/permissions/group-merge';
import { deletePermissionGroupWithResources } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/admin/permissions/groups/:groupId — hard delete the group and its pivot rows.
 *
 * No body is read. c360 accepted optional `actor*` fields here; the repository resolves the acting
 * admin from the auth cookie instead and never trusts a client-supplied actor.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const denied = await guardPermissionsAdmin(
    'DELETE /api/admin/permissions/groups/:groupId',
  );
  if (denied) return denied;

  const { groupId } = await context.params;
  const validation = validateGroupId(groupId);
  if (!validation.ok) return badRequest(validation.error);

  const result = await deletePermissionGroupWithResources(validation.groupId);
  if (!result.success) {
    return errorResponseForMessage(result.error, 'Failed to delete group');
  }
  return NextResponse.json({
    success: true,
    message: 'Group deleted',
    selector: result.selector ?? null,
    membersRemoved: result.membersRemoved ?? 0,
    permissionsRemoved: result.permissionsRemoved ?? 0,
  });
}
