import { NextResponse } from 'next/server';

import { V1_TOOL_REGISTRY } from '~/lib/tools/tool-registry';
import { withApiV1 } from '~/lib/api/with-api-v1';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lists tools exposed under `/api/v1/tools/*`. Token-authenticated + logged via withApiV1.
 */
export const GET = withApiV1(async () => {
  return NextResponse.json({ ok: true, tools: V1_TOOL_REGISTRY });
});
