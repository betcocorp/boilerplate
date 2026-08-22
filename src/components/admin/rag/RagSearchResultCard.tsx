import Link from 'next/link';

import { RagSearchMatchInspectBar } from '~/components/admin/rag/RagSearchMatchInspectBar';
import { Badge } from '~/components/ui/badge';
import type { RagSearchMatch } from '~/lib/rag/search';

function truncateText(value: string, maxLength = 320) {
  const trimmed = value.trim();

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 3)}...`;
}

type RagSearchResultCardProps = {
  match: RagSearchMatch;
  rank: number;
  productLineHref: string | null;
};

/**
 * B0-621 — one result card in the two-column grid. Pure presentation over an existing
 * `RagSearchMatch`; no retrieval logic lives here.
 */
export function RagSearchResultCard({ match, rank, productLineHref }: RagSearchResultCardProps) {
  const similarityPct = match.similarity * 100;

  return (
    <article className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-background p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="font-heading text-2xl font-semibold text-muted-foreground/60">
            {String(rank).padStart(2, '0')}
          </span>
          <h2 className="text-lg font-semibold text-foreground">{match.document_title}</h2>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-foreground">
          {similarityPct.toFixed(1)}%
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.min(100, Math.max(0, similarityPct))}%` }}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{match.document_kind}</Badge>
        {match.section_type ? <Badge variant="outline">{match.section_type}</Badge> : null}
        <Badge variant="secondary">Chunk {match.chunk_index}</Badge>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-3">
        <div className="flex gap-1">
          <dt className="font-medium text-foreground">Product line:</dt>
          <dd className="truncate">{match.product_line_key || match.source_pk || 'N/A'}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium text-foreground">SKU:</dt>
          <dd className="truncate">{match.sku || 'N/A'}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium text-foreground">Section:</dt>
          <dd className="truncate">{match.section_path?.join(' / ') || 'N/A'}</dd>
        </div>
      </dl>

      <p className="whitespace-pre-wrap rounded-2xl bg-muted/50 p-4 font-mono text-xs leading-5 text-foreground">
        {truncateText(match.chunk_text)}
      </p>

      <RagSearchMatchInspectBar chunkId={match.chunk_id} documentId={match.document_id} />

      {productLineHref ? (
        <Link
          className="inline-flex w-fit rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/80"
          href={productLineHref}
        >
          View RAG product line
        </Link>
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-3 font-mono text-[11px] text-muted-foreground">
        <span>doc: {match.document_id}</span>
        <span>chunk: {match.chunk_id}</span>
      </div>
    </article>
  );
}
