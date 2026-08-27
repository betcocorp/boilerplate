import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import { gateRoute } from '~/lib/permissions/route-gate';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { loadReportData } from '~/lib/tests/report/assemble';
import { reportDataResponseSchema } from '~/lib/tests/report/data-schemas';

/**
 * B0-586 — the run report as structured data (the Markdown endpoint next door is untouched).
 * Both are assembled by `assembleReportCases`, so they can never disagree.
 *
 * A run with no finished report answers 200 with `{ status: 'not_generated', ... }`, not a 404 —
 * the verdict-first UI branches on that state rather than treating it as an error.
 */
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
    'GET /api/admin/tests/runs/[runId]/report/data',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  const payload = await loadReportData(runId);
  if (!payload) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const parsed = reportDataResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Report data failed validation.', issues: parsed.error.issues },
      { status: 500 },
    );
  }

  return NextResponse.json(parsed.data);
}
