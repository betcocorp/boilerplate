import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import {
  isRagRowId,
  type RagDocumentChunkApiChunk,
  type RagDocumentChunkApiDocument,
  type RagDocumentChunkApiResponse,
} from '~/lib/rag/document-chunk-types';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DocumentRow = RagDocumentChunkApiDocument;

type ChunkRow = RagDocumentChunkApiChunk;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const documentId = url.searchParams.get('documentId')?.trim();
  const chunkId = url.searchParams.get('chunkId')?.trim() || null;

  if (!documentId) {
    return NextResponse.json(
      { error: 'Missing required query parameter: documentId' },
      { status: 400 },
    );
  }

  // Synthetic sources (e.g. the structured "Verified Product Facts" source) are not
  // rag.document rows. Guard the uuid columns so a non-uuid id returns a clean 404
  // instead of a raw Postgres "invalid input syntax for type uuid" error.
  if (!isRagRowId(documentId)) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }
  if (chunkId && !isRagRowId(chunkId)) {
    return NextResponse.json({ error: 'Chunk not found' }, { status: 404 });
  }

  const supabase = getSupabaseServiceRoleClient();
  const rag = supabase.schema('rag');

  const { data: document, error: docError } = await rag
    .from('document')
    .select(
      [
        'id',
        'title',
        'document_key',
        'document_kind',
        'language_code',
        'summary',
        'body_text',
        'body_markdown',
        'metadata',
        'token_count',
        'created_at',
        'updated_at',
        'entity_id',
        'source_record_id',
      ].join(', '),
    )
    .eq('id', documentId)
    .maybeSingle();

  if (docError) {
    return NextResponse.json(
      { error: docError.message || 'Failed to load document' },
      { status: 500 },
    );
  }

  if (!document) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  let chunk: ChunkRow | null = null;

  if (chunkId) {
    const { data: chunkRow, error: chunkError } = await rag
      .from('document_chunk')
      .select(
        [
          'id',
          'document_id',
          'chunk_index',
          'chunk_key',
          'chunk_text',
          'heading',
          'section_path',
          'token_count',
          'metadata',
          'created_at',
          'updated_at',
        ].join(', '),
      )
      .eq('id', chunkId)
      .maybeSingle();

    if (chunkError) {
      return NextResponse.json(
        { error: chunkError.message || 'Failed to load chunk' },
        { status: 500 },
      );
    }

    if (!chunkRow) {
      return NextResponse.json({ error: 'Chunk not found' }, { status: 404 });
    }

    const chunkTyped = chunkRow as unknown as ChunkRow;
    if (chunkTyped.document_id !== documentId) {
      return NextResponse.json(
        { error: 'Chunk does not belong to this document' },
        { status: 400 },
      );
    }

    chunk = chunkTyped;
  }

  const payload: RagDocumentChunkApiResponse = {
    document: document as unknown as DocumentRow,
    chunk,
  };

  return NextResponse.json(payload);
}
