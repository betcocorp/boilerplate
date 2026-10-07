import { NextResponse } from 'next/server';

import {
  guardPermissionsAdmin,
  parseIdParam,
  parseJsonBody,
  unresolvedTarget,
} from '~/app/api/admin/permissions/_lib/route-support';
import { permissionUpdateSchema } from '~/app/api/admin/permissions/_lib/schemas';
import {
  deletePermission,
  putPermission,
} from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PUT /api/admin/permissions/:permissionId — update selector/description. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ permissionId: string }> },
) {
  const denied = await guardPermissionsAdmin(
    'PUT /api/admin/permissions/:permissionId',
  );
  if (denied) return denied;

  const { permissionId } = await context.params;
  const id = parseIdParam('permissionId', permissionId);
  if (!id.ok) return id.response;

  const body = await parseJsonBody(request, permissionUpdateSchema);
  if (!body.ok) return body.response;

  const result = await putPermission(id.id, {
    selector: body.data.selector,
    description: body.data.description ?? null,
  });
  if (!result.success) return unresolvedTarget('Permission not found');
  return NextResponse.json({ success: true, message: 'Permission updated' });
}

/**
 * DELETE /api/admin/permissions/:permissionId — soft delete.
 *
 * No body is read: c360's `PermissionDetailClient` sends none, and the repository soft-deletes on
 * the id alone.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ permissionId: string }> },
) {
  const denied = await guardPermissionsAdmin(
    'DELETE /api/admin/permissions/:permissionId',
  );
  if (denied) return denied;

  const { permissionId } = await context.params;
  const id = parseIdParam('permissionId', permissionId);
  if (!id.ok) return id.response;

  const result = await deletePermission(id.id);
  if (!result.success) return unresolvedTarget('Permission not found');
  return NextResponse.json({ success: true, message: 'Permission deleted' });
}
