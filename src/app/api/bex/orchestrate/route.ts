import { NextResponse } from 'next/server';

import { runOrchestration } from '~/lib/orchestrator/run-orchestration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type RequestBody = {
  message?: unknown;
  workflow?: unknown;
  model?: unknown;
};

export async function POST(request: Request) {
  let body: RequestBody = {};

  try {
    body = (await request.json()) as RequestBody;
  } catch {
    body = {};
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';

  if (!message) {
    return NextResponse.json(
      { error: 'message is required and must be a non-empty string' },
      { status: 400 },
    );
  }

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
