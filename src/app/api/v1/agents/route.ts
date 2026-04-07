import { NextResponse } from 'next/server';

import { isV1BearerAuthorized } from '~/lib/api/v1-bearer-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REGISTRY = [
  {
    id: 'product',
    path: '/api/v1/agents/product',
    label: 'Betco Product Specialist',
    description:
      'Betco product facts, SDS (non-medical), compatibility, catalogs; handoffs to Dilution/Floor when needed (stub).',
  },
  {
    id: 'dilution',
    path: '/api/v1/agents/dilution',
    label: 'Dilution Control Specialist',
    description:
      'Dispenser calibration, proportioners, metering tips, and setup from approved charts (stub).',
  },
  {
    id: 'floor',
    path: '/api/v1/agents/floor',
    label: 'Floor Care Specialist',
    description:
      'Stripping, finishing, burnishing, and floor maintenance programs (stub).',
  },
  {
    id: 'bathroom',
    path: '/api/v1/agents/bathroom',
    label: 'Bathroom specialist',
    description:
      'Restroom cleaning, disinfection, odor control, floor care, and Betco product/procedure guidance (stub).',
  },
] as const;

/**
 * Lists SME agents exposed under `/api/v1/agents/*`.
 */
export async function GET(request: Request) {
  if (!isV1BearerAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({ ok: true, agents: REGISTRY });
}
