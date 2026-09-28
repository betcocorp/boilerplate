'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ProductLinePicker, type ProductLinePickerValue } from '~/components/admin/ProductLinePicker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { ScrollArea } from '~/components/ui/scroll-area';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { Textarea } from '~/components/ui/textarea';
import { getOrphanRecord, updateOrphanRecordField } from '~/lib/orphans/orphan-queue-actions';
import { isOrphanRecordFieldEditable } from '~/lib/orphans/orphan-record-editing';
import { getErrorMessage } from '~/lib/utils';
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
  return (
    typeof value === 'object' ||
    (typeof value === 'string' && value.includes('\n'))
  );
}

/** Draft text for a field's edit control — the inverse of `formatValue` for jsonb/number fields. */
function draftFor(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * B0-1094 — one editable field of the underlying record. Renders the right control by the
 * field's *current* value type (string/number/boolean/object), with `product_line_key`
 * special-cased to `ProductLinePicker` (a GUID FK — free text is exactly the typo risk that
 * picker exists to prevent). No Save button — every control commits on blur (the whole
 * container's blur for the picker, since selecting an option doesn't itself blur the trigger),
 * comparing against the last-known-good `value` prop so an unchanged field is a no-op.
 */
function EditableField({
  dataType,
  refId,
  field,
  value,
  onSaved,
}: {
  dataType: OrphanDataType;
  refId: string;
  field: string;
  value: unknown;
  onSaved: (next: unknown) => void;
}) {
  const [draft, setDraft] = useState(() => draftFor(value));
  const [picker, setPicker] = useState<ProductLinePickerValue>({
    productLineKey: typeof value === 'string' ? value : '',
    title: '',
  });
  const [saving, setSaving] = useState(false);

  async function save(nextValue: unknown, nextDraft: string) {
    setSaving(true);
    try {
      await updateOrphanRecordField({ dataType, refId, field, value: nextValue });
      onSaved(nextValue);
      setDraft(nextDraft);
      toast.success(`Saved ${field}`);
    } catch (err) {
      toast.error(getErrorMessage(err, `Failed to save ${field}`));
    } finally {
      setSaving(false);
    }
  }

  if (field === 'product_line_key') {
    return (
      <div
        className="flex items-center gap-2"
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          const next = picker.productLineKey.trim();
          if (!next || next === value) return;
          void save(next, next);
        }}
      >
        <div className="flex-1">
          <ProductLinePicker
            disabled={saving}
            idPrefix={`orphan-field-${refId}-${field}`}
            onChange={setPicker}
            value={picker}
          />
        </div>
        {saving ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>
    );
  }

  if (typeof value === 'boolean') {
    return (
      <Switch
        checked={value}
        disabled={saving}
        onCheckedChange={(checked) => save(checked, String(checked))}
      />
    );
  }

  if (value !== null && typeof value === 'object') {
    return (
      <div className="flex items-start gap-2">
        <Textarea
          className="min-h-24 flex-1 font-mono text-xs"
          disabled={saving}
          onBlur={() => {
            if (draft === draftFor(value)) return;
            try {
              const parsed = JSON.parse(draft) as unknown;
              if (parsed === null || typeof parsed !== 'object') {
                toast.error(`${field} must be a JSON object or array`);
                return;
              }
              void save(parsed, JSON.stringify(parsed, null, 2));
            } catch {
              toast.error('Invalid JSON');
            }
          }}
          onChange={(e) => setDraft(e.target.value)}
          value={draft}
        />
        {saving ? <Loader2 className="mt-2 size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>
    );
  }

  const isNumber = typeof value === 'number';
  return (
    <div className="flex items-center gap-2">
      <Input
        className="h-8 flex-1 border-border/30 bg-transparent text-sm hover:border-transparent hover:bg-input/50"
        disabled={saving}
        onBlur={() => {
          if (draft === draftFor(value)) return;
          if (isNumber) {
            const n = Number(draft);
            if (draft.trim() !== '' && Number.isNaN(n)) {
              toast.error(`${field} must be a number`);
              return;
            }
            void save(draft.trim() === '' ? null : n, draftFor(draft.trim() === '' ? null : n));
            return;
          }
          void save(draft === '' ? null : draft, draft);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        type={isNumber ? 'number' : 'text'}
        value={draft}
      />
      {saving ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}

/**
 * Makes an orphan row's GUID clickable: opens a dialog that fetches the entire underlying
 * record (document body + every field) and lets every non-read-only field be edited and saved
 * back to its own table in place (B0-1094) — this used to be a pure viewer. Fetch is lazy —
 * only on first open.
 */
export function OrphanRecordDialog({ dataType, refId, label }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OrphanRecordResult | null>(null);
  const router = useRouter();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && !result && !loading) {
      setLoading(true);
      getOrphanRecord({ dataType, refId })
        .then(setResult)
        .catch((err) => {
          toast.error(
            err instanceof Error ? err.message : 'Failed to load record',
          );
          setOpen(false);
        })
        .finally(() => setLoading(false));
    }
  }

  function handleFieldSaved(key: string, next: unknown) {
    setResult((prev) => (prev?.record ? { ...prev, record: { ...prev.record, [key]: next } } : prev));
    router.refresh();
  }

  const record = result?.record ?? null;
  const bodyEntries = record
    ? BODY_FIELDS.filter((k) => record[k] != null && record[k] !== '').map(
        (k) => [k, record[k]] as const,
      )
    : [];
  const fieldEntries = record
    ? Object.entries(record).filter(
        ([k]) => !BODY_FIELDS.includes(k as (typeof BODY_FIELDS)[number]),
      )
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="cursor-pointer font-mono text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        title="View & edit full record"
      >
        {refId}
      </button>

      <DialogContent className="max-h-[85vh] w-[50vw] max-w-[50vw] sm:max-w-[50vw] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="truncate">
            {label ?? '(untitled)'}
          </DialogTitle>
          <DialogDescription>
            {ORPHAN_DATA_TYPE_LABELS[dataType]}
            {result ? ` · ${result.table}` : ''} ·{' '}
            <span className="font-mono">{refId}</span>
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
                  {isOrphanRecordFieldEditable(dataType, key) ? (
                    <EditableField
                      dataType={dataType}
                      field={key}
                      onSaved={(next) => handleFieldSaved(key, next)}
                      refId={refId}
                      value={value}
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/40 p-3 text-xs">
                      {String(value)}
                    </pre>
                  )}
                </section>
              ))}

              <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,12rem)_1fr]">
                {fieldEntries.map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="font-mono text-xs text-muted-foreground sm:pt-0.5">
                      {key}
                    </dt>
                    <dd className="min-w-0">
                      {isOrphanRecordFieldEditable(dataType, key) ? (
                        <EditableField
                          dataType={dataType}
                          field={key}
                          onSaved={(next) => handleFieldSaved(key, next)}
                          refId={refId}
                          value={value}
                        />
                      ) : isMultiline(value) ? (
                        <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-2 text-xs">
                          {formatValue(value)}
                        </pre>
                      ) : (
                        <span className="break-words text-sm">
                          {formatValue(value)}
                        </span>
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
