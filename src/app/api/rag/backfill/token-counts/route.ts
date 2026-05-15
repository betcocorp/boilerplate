import { NextResponse } from 'next/server';

import { isRagSyncAuthorized } from '~/lib/api/rag-api-auth';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!isRagSyncAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseServiceRoleClient();

  const { data, error } = await supabase
    .schema('rag')
    .rpc('backfill_token_counts_batch', { p_batch_size: 400 });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
