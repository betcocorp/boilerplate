import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { Database as RagDatabase } from '~/types/supabase.rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/rag/document-lookup
 * Resolves product_line_key or sku to their source document IDs.
 * Query params:
 *   - productLineKey (string): Look up product_line_profile documents
 *   - sku (string): Look up label documents
 * Response: { documentId: string | null }
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const productLineKey = searchParams.get('productLineKey');
  const sku = searchParams.get('sku');

  // Validate that exactly one param is provided
  if (!productLineKey && !sku) {
    return NextResponse.json(
      { error: 'Missing required parameter: productLineKey or sku' },
      { status: 400 }
    );
  }

  if (productLineKey && sku) {
    return NextResponse.json(
      { error: 'Cannot specify both productLineKey and sku' },
      { status: 400 }
    );
  }

  try {
    const client = createClient<RagDatabase>(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    );

    let data;

    if (productLineKey) {
      // Look up product_line_profile documents by product_line_key
      const result = await client
        .from('document')
        .select('id')
        .eq('document_kind', 'product_line_profile')
        .eq('metadata->>product_line_key', productLineKey)
        .limit(1)
        .maybeSingle();

      data = result.data;
    } else if (sku) {
      // Look up label documents by sku
      const result = await client
        .from('document')
        .select('id')
        .eq('document_kind', 'label')
        .eq('metadata->>sku', sku)
        .limit(1)
        .maybeSingle();

      data = result.data;
    }

    return NextResponse.json({
      documentId: data?.id || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to look up document', details: message },
      { status: 500 }
    );
  }
}
