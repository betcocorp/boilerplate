import { NextResponse } from 'next/server';

import {
  guardPermissionsAdmin,
  parseJsonBody,
  repositoryFailed,
} from '~/app/api/admin/permissions/_lib/route-support';
import { permissionCreateSchema } from '~/app/api/admin/permissions/_lib/schemas';
import { postPermission } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/admin/permissions — create a permission. Port of c360 `POST /permissions`. */
export async function POST(request: Request) {
  const denied = await guardPermissionsAdmin(
    'POST /api/admin/permissions',
  );
  if (denied) return denied;

  const body = await parseJsonBody(request, permissionCreateSchema);
  if (!body.ok) return body.response;

  const result = await postPermission({
    selector: body.data.selector,
    description: body.data.description ?? null,
  });
  if (!result.success) {
    return repositoryFailed(result.error ?? 'Failed to create permission');
  }
  return NextResponse.json(
    { success: true, data: result.data },
    { status: 201 },
  );
}
