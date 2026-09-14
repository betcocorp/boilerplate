'use client';

import { Loader2Icon } from 'lucide-react';
import { useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { documentKindLabel } from '~/components/admin/tests/DocumentPickerField';
import type { DocumentBodyRow } from '~/app/api/admin/rag/document-bodies/route';
import { Badge } from '~/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';

/** One `expected_sources` entry as the table already knows it: the stored id plus its resolved title. */
export type ExpectedSourceSummary = {
  id: string;
  /** `rag.document.title` from the page's batched lookup, or null when no live document has this id. */
  title: string | null;
};

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; byId: Map<string, DocumentBodyRow> };

/**
 * Tailwind-only markdown styling (the repo does not ship the typography plugin). Tables are the
 * dominant structure in label markdown (784 of 1,042 markdown bodies carry one), hence the borders.
 */
const MARKDOWN_CLASS = [
  'text-sm leading-relaxed text-slate-700',
  '[&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-slate-900',
  '[&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-slate-900',
  '[&_h3]:mt-3 [&_h3]:font-semibold [&_h3]:text-slate-900',
  '[&_h4]:mt-3 [&_h4]:font-medium [&_h4]:text-slate-900',
  '[&_p]:my-2 [&_hr]:my-4 [&_strong]:font-semibold',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
  '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
  '[&_th]:border [&_th]:border-slate-200 [&_th]:bg-slate-50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium',
  '[&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top',
  '[&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:text-[0.8em]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-slate-100 [&_pre]:p-3',
  '[&_a]:text-sky-700 [&_a]:underline [&_a]:underline-offset-2',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600',
].join(' ');

type ExpectedSourcesDialogProps = {
  rowIndex: number;
  /** In the order the row stores them. */
  sources: readonly ExpectedSourceSummary[];
  /** The exact string the cell used to show — becomes the clickable trigger text. */
  label: string;
};

/**
 * B0-994 — the whole "Sources: …" string in the Concepts / sources cell opens this dialog, which
 * renders every expected source as its own card: title, kind, and the document body as markdown.
 *
 * Bodies are fetched lazily on first open (`/api/admin/rag/document-bodies`) so the table payload
 * stays title-only. `body_markdown` is preferred; the 4.9k documents without one fall back to
 * `body_text`, shown pre-wrapped. Regulated-data rule: both are rendered exactly as stored.
 *
 * An id with no live document keeps its card, marked unresolved — the same contract as the cell
 * and the reports: an expectation is never silently dropped.
 */
export function ExpectedSourcesDialog({ rowIndex, sources, label }: ExpectedSourcesDialogProps) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });

  const idsKey = sources.map((source) => source.id).join(',');

  // Fetched from the open handler (not an effect) once per mount; a later open reuses the bodies.
  const loadBodies = useCallback(async () => {
    if (idsKey === '') {
      return;
    }
    setLoad({ status: 'loading' });
    try {
      const response = await fetch(
        `/api/admin/rag/document-bodies?ids=${encodeURIComponent(idsKey)}`,
      );
      if (!response.ok) {
        setLoad({
          status: 'error',
          message: `Could not load the documents (HTTP ${response.status}).`,
        });
        return;
      }
      const payload = (await response.json()) as { documents?: DocumentBodyRow[] };
      setLoad({
        status: 'loaded',
        byId: new Map((payload.documents ?? []).map((document) => [document.id, document])),
      });
    } catch {
      setLoad({ status: 'error', message: 'Could not load the documents. Try again.' });
    }
  }, [idsKey]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen && (load.status === 'idle' || load.status === 'error')) {
      void loadBodies();
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger asChild>
        <button
          className="line-clamp-2 cursor-pointer rounded-sm text-left whitespace-normal text-slate-500 underline-offset-2 hover:text-sky-700 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          title={`${label} — click to read the documents`}
          type="button"
        >
          Sources: {label}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Expected sources (row {rowIndex})</DialogTitle>
          <DialogDescription>
            The {sources.length === 1 ? 'document' : `${sources.length} documents`} this
            prompt&rsquo;s answer should be grounded in. Bodies are shown exactly as stored —
            dilution ratios, contact times and EPA registration numbers are never reformatted.
          </DialogDescription>
        </DialogHeader>

        {load.status === 'error' ? (
          <p className="text-sm text-destructive">{load.message}</p>
        ) : null}

        <div className="grid gap-4">
          {sources.map((source) => (
            <SourceCard key={source.id} load={load} source={source} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourceCard({ source, load }: { source: ExpectedSourceSummary; load: LoadState }) {
  const document = load.status === 'loaded' ? load.byId.get(source.id) : undefined;
  const unresolved = load.status === 'loaded' && document === undefined;
  const title = document?.title || source.title || 'Unresolved document';

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle className="break-words">{title}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          {document ? (
            <>
              <Badge variant="secondary">{documentKindLabel(document.document_kind)}</Badge>
              {document.language_code ? (
                <Badge variant="outline">{document.language_code}</Badge>
              ) : null}
              {document.is_current === false ? (
                <Badge variant="outline">superseded</Badge>
              ) : null}
            </>
          ) : null}
          {unresolved ? (
            <span>No live document has this id — the expectation is kept, not dropped.</span>
          ) : null}
          <code className="text-[0.6875rem] text-slate-400">{source.id}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {load.status === 'loading' || load.status === 'idle' ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
            Loading document…
          </p>
        ) : null}
        {document ? <DocumentBody document={document} /> : null}
      </CardContent>
    </Card>
  );
}

function DocumentBody({ document }: { document: DocumentBodyRow }) {
  if (document.body_markdown && document.body_markdown.trim() !== '') {
    return (
      <div className={MARKDOWN_CLASS}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{document.body_markdown}</ReactMarkdown>
      </div>
    );
  }
  if (document.body_text.trim() !== '') {
    return (
      <pre className="text-sm leading-relaxed whitespace-pre-wrap break-words font-sans text-slate-700">
        {document.body_text}
      </pre>
    );
  }
  return <p className="text-sm text-slate-500">This document has no stored body.</p>;
}
