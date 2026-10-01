import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

import { authOptions } from '~/lib/auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import { getTestResultById } from '~/lib/tests/repository';
import { generateAndSaveRunInsights } from '~/lib/tests/run-insights';

export async function POST(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'POST /api/admin/tests/runs/[runId]/insights',
  );
  if (denied) return denied;

  const { runId } = await context.params;

  const run = await getTestResultById(runId).catch(() => null);
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const result = await generateAndSaveRunInsights(runId);

  if (!result.ok) {
    if (result.reason === 'no_items') {
      return NextResponse.json(
        { error: 'No completed items in this run to analyze.' },
        { status: 422 },
      );
    }
    if (result.reason === 'parse_error') {
      return NextResponse.json(
        { error: 'Failed to parse analysis response.' },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: 'Unexpected analysis response shape.' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    insights: result.insights,
    generatedAt: result.generatedAt,
  });
}

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
    'GET /api/admin/tests/runs/[runId]/insights',
  );
  if (denied) return denied;

  const { runId } = await context.params;

  const run = await getTestResultById(runId).catch(() => null);
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    insights: Array.isArray(run.insights) ? run.insights : null,
    generatedAt: run.insights_generated_at,
  });
}
