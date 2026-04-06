import { NextResponse } from 'next/server';

import { runOrchestration } from '~/lib/orchestrator/run-orchestration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type OrchestratorBody = {
  workflow?: unknown;
  input?: unknown;
};

function isAuthorized(request: Request) {
  const configuredKey = process.env.V1_ORCHESTRATOR_API_KEY;

  if (!configuredKey) {
    return process.env.NODE_ENV !== 'production';
  }

  const authorizationHeader = request.headers.get('authorization');
  const bearerToken = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length)
    : null;

  return bearerToken === configuredKey;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: OrchestratorBody = {};

  try {
    body = (await request.json()) as OrchestratorBody;
  } catch {
    body = {};
  }

  try {
    const result = runOrchestration(
      typeof body.workflow === 'string' ? body.workflow : undefined,
      body.input,
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Orchestration failed.';

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
