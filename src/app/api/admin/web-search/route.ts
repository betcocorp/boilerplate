import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import { createWebSearchService } from '~/lib/websearch/web-search-service';
import { WebSearchError } from '~/lib/websearch/types';
import { webSearchRequestSchema } from '~/lib/websearch/websearch-schemas';
import { getErrorMessage } from '~/lib/utils';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_TOOLS,
    'POST /api/admin/web-search',
  );
  if (denied) return denied;

  const raw = await request.json().catch(() => null);
  const parsed = webSearchRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const traceId = newCorrelationId();
  try {
    const service = await createWebSearchService();
    const result = await service.search(parsed.data);

    await writeAuditLog(
      'web_search',
      {
        query: parsed.data.query,
        provider: result.provider,
        depth: parsed.data.depth ?? 'basic',
        result_count: result.metrics.resultCount,
        latency_ms: result.metrics.latencyMs,
        estimated_cost_usd: result.metrics.estimatedCostUsd,
      },
      { traceId },
    );

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WebSearchError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: getErrorMessage(err, 'Web search failed') },
      { status: 500 },
    );
  }
}
