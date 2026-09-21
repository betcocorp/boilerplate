/**
 * B0-418 — the chunks the run retrieved (`final_output.retrieved_document_chunks`,
 * with the legacy `sources` fallback), collapsed by default so it never pushes the
 * answer and timeline down the page.
 *
 * Reuses `RetrievedChunksPreview` from the tests pages as-is — including its
 * synthetic-source handling and per-chunk inspect dialogs — rather than adding a
 * second chunk viewer. Native `<details>`, matching the collapsible pattern already
 * used on `/admin/tests`, so the section needs no client-side state of its own.
 */

import { ChevronDownIcon } from 'lucide-react';
import { RetrievedChunksPreview } from '~/components/admin/tests/RetrievedChunksPreview';

import type { RetrievedDocumentChunkRef } from '~/lib/workflows/product-support/product-support-schemas';

type Props = {
  chunks: RetrievedDocumentChunkRef[];
  /** B0-455 — legacy ERP product-line code by `product_line_key`, for the chunk row display. */
  prodLineIdByProductLineKey?: Record<string, string | null>;
};

export function RunRetrievedChunksPanel({
  chunks,
  prodLineIdByProductLineKey = {},
}: Props) {
  return (
    <details className="group overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-8 py-6 hover:bg-slate-50">
        <h2 className="text-lg font-semibold text-slate-900">
          Retrieved chunks
        </h2>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-medium tabular-nums text-slate-500">
          {chunks.length}
        </span>
        <span className="ml-auto text-xs text-slate-500">
          <ChevronDownIcon
            aria-hidden
            className="size-4 shrink-0 transition-transform duration-300 group-open:rotate-180"
          />
        </span>
      </summary>
      <div className="border-t border-slate-100 px-8 py-6">
        {chunks.length === 0 ? (
          <p className="text-sm text-slate-400">
            n/a — no retrieved document chunks recorded on this run.
          </p>
        ) : (
          <RetrievedChunksPreview
            chunks={chunks}
            prodLineIdByProductLineKey={prodLineIdByProductLineKey}
          />
        )}
      </div>
    </details>
  );
}
