import { NextResponse } from 'next/server';

import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { authenticateApiToken, unauthorizedResponse } from '~/lib/api/client-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lists SME agents exposed under `/api/v1/agents/*`.
 */
export async function GET(request: Request) {
  const auth = await authenticateApiToken(request);
  if (!auth.ok) {
    return unauthorizedResponse();
  }

  return NextResponse.json({ ok: true, agents: V1_AGENT_REGISTRY });
}
