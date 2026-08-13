import { NextResponse } from 'next/server';

import {
  guardPermissionsAdmin,
  parseIdParam,
  parseJsonBody,
  unresolvedTarget,
} from '~/app/api/admin/permissions/_lib/route-support';
import { userAssignmentsSchema } from '~/app/api/admin/permissions/_lib/schemas';
import { putPermissionsUserAssignments } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /api/admin/permissions/users/:userId/assignments — replace the user's group and direct
 * permission assignments.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const denied = await guardPermissionsAdmin(
    'PUT /api/admin/permissions/users/:userId/assignments',
  );
  if (denied) return denied;

  const { userId } = await context.params;
  const id = parseIdParam('userId', userId);
  if (!id.ok) return id.response;

  const body = await parseJsonBody(request, userAssignmentsSchema);
  if (!body.ok) return body.response;

  const result = await putPermissionsUserAssignments(
    id.id,
    body.data.permissionGroupIds,
    body.data.permissionIds,
  );
  if (!result.success) return unresolvedTarget('User not found');
  return NextResponse.json({ success: true, message: 'Assignments updated' });
}
