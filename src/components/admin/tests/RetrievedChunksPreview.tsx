'use client';

import type { RetrievedDocumentChunkRef } from '~/lib/workflows/product-support/product-support-schemas';

import { RagDocumentChunkInspectButtons } from '~/components/rag/RagDocumentChunkInspect';

export function RetrievedChunksPreview({
  chunks,
}: {
  chunks: RetrievedDocumentChunkRef[];
}) {
  if (chunks.length === 0) {
    return <span className="text-slate-400">—</span>;
  }

  return (
    <div className="max-w-[min(280px,100%)] space-y-2 font-mono text-[10px] leading-snug text-slate-700">
      {chunks.map((c, i) => (
        <div
          className="rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1"
          key={`${c.document_id}:${c.chunk_id ?? ''}:${i}`}
        >
          <RagDocumentChunkInspectButtons documentId={c.document_id} chunkId={c.chunk_id} />
        </div>
      ))}
    </div>
  );
}
