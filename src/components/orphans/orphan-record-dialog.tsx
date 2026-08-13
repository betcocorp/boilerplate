'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { ScrollArea } from '~/components/ui/scroll-area';
import { Spinner } from '~/components/ui/spinner';
import { getOrphanRecord } from '~/lib/orphans/orphan-queue-actions';
import {
  ORPHAN_DATA_TYPE_LABELS,
  type OrphanDataType,
  type OrphanRecordResult,
} from '~/types/orphans';

interface Props {
  dataType: OrphanDataType;
  refId: string;
  label: string | null;
}

/** Fields that hold the long-form document body — rendered as their own full-width blocks. */
const BODY_FIELDS = ['body_markdown', 'body_text'] as const;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function isMultiline(value: unknown): boolean {
  return typeof value === 'object' || (typeof value === 'string' && value.includes('\n'));
}

/**
 * Makes an orphan row's GUID clickable: opens a dialog that fetches and shows the entire
 * underlying record (document body + every field). Fetch is lazy — only on first open.
 */
export function OrphanRecordDialog({ dataType, refId, label }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OrphanRecordResult | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && !result && !loading) {
      setLoading(true);
      getOrphanRecord({ dataType, refId })
        .then(setResult)
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : 'Failed to load record');
          setOpen(false);
        })
        .finally(() => setLoading(false));
    }
  }

  const record = result?.record ?? null;
  const bodyEntries = record
    ? BODY_FIELDS.filter((k) => record[k] != null && record[k] !== '').map((k) => [k, record[k]] as const)
    : [];
  const fieldEntries = record
    ? Object.entries(record).filter(([k]) => !BODY_FIELDS.includes(k as (typeof BODY_FIELDS)[number]))
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="cursor-pointer font-mono text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        title="View full record"
      >
        {refId}
      </button>

      <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="truncate">{label ?? '(untitled)'}</DialogTitle>
          <DialogDescription>
            {ORPHAN_DATA_TYPE_LABELS[dataType]}
            {result ? ` · ${result.table}` : ''} · <span className="font-mono">{refId}</span>
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Spinner /> Loading record…
          </div>
        ) : !record ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            This record no longer exists in the source table.
          </div>
        ) : (
          <ScrollArea className="max-h-[65vh] pr-4">
            <div className="space-y-6">
              {bodyEntries.map(([key, value]) => (
                <section key={key} className="space-y-1">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {key}
                  </h3>
                  <pre className="whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/40 p-3 text-xs">
                    {String(value)}
                  </pre>
                </section>
              ))}

              <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,12rem)_1fr]">
                {fieldEntries.map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="font-mono text-xs text-muted-foreground sm:pt-0.5">{key}</dt>
                    <dd className="min-w-0">
                      {isMultiline(value) ? (
                        <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-2 text-xs">
                          {formatValue(value)}
                        </pre>
                      ) : (
                        <span className="break-words text-sm">{formatValue(value)}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
