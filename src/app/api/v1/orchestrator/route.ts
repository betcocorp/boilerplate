import { NextResponse } from 'next/server';

import { withApiV1 } from '~/lib/api/with-api-v1';
import { parseOrchestratorPostBody } from '~/lib/orchestrator/orchestrator-schemas';
import { runOrchestration } from '~/lib/orchestrator/run-orchestration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = withApiV1(async (request, { recordUsage }) => {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = parseOrchestratorPostBody(body);

  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, issues: parsed.issues },
      { status: 400 },
    );
  }

  try {
    const result = await runOrchestration(parsed.workflow, parsed.orchestrationInput);

    // B0-117 — attribute LLM token usage to this request's api_request_log row.
    if (result.productSupport?.usage) {
      recordUsage(result.productSupport.usage);
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Orchestration failed.';

    return NextResponse.json({ error: message }, { status: 500 });
  }
});
