import { NextResponse } from 'next/server';

import {
  errorResponseForMessage,
  guardPermissionsAdmin,
  parseIdParam,
  parseJsonBody,
} from '~/app/api/admin/permissions/_lib/route-support';
import { permissionsUserUpdateSchema } from '~/app/api/admin/permissions/_lib/schemas';
import { putPermissionsUser } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /api/admin/permissions/users/:userId — update profile fields.
 *
 * This is the one mutation whose repository envelope distinguishes its failures by message
 * ('User not found' vs 'Failed to update user'), so the status comes from
 * `errorResponseForMessage` rather than being assumed.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const denied = await guardPermissionsAdmin(
    'PUT /api/admin/permissions/users/:userId',
  );
  if (denied) return denied;

  const { userId } = await context.params;
  const id = parseIdParam('userId', userId);
  if (!id.ok) return id.response;

  const body = await parseJsonBody(request, permissionsUserUpdateSchema);
  if (!body.ok) return body.response;

  const result = await putPermissionsUser(id.id, body.data);
  if (!result.success) {
    return errorResponseForMessage(result.error, 'Failed to update user');
  }
  return NextResponse.json({ success: true, message: 'User updated' });
}
