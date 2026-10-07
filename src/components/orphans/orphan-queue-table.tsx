'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import { Input } from '~/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { OrphanReconcileAction } from '~/components/orphans/orphan-reconcile-action';
import { OrphanRecordDialog } from '~/components/orphans/orphan-record-dialog';
import { acknowledgeOrphan } from '~/lib/orphans/orphan-queue-actions';
import { ORPHAN_CHECK_LABELS, type OrphanDataType, type OrphanQueueRow } from '~/types/orphans';

interface Props {
  dataType: OrphanDataType;
  rows: OrphanQueueRow[];
  total: number;
  page: number;
  pageSize: number;
  includeIgnored: boolean;
  includeTranslated: boolean;
  includeInactive: boolean;
  search: string;
}

/**
 * The language code carried on document-derived rows (`detail.language_code`), so a
 * translated row can be badged with the real language rather than a generic label.
 */
function translatedBadgeLabel(row: OrphanQueueRow): string {
  const code = row.detail?.language_code;
  return typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : 'Translated';
}

/**
 * Client table for a single data type's orphan queue. Search, a "show acknowledged"
 * toggle, a "show translated" toggle (B0-804 — non-English SDS/label documents are
 * hidden by default because they are never chunked or retrieved), a "show inactive"
 * toggle (B0-1093 — deactivated sources and inactive/empty product lines are hidden by
 * default because they were retired on purpose), pagination, and the acknowledge /
 * restore action per row.
 */
export function OrphanQueueTable({
  dataType,
  rows,
  total,
  page,
  pageSize,
  includeIgnored,
  includeTranslated,
  includeInactive,
  search,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [searchInput, setSearchInput] = useState(search);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hiddenKinds = [
    includeTranslated ? null : 'translated documents',
    includeInactive ? null : 'inactive records',
  ].filter((kind): kind is string => kind !== null);
  const hiddenNote = hiddenKinds.length > 0 ? `${hiddenKinds.join(' and ')} are hidden` : null;

  function pushParams(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    router.push(`?${sp.toString()}`);
  }

  function onAcknowledge(row: OrphanQueueRow) {
    const reason = window.prompt(
      row.ignored
        ? 'Restore this record to the active queue? (optional note)'
        : 'Reason this orphan is acceptable / acknowledged:',
      row.ignore_reason ?? '',
    );
    if (reason === null) return; // cancelled

    startTransition(async () => {
      try {
        await acknowledgeOrphan({
          checkKey: row.check_key,
          refId: row.ref_id,
          reason: reason || undefined,
          isActive: !row.ignored,
        });
        toast.success(
          row.ignored ? 'Restored to active queue' : 'Acknowledged — hidden from active queue',
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update');
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            pushParams({ q: searchInput || null, page: '1' });
          }}
          className="flex flex-1 items-center gap-2"
        >
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by label…"
            className="max-w-sm"
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={includeIgnored}
            onCheckedChange={(value) =>
              pushParams({ includeIgnored: value === true ? '1' : null, page: '1' })
            }
          />
          Show acknowledged
        </label>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={includeTranslated}
            onCheckedChange={(value) =>
              pushParams({ includeTranslated: value === true ? '1' : null, page: '1' })
            }
          />
          Show translated
        </label>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={includeInactive}
            onCheckedChange={(value) =>
              pushParams({ includeInactive: value === true ? '1' : null, page: '1' })
            }
          />
          Show inactive
        </label>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Record</TableHead>
              <TableHead>Issue</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {`Nothing here — no ${includeIgnored ? '' : 'active '}orphans for this data type${
                    hiddenNote ? ` (${hiddenNote})` : ''
                  }.`}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={`${row.check_key}:${row.ref_id}`} className={row.ignored ? 'opacity-60' : ''}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.ref_label ?? '(untitled)'}</span>
                      {row.translated ? (
                        <Badge variant="outline" title="Non-English document — never chunked or retrieved">
                          {translatedBadgeLabel(row)}
                        </Badge>
                      ) : null}
                      {row.inactive ? (
                        <Badge
                          variant="outline"
                          title="Deactivated source record or inactive/empty product line — retired on purpose"
                        >
                          Inactive
                        </Badge>
                      ) : null}
                    </div>
                    <OrphanRecordDialog
                      dataType={dataType}
                      refId={row.ref_id}
                      label={row.ref_label}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {ORPHAN_CHECK_LABELS[row.check_key]}
                  </TableCell>
                  <TableCell>
                    <code className="block max-w-xs truncate text-xs text-muted-foreground">
                      {row.detail ? JSON.stringify(row.detail) : '—'}
                    </code>
                  </TableCell>
                  <TableCell>
                    {row.ignored ? (
                      <Badge variant="secondary">
                        Acknowledged{row.ignore_reason ? ` · ${row.ignore_reason}` : ''}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {!row.ignored ? <OrphanReconcileAction row={row} /> : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => onAcknowledge(row)}
                      >
                        {row.ignored ? 'Restore' : 'Acknowledge'}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total} record{total === 1 ? '' : 's'} · page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => pushParams({ page: String(page - 1) })}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => pushParams({ page: String(page + 1) })}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
