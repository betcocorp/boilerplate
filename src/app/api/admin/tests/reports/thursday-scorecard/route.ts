import { getServerSession } from 'next-auth';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { APP_VERSION } from '~/lib/app-version';
import { authOptions } from '~/lib/auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import { loadThursdayScorecard } from '~/lib/tests/thursday-scorecard';
import {
  buildThursdayScorecardJson,
  renderThursdayScorecardMarkdown,
  sanitizeFilename,
  thursdayScorecardExportFileBase,
} from '~/lib/tests/thursday-scorecard-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'GET /api/admin/tests/reports/thursday-scorecard';

const scorecardExportParamsSchema = z.object({
  format: z.enum(['markdown', 'json']),
  sweepId: z.string().min(1).optional(),
});

/**
 * GET /api/admin/tests/reports/thursday-scorecard?sweepId=…&format=markdown|json
 *
 * B0-1168 — the scorecard's Markdown and JSON exports, rendered from the same
 * `loadThursdayScorecard` snapshot the page table reads, so the file can never disagree with the
 * screen. Session + sidebar-tests gate, as the per-run report routes.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(PERMISSIONS.NAVIGATION_SIDEBAR_TESTS, ROUTE);
  if (denied) return denied;

  const rawFormat = request.nextUrl.searchParams.get('format');
  const rawSweepId = request.nextUrl.searchParams.get('sweepId');
  const parsed = scorecardExportParamsSchema.safeParse({
    format: rawFormat === null ? undefined : rawFormat,
    sweepId: rawSweepId === null ? undefined : rawSweepId,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid export parameters', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { format, sweepId } = parsed.data;

  const data = await loadThursdayScorecard({ sweepId: sweepId ?? null, includeSupporting: true });
  const snapshot = data.snapshot;
  if (!snapshot) {
    return NextResponse.json({ error: 'No Thursday-night sweep recorded yet.' }, { status: 404 });
  }
  // The loader degrades to the newest sweep for an unknown id; an export must never hand back a
  // different Thursday than the one asked for.
  if (sweepId !== undefined && snapshot.sweep.id !== sweepId) {
    return NextResponse.json({ error: 'Sweep not found' }, { status: 404 });
  }

  const fileBase = sanitizeFilename(thursdayScorecardExportFileBase(snapshot));

  if (format === 'markdown') {
    return NextResponse.json({
      ok: true,
      markdown: renderThursdayScorecardMarkdown(snapshot),
      fileBase,
    });
  }

  const document = buildThursdayScorecardJson(snapshot, {
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
  });
  return NextResponse.json(document, {
    headers: { 'Content-Disposition': `attachment; filename="${fileBase}.json"` },
  });
}
