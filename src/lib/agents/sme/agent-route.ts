import { NextResponse } from 'next/server';

import { authenticateApiToken, unauthorizedResponse } from '~/lib/api/client-auth';

import { runSmeAgent } from './run-sme-agent';
import {
  smeAgentHttpInvokeSchema,
  smeAgentInvokeBodyLooseSchema,
} from './sme-schemas';
import type { SmeAgentId } from './types';

export function createSmeAgentPostHandler(agentId: SmeAgentId) {
  return async function POST(request: Request) {
    const auth = await authenticateApiToken(request);
    if (!auth.ok) {
      return unauthorizedResponse();
    }

    let raw: unknown = {};

    try {
      raw = await request.json();
    } catch {
      raw = {};
    }

    const loose = smeAgentInvokeBodyLooseSchema.parse(raw);
    const parsed = smeAgentHttpInvokeSchema.safeParse(loose);

    if (!parsed.success) {
      const first = parsed.error.issues[0]?.message ?? 'Invalid request body';
      return NextResponse.json(
        { error: first, issues: parsed.error.issues },
        { status: 400 },
      );
    }

    try {
      const result = runSmeAgent(agentId, parsed.data);

      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'SME agent run failed.';

      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}
