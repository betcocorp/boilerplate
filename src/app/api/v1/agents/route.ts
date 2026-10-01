import { NextResponse } from 'next/server';

import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { withApiV1 } from '~/lib/api/with-api-v1';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lists SME agents exposed under `/api/v1/agents/*`. Token-authenticated + logged via withApiV1.
 */
export const GET = withApiV1(async () => {
  return NextResponse.json({ ok: true, agents: V1_AGENT_REGISTRY });
});
