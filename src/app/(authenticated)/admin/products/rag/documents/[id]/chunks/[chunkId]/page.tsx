import { ArrowLeft, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LegacyReferenceText } from '~/components/admin/rag/LegacyReferenceText';
import { BexStreamdown } from '~/components/bex/BexStreamdown';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import {
  isRagUuid,
  ragChunkHref,
  ragDocumentHref,
  sanitizeRagReturnHref,
} from '~/lib/rag/document-detail-links';
import { linkifyLegacyReferencesMarkdown } from '~/lib/rag/document-source-links';
import { formatEasternTimestamp } from '~/lib/utils/time';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const metadata = {
  title: 'Chunk Viewer | Betco BEX',
};

type PageProps = {
  params: Promise<{ id: string; chunkId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

type ChunkRow = {
  id: string;
  chunk_key: string;
  chunk_index: number;
  heading: string | null;
  chunk_text: string;
  section_path: string[] | null;
  section_type: string | null;
  token_count: number | null;
  metadata: Record<string, unknown> | null;
  document_id: string;
  created_at: string;
  updated_at: string;
};

type DocumentRow = {
  id: string;
  document_key: string;
  title: string;
  document_kind: string;
  language_code: string;
  metadata: Record<string, unknown> | null;
  source_record_id: string | null;
  entity_id: string | null;
};

type NeighbourRow = {
  id: string;
  chunk_index: number;
  heading: string | null;
};

const CHUNK_COLUMNS =
  'id, chunk_key, chunk_index, heading, chunk_text, section_path, section_type, token_count, metadata, document_id, created_at, updated_at';
const DOCUMENT_COLUMNS =
  'id, document_key, title, document_kind, language_code, metadata, source_record_id, entity_id';
const NEIGHBOUR_COLUMNS = 'id, chunk_index, heading';

/**
 * B0-1019 — the `rag` schema is absent from the generated Supabase types, so every query is cast
 * to a narrow local shape, exactly as `documents/[id]/page.tsx` and `~/lib/rag/id-lookup.ts` do.
 */
type MaybeSingleSelect<T> = {
  select(cols: string): {
    eq(
      col: string,
      val: string,
    ): {
      maybeSingle(): Promise<{
        data: T | null;
        error: { message: string } | null;
      }>;
    };
  };
};

type NeighbourListChain<T> = {
  order(
    col: string,
    opts: { ascending: boolean },
  ): {
    limit(count: number): Promise<{
      data: T[] | null;
      error: { message: string } | null;
    }>;
  };
};

type NeighbourSelect<T> = {
  select(cols: string): {
    eq(
      col: string,
      val: string,
    ): {
      lt(col: string, val: number): NeighbourListChain<T>;
      gt(col: string, val: number): NeighbourListChain<T>;
    };
  };
};

function metadataEntries(metadata: Record<string, unknown> | null) {
  return metadata && Object.keys(metadata).length > 0 ? metadata : null;
}

export default async function ChunkViewerPage({
  params,
  searchParams,
}: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TOOLS,
    'GET /admin/products/rag/documents/[id]/chunks/[chunkId]',
  );

  const { id, chunkId } = await params;

  // A non-uuid reaching an `.eq()` on a uuid column raises a raw Postgres cast error, not a 404.
  if (!isRagUuid(id) || !isRagUuid(chunkId)) {
    notFound();
  }

  const resolvedSearchParams = await searchParams;
  const rawFrom = resolvedSearchParams.from;
  const returnHref = sanitizeRagReturnHref(
    Array.isArray(rawFrom) ? rawFrom[0] : rawFrom,
  );

  const supabase = getSupabaseServiceRoleClient();

  const { data: chunk, error: chunkError } = await (
    supabase
      .schema('rag')
      .from('document_chunk') as unknown as MaybeSingleSelect<ChunkRow>
  )
    .select(CHUNK_COLUMNS)
    .eq('id', chunkId)
    .maybeSingle();

  if (chunkError || !chunk || chunk.document_id !== id) {
    notFound();
  }

  const { data: doc, error: docError } = await (
    supabase
      .schema('rag')
      .from('document') as unknown as MaybeSingleSelect<DocumentRow>
  )
    .select(DOCUMENT_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (docError || !doc) {
    notFound();
  }

  // Prev / next within the document — two indexed reads on (document_id, chunk_index).
  const [prevResult, nextResult] = await Promise.all([
    (
      supabase
        .schema('rag')
        .from('document_chunk') as unknown as NeighbourSelect<NeighbourRow>
    )
      .select(NEIGHBOUR_COLUMNS)
      .eq('document_id', id)
      .lt('chunk_index', chunk.chunk_index)
      .order('chunk_index', { ascending: false })
      .limit(1),
    (
      supabase
        .schema('rag')
        .from('document_chunk') as unknown as NeighbourSelect<NeighbourRow>
    )
      .select(NEIGHBOUR_COLUMNS)
      .eq('document_id', id)
      .gt('chunk_index', chunk.chunk_index)
      .order('chunk_index', { ascending: true })
      .limit(1),
  ]);

  const prevChunk = prevResult.data?.[0] ?? null;
  const nextChunk = nextResult.data?.[0] ?? null;

  const chunkMetadata = metadataEntries(chunk.metadata);
  const sectionPath = chunk.section_path ?? [];

  const facts = [
    { label: 'Chunk index', value: String(chunk.chunk_index) },
    { label: 'Section type', value: chunk.section_type || '—' },
    {
      label: 'Tokens',
      value: chunk.token_count === null ? '—' : String(chunk.token_count),
    },
    { label: 'Characters', value: String(chunk.chunk_text.length) },
  ];

  return (
    <div className="flex flex-1 bg-background">
      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        {/* Back to wherever this page was opened from */}
        <Link
          href={returnHref ?? ragDocumentHref(doc.id)}
          className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
          {returnHref ? 'Back to search results' : 'Back to document'}
        </Link>

        {/* Document context */}
        <section className="rounded-3xl border border-border bg-card p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Document
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
            <Link
              href={ragDocumentHref(doc.id, returnHref)}
              className="inline-flex items-center gap-2 transition hover:underline"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              {doc.title}
            </Link>
          </h2>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            <LegacyReferenceText text={doc.document_key} />
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Type', value: doc.document_kind },
              { label: 'Language', value: doc.language_code },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-2xl bg-muted px-4 py-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-sm font-medium text-foreground">
                  {value}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Chunk header */}
        <section className="rounded-3xl border border-border bg-card p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Chunk
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
            {chunk.heading || `Chunk ${chunk.chunk_index}`}
          </h1>
          <p className="mt-1 break-all font-mono text-sm text-muted-foreground">
            {chunk.chunk_key}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {facts.map(({ label, value }) => (
              <div key={label} className="rounded-2xl bg-muted px-4 py-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-sm font-medium text-foreground">
                  {value}
                </p>
              </div>
            ))}
          </div>

          <dl className="mt-6 divide-y divide-border border-t border-border">
            <div className="flex flex-wrap gap-x-4 gap-y-1 py-3">
              <dt className="w-44 shrink-0 text-sm font-medium text-foreground">
                Section path
              </dt>
              <dd className="min-w-0 flex-1 break-words font-mono text-xs text-muted-foreground">
                {sectionPath.length > 0 ? sectionPath.join(' › ') : '—'}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 py-3">
              <dt className="w-44 shrink-0 text-sm font-medium text-foreground">
                Chunk id
              </dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">
                {chunk.id}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 py-3">
              <dt className="w-44 shrink-0 text-sm font-medium text-foreground">
                Created
              </dt>
              <dd className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
                {formatEasternTimestamp(chunk.created_at)}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 py-3">
              <dt className="w-44 shrink-0 text-sm font-medium text-foreground">
                Updated
              </dt>
              <dd className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
                {formatEasternTimestamp(chunk.updated_at)}
              </dd>
            </div>
          </dl>
        </section>

        {/* Chunk text — rendered as markdown, matching the Chunks section on the document page (B0-1022). */}
        <section className="rounded-3xl border border-border bg-card p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground">Chunk text</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The text that was embedded for this chunk, rendered as markdown.
          </p>
          <div className="mt-6 max-h-[32rem] overflow-auto break-words rounded-2xl bg-muted p-4 text-xs leading-relaxed text-foreground">
            <BexStreamdown
              className="mt-0"
              content={linkifyLegacyReferencesMarkdown(chunk.chunk_text)}
              isStreaming={false}
              isUser={false}
            />
          </div>
        </section>

        {/* Chunk metadata */}
        <section className="rounded-3xl border border-border bg-card p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground">
            Chunk metadata
          </h2>
          {chunkMetadata ? (
            <pre className="mt-6 max-h-96 overflow-auto rounded-2xl bg-muted p-4 font-mono text-xs leading-relaxed text-foreground">
              {JSON.stringify(chunkMetadata, null, 2)}
            </pre>
          ) : (
            <p className="mt-6 text-sm text-muted-foreground">
              No metadata on file.
            </p>
          )}
        </section>

        {/* Prev / next within the document */}
        <nav className="flex flex-wrap items-center justify-between gap-3">
          {prevChunk ? (
            <Link
              href={ragChunkHref(doc.id, prevChunk.id, returnHref)}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted"
            >
              <ChevronLeft className="size-4 shrink-0" />
              <span className="truncate">
                Chunk {prevChunk.chunk_index}
                {prevChunk.heading ? ` · ${prevChunk.heading}` : ''}
              </span>
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">First chunk</span>
          )}

          {nextChunk ? (
            <Link
              href={ragChunkHref(doc.id, nextChunk.id, returnHref)}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted"
            >
              <span className="truncate">
                Chunk {nextChunk.chunk_index}
                {nextChunk.heading ? ` · ${nextChunk.heading}` : ''}
              </span>
              <ChevronRight className="size-4 shrink-0" />
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">Last chunk</span>
          )}
        </nav>
      </main>
    </div>
  );
}
