import { NextResponse } from 'next/server';

import { authenticateApiToken, unauthorizedResponse } from '~/lib/api/client-auth';
import { parseOrchestratorPostBody } from '~/lib/orchestrator/orchestrator-schemas';
import { runOrchestration } from '~/lib/orchestrator/run-orchestration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  const auth = await authenticateApiToken(request);
  if (!auth.ok) {
    return unauthorizedResponse();
  }

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

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Orchestration failed.';

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
