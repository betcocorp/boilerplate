import { NextResponse } from 'next/server';
import { z } from 'zod';

import { hasBexSession } from '~/lib/api/bex-api-auth';
import {
  COST_GROUP_BY_VALUES,
  COST_TIME_RANGES,
  getCostMetrics,
} from '~/lib/observability/cost-metrics';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const costMetricsQuerySchema = z.object({
  timeRange: z.enum(COST_TIME_RANGES).default('1d'),
  groupBy: z.enum(COST_GROUP_BY_VALUES).default('day'),
  compareYoY: z.coerce.boolean().default(false),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
});

export async function GET(request: Request) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_COST,
    'GET /api/bex/cost/metrics',
  );
  if (denied) return denied;

  const url = new URL(request.url);
  const parsedQuery = costMetricsQuerySchema.safeParse({
    timeRange: url.searchParams.get('timeRange') ?? undefined,
    groupBy: url.searchParams.get('groupBy') ?? undefined,
    compareYoY: url.searchParams.get('compareYoY') ?? undefined,
    startDate: url.searchParams.get('startDate') ?? undefined,
    endDate: url.searchParams.get('endDate') ?? undefined,
  });

  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: 'Invalid query parameters', issues: parsedQuery.error.issues },
      { status: 400 },
    );
  }

  try {
    const metrics = await getCostMetrics(parsedQuery.data);
    return NextResponse.json({ ok: true, metrics });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load cost metrics.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
