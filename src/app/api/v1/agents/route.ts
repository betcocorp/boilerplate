import { NextResponse } from 'next/server';

import { isV1BearerAuthorized } from '~/lib/api/v1-bearer-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REGISTRY = [
  {
    id: 'product',
    path: '/api/v1/agents/product',
    label: 'Product SME',
    description:
      'Product specifications, comparisons, and catalog-aligned guidance (stub).',
  },
  {
    id: 'bathroom',
    path: '/api/v1/agents/bathroom',
    label: 'Bathroom SME',
    description:
      'Bathroom layouts, fixtures, and project-scoping notes (stub).',
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
