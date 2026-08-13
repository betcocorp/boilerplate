import { NextResponse } from 'next/server';

import { resolveBexActor } from '~/lib/api/bex-api-auth';
import {
  getWorkflowRunWithSteps,
  listAuditLogsForRun,
} from '~/lib/conversations/workflow-repository';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: RouteParams) {
  // Signed-in bex admin (browser) or a valid client token (server-to-server) — nothing else.
  const actor = await resolveBexActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Browser callers only: `requirePermission` reads the NextAuth session, so a service token —
  // which has none — would 401 here even in shadow mode, silently closing the machine path B0-387
  // opened. A token's authorization is the api_key registry chain check it already passed.
  if (actor === 'session') {
    const denied = await gateRoute(
      PERMISSIONS.BEX_CHAT_USE,
      'GET /api/bex/workflow-runs/[id]',
    );
    if (denied) return denied;
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
