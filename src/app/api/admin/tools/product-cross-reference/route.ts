import { getErrorMessage } from '~/lib/utils';
import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import { lookupCrossReference } from '~/lib/tools/cross-reference-lookup';
import { lookupCrossReferenceInputSchema } from '~/lib/tools/tool-schemas';

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = lookupCrossReferenceInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await lookupCrossReference(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    const message = getErrorMessage(err, 'Cross-reference lookup failed');
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
