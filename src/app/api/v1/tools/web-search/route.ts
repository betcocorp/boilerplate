import { NextResponse } from 'next/server';

import { authenticateApiToken, unauthorizedResponse } from '~/lib/api/client-auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { WebSearchService } from '~/lib/websearch/web-search-service';
import { WebSearchError } from '~/lib/websearch/types';
import { webSearchRequestSchema } from '~/lib/websearch/websearch-schemas';
import { getErrorMessage } from '~/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Web search exposed as a client-authenticated tool under `/api/v1/tools/*`.
 *
 * Same wrapper as `/api/admin/web-search`, but behind a client token
 * (server-to-server) instead of a NextAuth session. All provider logic,
 * caching, source-trust ranking, and rate-limit/cost guardrails live in
 * {@link WebSearchService} — the route only authenticates, validates, and maps errors.
 */
export async function POST(request: Request) {
  const auth = await authenticateApiToken(request);
  if (!auth.ok) {
    return unauthorizedResponse();
  }

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
    const service = new WebSearchService();
    const result = await service.search(parsed.data);

    await writeAuditLog(
      'web_search',
      {
        source: 'v1_tool',
        project_id: auth.context.projectId,
        app_id: auth.context.appId,
        key_id: auth.context.keyId,
        query: parsed.data.query,
        provider: result.provider,
        depth: parsed.data.depth ?? 'basic',
        result_count: result.metrics.resultCount,
        latency_ms: result.metrics.latencyMs,
        estimated_cost_usd: result.metrics.estimatedCostUsd,
      },
      { traceId, toolName: 'web_search' },
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
