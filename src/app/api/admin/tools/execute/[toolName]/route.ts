import { NextRequest, NextResponse } from 'next/server';

import { executeProductTool } from '~/lib/tools/product-tools';
import { productSupportTools } from '~/lib/tools/definitions';
import type { ProductToolName } from '~/lib/tools/tool-schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ toolName: string }> },
) {
  try {
    const { toolName } = await params;

    const tool = productSupportTools.find((t) => t.type === 'function' && t.name === toolName);
    if (!tool) {
      return NextResponse.json({ error: `Tool not found: ${toolName}` }, { status: 404 });
    }

    const payload = await request.json();

    const result = await executeProductTool(toolName as ProductToolName, payload);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
