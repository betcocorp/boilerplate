import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { generateCrossValidationReport } from '~/lib/category/cross-validation-report';
import { authOptions } from '~/lib/auth';
import { getErrorMessage } from '~/lib/utils';

export const runtime = 'nodejs';

/**
 * B0-38 — on-demand cross-validation report (unlinked / multi-linked / site-disagreement) as a
 * diffable JSON artifact. Session-auth'd like the other admin tool routes. Site comparison is only
 * run when a live-site placement loader is configured (none in-repo), so the default report covers
 * the legacy-vs-links discrepancies.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const report = await generateCrossValidationReport();
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    return NextResponse.json(
      { error: getErrorMessage(err, 'Cross-validation report failed') },
      { status: 500 },
    );
  }
}
