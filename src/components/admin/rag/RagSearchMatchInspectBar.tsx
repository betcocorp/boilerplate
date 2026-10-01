'use client';

import { RagDocumentChunkInspectButtons } from '~/components/rag/RagDocumentChunkInspect';

export function RagSearchMatchInspectBar({
  documentId,
  chunkId,
}: {
  documentId: string;
  chunkId: string;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-slate-100 pt-4">
      <RagDocumentChunkInspectButtons
        documentId={documentId}
        chunkId={chunkId}
        size="sm"
      />
    </div>
  );
}
