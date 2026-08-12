import { NextResponse } from 'next/server';

import {
  guardPermissionsAdmin,
  parseJsonBody,
  repositoryFailed,
} from '~/app/api/admin/permissions/_lib/route-support';
import { permissionGroupCreateSchema } from '~/app/api/admin/permissions/_lib/schemas';
import { postPermissionGroup } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/admin/permissions/groups — create a permission group. */
export async function POST(request: Request) {
  const denied = await guardPermissionsAdmin(
    'POST /api/admin/permissions/groups',
  );
  if (denied) return denied;

  const body = await parseJsonBody(request, permissionGroupCreateSchema);
  if (!body.ok) return body.response;

  const result = await postPermissionGroup({
    selector: body.data.selector,
    description: body.data.description ?? null,
    startAt: body.data.startAt ?? null,
    endAt: body.data.endAt ?? null,
  });
  if (!result.success) {
    return repositoryFailed(result.error ?? 'Failed to create permission group');
  }
  return NextResponse.json(
    { success: true, data: result.data },
    { status: 201 },
  );
}
