import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import { runCrossReferenceRecommendation } from '~/lib/recommendations/persist-recommendation';
import { recommendCrossReferenceInputSchema } from '~/lib/tools/tool-schemas';
import { getErrorMessage } from '~/lib/utils';

export const runtime = 'nodejs';

/**
 * B0-94 — admin tester endpoint for the web-grounded cross-reference recommendation. Session-auth'd
 * (same NextAuth pattern as the other admin tool routes); computes + persists the recommendation
 * (B0-89) and returns the result with its `recommendationId`.
 */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_TOOLS,
    'POST /api/admin/tools/cross-reference-recommend',
  );
  if (denied) return denied;

  const raw = await request.json().catch(() => null);
  const parsed = recommendCrossReferenceInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const traceId = newCorrelationId();
  try {
    const result = await runCrossReferenceRecommendation(
      {
        competitorProduct: parsed.data.competitorProduct,
        competitorBrand: parsed.data.competitorBrand ?? null,
      },
      { traceId, createdBy: session.user.email ?? 'admin' },
    );

    const maxResults = parsed.data.maxResults ?? 5;
    return NextResponse.json({
      ok: true,
      ...result,
      candidates: result.candidates.slice(0, maxResults),
    });
  } catch (err) {
    return NextResponse.json(
      { error: getErrorMessage(err, 'Cross-reference recommendation failed') },
      { status: 500 },
    );
  }
}
