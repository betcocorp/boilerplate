import { NextResponse } from 'next/server';

import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { isV1BearerAuthorized } from '~/lib/api/v1-bearer-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lists SME agents exposed under `/api/v1/agents/*`.
 */
export async function GET(request: Request) {
  if (!isV1BearerAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({ ok: true, agents: V1_AGENT_REGISTRY });
}
