import { NextResponse } from 'next/server';

import { isV1BearerAuthorized } from '~/lib/api/v1-bearer-auth';
import { parseOrchestratorPostBody } from '~/lib/orchestrator/orchestrator-schemas';
import { runOrchestration } from '~/lib/orchestrator/run-orchestration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

function isBearerAuthorized(request: Request) {
  return isV1BearerAuthorized(request);
}

function hasNonEmptyMessage(body: unknown) {
  const message = asObject(body).message;
  return typeof message === 'string' && message.trim().length > 0;
}

function canInvoke(request: Request, body: unknown) {
  if (isBearerAuthorized(request)) {
    return true;
  }

  if (hasNonEmptyMessage(body)) {
    return true;
  }

  return false;
}

export async function POST(request: Request) {
  let body: unknown = {};

  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (!canInvoke(request, body)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseOrchestratorPostBody(body);

  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, issues: parsed.issues },
      { status: 400 },
    );
  }

  if (parsed.mode === 'bex-chat') {
    try {
      const result = runOrchestration(parsed.workflow, parsed.orchestrationInput);

      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : 'Orchestration failed.';

      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  try {
    const result = runOrchestration(parsed.workflow, parsed.orchestrationInput);

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Orchestration failed.';

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
