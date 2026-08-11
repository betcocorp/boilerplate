import { NextResponse } from 'next/server';

import {
  guardPermissionsAdmin,
  parseIdParam,
  parseJsonBody,
  unresolvedTarget,
} from '~/app/api/admin/permissions/_lib/route-support';
import { groupPermissionsSchema } from '~/app/api/admin/permissions/_lib/schemas';
import { putPermissionGroupPermissions } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /api/admin/permissions/groups/:groupId/permissions — replace only the group's permissions
 * (members are untouched).
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  const denied = await guardPermissionsAdmin(
    'PUT /api/admin/permissions/groups/:groupId/permissions',
  );
  if (denied) return denied;

  const { groupId } = await context.params;
  const id = parseIdParam('groupId', groupId);
  if (!id.ok) return id.response;

  const body = await parseJsonBody(request, groupPermissionsSchema);
  if (!body.ok) return body.response;

  const result = await putPermissionGroupPermissions(
    id.id,
    body.data.permissionIds,
  );
  if (!result.success) return unresolvedTarget('Permission group not found');
  return NextResponse.json({
    success: true,
    message: 'Permissions updated',
    count: result.count ?? 0,
  });
}
