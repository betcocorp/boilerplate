import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST() {
  return NextResponse.json(
    { error: 'Legacy chat endpoint is permanently deprecated. Use /api/bex/chat/stream.' },
    { status: 410 },
  );
}
