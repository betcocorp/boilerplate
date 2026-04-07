import { NextResponse } from 'next/server';

import { isV1BearerAuthorized } from '~/lib/api/v1-bearer-auth';

import { runSmeAgent } from './run-sme-agent';
import type { SmeAgentId, SmeAgentInvokeBody } from './types';

export function createSmeAgentPostHandler(agentId: SmeAgentId) {
  return async function POST(request: Request) {
    if (!isV1BearerAuthorized(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: SmeAgentInvokeBody = {};

    try {
      body = (await request.json()) as SmeAgentInvokeBody;
    } catch {
      body = {};
    }

    const query = typeof body.query === 'string' ? body.query.trim() : '';

    if (!query) {
      return NextResponse.json(
        { error: 'query is required and must be a non-empty string' },
        { status: 400 },
      );
    }

    try {
      const result = runSmeAgent(agentId, body);

      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'SME agent run failed.';

      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}
