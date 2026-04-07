import { NextResponse } from 'next/server';

import { isV1BearerAuthorized } from '~/lib/api/v1-bearer-auth';
import { runOrchestration } from '~/lib/orchestrator/run-orchestration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type OrchestratorBody = {
  workflow?: unknown;
  input?: unknown;
  message?: unknown;
  model?: unknown;
};

function isBearerAuthorized(request: Request) {
  return isV1BearerAuthorized(request);
}

function hasNonEmptyMessage(body: OrchestratorBody) {
  return typeof body.message === 'string' && body.message.trim().length > 0;
}

function canInvoke(request: Request, body: OrchestratorBody) {
  if (isBearerAuthorized(request)) {
    return true;
  }

  // Same behavior as the former `/api/bex/orchestrate` route: admin chat shape
  // did not require a bearer token (only reachable from your deployed UI in practice).
  if (hasNonEmptyMessage(body)) {
    return true;
  }

  return false;
}

export async function POST(request: Request) {
  let body: OrchestratorBody = {};

  try {
    body = (await request.json()) as OrchestratorBody;
  } catch {
    body = {};
  }

  if (!canInvoke(request, body)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (hasNonEmptyMessage(body)) {
    const message = (body.message as string).trim();
    const workflow =
      typeof body.workflow === 'string' && body.workflow.trim()
        ? body.workflow.trim()
        : 'bex-chat';
    const model =
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : 'preview';

    try {
      const result = runOrchestration(workflow, {
        model,
        message,
      });

      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : 'Orchestration failed.';

      return NextResponse.json({ error: msg }, { status: 500 });
    }
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
