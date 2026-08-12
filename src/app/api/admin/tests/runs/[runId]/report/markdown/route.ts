import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import { gateRoute } from '~/lib/permissions/route-gate';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { getTestResultById } from '~/lib/tests/repository';

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'GET /api/admin/tests/runs/[runId]/report/markdown',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  const run = await getTestResultById(runId).catch(() => null);
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  if (!run.report_markdown) {
    return NextResponse.json({ error: 'Report not generated yet.' }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    markdown: run.report_markdown,
    generatedAt: run.report_generated_at,
  });
}
