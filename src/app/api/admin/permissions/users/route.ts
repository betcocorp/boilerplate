import { NextResponse } from 'next/server';

import {
  guardPermissionsAdmin,
  parseJsonBody,
  repositoryFailed,
} from '~/app/api/admin/permissions/_lib/route-support';
import { permissionsUserCreateSchema } from '~/app/api/admin/permissions/_lib/schemas';
import { postPermissionsUser } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/admin/permissions/users — create an app user. */
export async function POST(request: Request) {
  const denied = await guardPermissionsAdmin(
    'POST /api/admin/permissions/users',
  );
  if (denied) return denied;

  const body = await parseJsonBody(request, permissionsUserCreateSchema);
  if (!body.ok) return body.response;

  const result = await postPermissionsUser({
    name: body.data.name,
    email: body.data.email,
  });
  if (!result.success) {
    return repositoryFailed(result.error ?? 'Failed to create user');
  }
  return NextResponse.json(
    { success: true, data: result.data },
    { status: 201 },
  );
}
