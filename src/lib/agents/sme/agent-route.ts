import { NextResponse } from 'next/server';

import { withApiV1 } from '~/lib/api/with-api-v1';

import { runSmeAgent } from './run-sme-agent';
import {
  smeAgentHttpInvokeSchema,
  smeAgentInvokeBodyLooseSchema,
} from './sme-schemas';
import type { SmeAgentId } from './types';

export function createSmeAgentPostHandler(agentId: SmeAgentId) {
  return withApiV1(async (request, { recordUsage }) => {
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
      const result = await runSmeAgent(agentId, parsed.data);

      // B0-117 — attribute LLM token usage to this request's api_request_log row, same as
      // `/api/v1/orchestrator` does for `productSupport.usage`. Absent for the `recommendations`
      // stub and for any real-workflow agent run whose workflow didn't report usage.
      if (result.answer?.usage) {
        recordUsage(result.answer.usage);
      }

      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'SME agent run failed.';

      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
