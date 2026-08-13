'use client';

import type { RetrievedDocumentChunkRef } from '~/lib/workflows/product-support/product-support-schemas';

import { RagDocumentChunkInspectButtons } from '~/components/rag/RagDocumentChunkInspect';
import { isRagRowId } from '~/lib/rag/document-chunk-types';

export function RetrievedChunksPreview({
  chunks,
  prodLineIdByProductLineKey = {},
}: {
  chunks: RetrievedDocumentChunkRef[];
  /** B0-455 — legacy ERP product-line code by `product_line_key`, for the chunk row display. */
  prodLineIdByProductLineKey?: Record<string, string | null>;
}) {
  if (chunks.length === 0) {
    return <span className="text-slate-400">—</span>;
  }

  return (
    <div className="max-h-[50vh] min-w-0 w-full overflow-x-hidden overflow-y-auto overscroll-y-contain font-mono text-[10px] leading-snug text-slate-700">
      <div className="min-w-0 space-y-2 pr-0.5">
        {chunks.map((c, i) => {
          // Synthetic sources (e.g. the structured "Verified Product Facts" source, B0-196)
          // have no rag.document row to inspect — document_id/chunk_id are placeholder ids,
          // so skip the DB-backed inspect buttons or the dialog 404s ("Document not found").
          const isFacts = !isRagRowId(c.document_id);
          const prodLineId = c.product_line_key
            ? (prodLineIdByProductLineKey[c.product_line_key] ?? null)
            : null;
          return (
            <div
              className="min-w-0 max-w-full rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1"
              key={`${c.document_id}:${c.chunk_id ?? ''}:${i}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="min-w-0 truncate text-slate-700">
                  {c.document_title ?? c.document_id}
                </span>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[9px] uppercase tracking-wide text-slate-500">
                  {c.document_kind ?? (isFacts ? 'synthetic' : '—')}
                </span>
              </div>
              <div className="mt-0.5 text-slate-400">
                Product line: {c.product_line_key ?? '—'} · Line ID: {prodLineId ?? '—'}
              </div>
              {isFacts ? (
                <div className="mt-0.5 text-slate-400">
                  not a stored document — no inspect available
                </div>
              ) : (
                <RagDocumentChunkInspectButtons
                  className="mt-1 min-w-0 w-full max-w-full"
                  documentId={c.document_id}
                  chunkId={c.chunk_id}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
