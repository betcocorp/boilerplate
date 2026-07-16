import { NextResponse } from 'next/server';

import { hasBexSession } from '~/lib/api/bex-api-auth';
import {
  getWorkflowRunWithSteps,
  listAuditLogsForRun,
} from '~/lib/conversations/workflow-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: RouteParams) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;

  try {
    const bundle = await getWorkflowRunWithSteps(id);
    if (!bundle) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const audit = await listAuditLogsForRun(id);

    return NextResponse.json({
      ok: true,
      run: bundle.run,
      steps: bundle.steps,
      audit,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load workflow run.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
