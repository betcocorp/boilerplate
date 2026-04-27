'use client';

import { useEffect, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { cn } from '~/lib/utils';

import type { RagDocumentChunkApiResponse } from '~/lib/rag/document-chunk-types';
import { toast } from 'sonner';

type InspectMode = 'document' | 'chunk';

function JsonBlock({ value }: { value: unknown }) {
  const text =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
  if (!text) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <pre className="max-h-40 overflow-auto rounded-lg border border-border/80 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
      {text}
    </pre>
  );
}

function RagDocumentChunkDetailBody({ data }: { data: RagDocumentChunkApiResponse }) {
  const { document: doc, chunk } = data;

  return (
    <div className="grid gap-6">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Document
        </h3>
        <dl className="grid gap-2 text-sm">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="shrink-0 text-muted-foreground">ID</dt>
            <dd className="min-w-0 break-all font-mono text-xs">{doc.id}</dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="shrink-0 text-muted-foreground">Title</dt>
            <dd className="min-w-0 font-medium">{doc.title}</dd>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              kind: <span className="text-foreground">{doc.document_kind}</span>
            </span>
            <span>
              key:{' '}
              <span className="font-mono text-foreground">{doc.document_key}</span>
            </span>
            <span>
              lang: <span className="text-foreground">{doc.language_code}</span>
            </span>
          </div>
          {doc.summary ? (
            <div>
              <dt className="text-muted-foreground">Summary</dt>
              <dd className="mt-1 text-foreground">{doc.summary}</dd>
            </div>
          ) : null}
        </dl>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Metadata</p>
          <JsonBlock value={doc.metadata} />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Body (full text)</p>
          <div className="max-h-[min(40vh,320px)] overflow-auto rounded-lg border border-border/80 bg-muted/30">
            <pre className="whitespace-pre-wrap wrap-break-word p-3 font-mono text-[11px] leading-relaxed">
              {doc.body_text}
            </pre>
          </div>
        </div>
        {doc.body_markdown ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Body (markdown)</p>
            <div className="max-h-[min(32vh,260px)] overflow-auto rounded-lg border border-border/80 bg-muted/30">
              <pre className="whitespace-pre-wrap wrap-break-word p-3 font-mono text-[11px] leading-relaxed">
                {doc.body_markdown}
              </pre>
            </div>
          </div>
        ) : null}
      </section>

      {chunk ? (
        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Chunk
          </h3>
          <dl className="grid gap-2 text-sm">
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
              <dt className="shrink-0 text-muted-foreground">Chunk ID</dt>
              <dd className="min-w-0 break-all font-mono text-xs">{chunk.id}</dd>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                index:{' '}
                <span className="font-mono text-foreground">{chunk.chunk_index}</span>
              </span>
              <span>
                key:{' '}
                <span className="font-mono text-foreground">{chunk.chunk_key}</span>
              </span>
            </div>
            {chunk.heading ? (
              <div>
                <dt className="text-muted-foreground">Heading</dt>
                <dd className="mt-0.5">{chunk.heading}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-muted-foreground">Section path</dt>
              <dd className="mt-0.5 font-mono text-xs">
                {chunk.section_path?.length
                  ? chunk.section_path.join(' / ')
                  : '—'}
              </dd>
            </div>
          </dl>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Chunk metadata</p>
            <JsonBlock value={chunk.metadata} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Chunk text</p>
            <div className="max-h-[min(36vh,280px)] overflow-auto rounded-lg border border-border/80 bg-muted/30">
              <pre className="whitespace-pre-wrap wrap-break-word p-3 font-mono text-[11px] leading-relaxed">
                {chunk.chunk_text}
              </pre>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function RagDocumentChunkInspectDialog({
  open,
  onOpenChange,
  documentId,
  chunkId,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
  chunkId: string | null;
  mode: InspectMode;
}) {
  const [data, setData] = useState<RagDocumentChunkApiResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !documentId) {
      return;
    }

    if (mode === 'chunk' && !chunkId) {
      toast.error('Chunk is not available for inspection.');
      onOpenChange(false);
      return;
    }

    let cancelled = false;

    async function run() {
      setLoading(true);
      setData(null);
      try {
        const params = new URLSearchParams({ documentId });
        if (mode === 'chunk' && chunkId) {
          params.set('chunkId', chunkId);
        }
        const res = await fetch(`/api/rag/document-chunk?${params.toString()}`);
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(errBody?.error || `Request failed (${res.status})`);
        }
        const json = (await res.json()) as RagDocumentChunkApiResponse;
        if (!cancelled) {
          setData(json);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to load';
        toast.error(message);
        if (!cancelled) {
          onOpenChange(false);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [open, documentId, chunkId, mode, onOpenChange]);

  useEffect(() => {
    if (!open) {
      setData(null);
      setLoading(false);
    }
  }, [open]);

  const title =
    mode === 'chunk' && chunkId ? 'Document & chunk details' : 'Document details';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[min(92vh,880px)] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden sm:max-w-3xl"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Full RAG document and optional chunk row from the corpus.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pr-2 [-webkit-overflow-scrolling:touch]">
          <div className="pb-2 pt-2">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : data ? (
              <RagDocumentChunkDetailBody data={data} />
            ) : (
              <p className="text-sm text-muted-foreground">No data.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RagDocumentChunkInspectButtons({
  documentId,
  chunkId,
  className,
  size = 'xs',
  layout = 'stack',
}: {
  documentId: string;
  chunkId?: string | null;
  className?: string;
  /** Visual size for id buttons */
  size?: 'xs' | 'sm';
  /** Stack (admin tables) vs inline (chat sources). */
  layout?: 'stack' | 'inline';
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<InspectMode>('document');

  const btnClass = cn(
    'cursor-pointer rounded px-0.5 text-left font-mono break-all underline decoration-muted-foreground/60 underline-offset-2 transition hover:text-primary hover:decoration-primary',
    size === 'xs' ? 'text-[10px] leading-snug' : 'text-xs',
    className,
  );

  const labels =
    layout === 'inline'
      ? { doc: 'doc', chunk: 'chunk' }
      : { doc: 'document_id', chunk: 'chunk_id' };

  const inner =
    layout === 'inline' ? (
      <span
        className={cn(
          'inline-flex flex-wrap items-baseline gap-x-2 gap-y-1',
          className,
        )}
      >
        <span className="text-muted-foreground">
          {labels.doc}{' '}
          <button
            type="button"
            className={btnClass}
            onClick={() => {
              setMode('document');
              setDialogOpen(true);
            }}
          >
            {documentId}
          </button>
        </span>
        <span className="text-muted-foreground">
          {labels.chunk}{' '}
          {chunkId ? (
            <button
              type="button"
              className={btnClass}
              onClick={() => {
                setMode('chunk');
                setDialogOpen(true);
              }}
            >
              {chunkId}
            </button>
          ) : (
            <span className="font-mono opacity-70">—</span>
          )}
        </span>
      </span>
    ) : (
      <span className={cn('inline-flex flex-col gap-0.5', className)}>
        <span className="text-muted-foreground">
          {labels.doc}{' '}
          <button
            type="button"
            className={btnClass}
            onClick={() => {
              setMode('document');
              setDialogOpen(true);
            }}
          >
            {documentId}
          </button>
        </span>
        <span className="text-muted-foreground">
          {labels.chunk}{' '}
          {chunkId ? (
            <button
              type="button"
              className={btnClass}
              onClick={() => {
                setMode('chunk');
                setDialogOpen(true);
              }}
            >
              {chunkId}
            </button>
          ) : (
            <span className="font-mono text-[10px] text-slate-600">—</span>
          )}
        </span>
      </span>
    );

  return (
    <>
      {inner}

      <RagDocumentChunkInspectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        documentId={documentId}
        chunkId={chunkId ?? null}
        mode={mode}
      />
    </>
  );
}
