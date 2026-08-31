'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { RagDocumentChunkInspectButtons } from '~/components/rag/RagDocumentChunkInspect';

import { Badge } from '~/components/ui/badge';
import { logSearchResultClick } from '~/lib/event-logging/search-events';
import type { RagSearchMatch } from '~/lib/rag/search';

/** B0-761 — stable analytics surface id for the RAG semantic-search page. */
const RAG_SEARCH_SURFACE = 'rag-search';

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
  /** Total matches rendered for the current query (B0-761 analytics). */
  resultCount: number;
};

/**
 * B0-621 — one result card in the two-column grid. Pure presentation over an existing
 * `RagSearchMatch`; no retrieval logic lives here.
 * B0-684 — "Product line:" and "SKU:" are now clickable links to documents.
 */
export function RagSearchResultCard({
  match,
  rank,
  productLineHref,
  resultCount,
}: RagSearchResultCardProps) {
  const similarityPct = match.similarity * 100;

  // B0-761 — analytics tag for opening a result's document. Fire-and-forget, ids only.
  const logResultClick = () => {
    logSearchResultClick({
      entityType: 'chunk',
      rank,
      resultId: match.chunk_id,
      resultCount,
      surface: RAG_SEARCH_SURFACE,
    });
  };

  // B0-684: State for clickable product line field
  const [productLineDocId, setProductLineDocId] = useState<string | null>(null);
  const [productLineLoading, setProductLineLoading] = useState(false);

  // B0-684: State for clickable SKU field
  const [skuDocId, setSkuDocId] = useState<string | null>(null);
  const [skuLoading, setSkuLoading] = useState(false);

  // B0-684: Fetch document ID for product line on mount or when match changes
  useEffect(() => {
    if (!match.product_line_key && !match.source_pk) {
      return;
    }

    const lookupKey = match.product_line_key || match.source_pk;
    const fetchProductLineDoc = async () => {
      setProductLineLoading(true);
      try {
        const response = await fetch(
          `/api/admin/rag/document-lookup?productLineKey=${encodeURIComponent(lookupKey)}`
        );
        if (response.ok) {
          const data = await response.json();
          if (data.documentId) {
            setProductLineDocId(data.documentId);
          }
        }
      } catch (error) {
        console.error('Failed to fetch product line document ID:', error);
      } finally {
        setProductLineLoading(false);
      }
    };

    fetchProductLineDoc();
  }, [match.product_line_key, match.source_pk]);

  // B0-684: Fetch document ID for SKU on mount or when match changes
  useEffect(() => {
    const sku = match.sku;
    if (!sku) {
      return;
    }

    const fetchSkuDoc = async () => {
      setSkuLoading(true);
      try {
        const response = await fetch(
          `/api/admin/rag/document-lookup?sku=${encodeURIComponent(sku)}`
        );
        if (response.ok) {
          const data = await response.json();
          if (data.documentId) {
            setSkuDocId(data.documentId);
          }
        }
      } catch (error) {
        console.error('Failed to fetch SKU document ID:', error);
      } finally {
        setSkuLoading(false);
      }
    };

    fetchSkuDoc();
  }, [match.sku]);

  return (
    <article className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-background p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="font-heading text-2xl font-semibold text-muted-foreground/60">
            {String(rank).padStart(2, '0')}
          </span>
          <h2 className="text-lg font-semibold text-foreground">
            {match.document_title}
          </h2>
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
        {match.section_type ? (
          <Badge variant="outline">{match.section_type}</Badge>
        ) : null}
        <Badge variant="secondary">Chunk {match.chunk_index}</Badge>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-3">
        <div className="flex gap-1">
          <dt className="font-medium text-foreground">Product line:</dt>
          <dd className="truncate">
            {(() => {
              const productLineKey = match.product_line_key || match.source_pk;
              if (!productLineKey) {
                return 'N/A';
              }

              if (productLineLoading) {
                return 'Loading...';
              }

              if (productLineDocId) {
                return (
                  <Link
                    href={`/admin/products/rag/documents/${productLineDocId}`}
                    className="text-primary hover:underline"
                    onClick={logResultClick}
                  >
                    {productLineKey}
                  </Link>
                );
              }

              return productLineKey;
            })()}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium text-foreground">SKU:</dt>
          <dd className="truncate">
            {(() => {
              if (!match.sku) {
                return 'N/A';
              }

              if (skuLoading) {
                return 'Loading...';
              }

              if (skuDocId) {
                return (
                  <Link
                    href={`/admin/products/rag/documents/${skuDocId}`}
                    className="text-primary hover:underline"
                    onClick={logResultClick}
                  >
                    {match.sku}
                  </Link>
                );
              }

              return match.sku;
            })()}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium text-foreground">Section:</dt>
          <dd className="truncate">
            {match.section_path?.join(' / ') || 'N/A'}
          </dd>
        </div>
      </dl>

      <p className="whitespace-pre-wrap rounded-2xl bg-muted/50 p-4 font-mono text-xs leading-5 text-foreground">
        {truncateText(match.chunk_text)}
      </p>

      {productLineHref ? (
        <Link
          className="inline-flex w-fit rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/80"
          href={productLineHref}
          onClick={logResultClick}
        >
          View RAG product line
        </Link>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-3 font-mono text-[11px] text-muted-foreground">
        <RagDocumentChunkInspectButtons
          layout="inline"
          documentId={match.document_id}
          chunkId={match.chunk_id}
        />
      </div>
    </article>
  );
}
