'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { ProductLinePicker } from '~/components/admin/ProductLinePicker';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import {
  confirmEntityLink,
  createOrphanProductAlias,
  updateOrphanRecordField,
} from '~/lib/orphans/orphan-queue-actions';
import { getErrorMessage } from '~/lib/utils';
import type { OrphanQueueRow } from '~/types/orphans';

/** Matches `rag.product_alias.alias_type`'s check constraint (`PRODUCT_ALIAS_TYPES` in
 *  `~/lib/rag/product-alias-review-schemas.ts`) — duplicated as a plain literal tuple here so this
 *  client component doesn't import a `'use server'`-adjacent module tree just for one constant. */
const ALIAS_TYPES = [
  'acronym',
  'common_name',
  'sku',
  'misspelling',
  'legacy_name',
  'synonym',
  'title',
] as const;

const ALIAS_TYPE_LABELS: Record<(typeof ALIAS_TYPES)[number], string> = {
  acronym: 'Acronym',
  common_name: 'Common name',
  sku: 'SKU',
  misspelling: 'Misspelling',
  legacy_name: 'Legacy name',
  synonym: 'Synonym',
  title: 'Title',
};

function detailString(row: OrphanQueueRow, key: string): string {
  const value = row.detail?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * B0-1094 — the real reconciliation action for a `products` orphan row, distinct from
 * Acknowledge (which only hides the row via `public.orphan_ignore` and never touches the
 * underlying record). Renders nothing for check keys with no defined fix — Acknowledge stays
 * the only action there, same as before this ticket.
 */
export function OrphanReconcileAction({ row }: { row: OrphanQueueRow }) {
  switch (row.check_key) {
    case 'product_no_line':
      return <SetProductLineAction row={row} />;
    case 'product_link_unverified':
      return <ConfirmLinkAction row={row} />;
    case 'product_no_alias':
      return <AddAliasAction row={row} />;
    default:
      return null;
  }
}

function SetProductLineAction({ row }: { row: OrphanQueueRow }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState({ productLineKey: '', title: '' });
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSave() {
    if (!value.productLineKey.trim()) return;
    startTransition(async () => {
      try {
        await updateOrphanRecordField({
          dataType: 'products',
          refId: row.ref_id,
          field: 'product_line_key',
          value: value.productLineKey.trim(),
        });
        toast.success('Product line assigned');
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to assign product line'));
      }
    });
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValue({ productLineKey: '', title: '' });
      }}
      open={open}
    >
      <Button onClick={() => setOpen(true)} size="sm" type="button" variant="outline">
        Assign line
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign product line</DialogTitle>
          <DialogDescription>
            Sets <code className="rounded bg-muted px-1.5 py-0.5 text-xs">rag.entity.product_line_key</code>{' '}
            for &ldquo;{row.ref_label ?? row.ref_id}&rdquo;.
          </DialogDescription>
        </DialogHeader>
        <ProductLinePicker
          disabled={isPending}
          idPrefix={`orphan-line-${row.ref_id}`}
          onChange={setValue}
          value={value}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={isPending || !value.productLineKey.trim()}
            onClick={handleSave}
            type="button"
          >
            {isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmLinkAction({ row }: { row: OrphanQueueRow }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleConfirm() {
    startTransition(async () => {
      try {
        await confirmEntityLink({ refId: row.ref_id });
        toast.success('Link confirmed');
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to confirm link'));
      }
    });
  }

  return (
    <Button disabled={isPending} onClick={handleConfirm} size="sm" type="button" variant="outline">
      {isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
      Confirm link
    </Button>
  );
}

function AddAliasAction({ row }: { row: OrphanQueueRow }) {
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState('');
  const [aliasType, setAliasType] = useState<(typeof ALIAS_TYPES)[number]>('synonym');
  const [productLine, setProductLine] = useState({ productLineKey: '', title: '' });
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setAlias('');
      setAliasType('synonym');
      setProductLine({ productLineKey: detailString(row, 'product_line_key'), title: '' });
    }
  }

  function handleSave() {
    if (!alias.trim() || !productLine.productLineKey.trim()) return;
    startTransition(async () => {
      try {
        await createOrphanProductAlias({
          entityId: row.ref_id,
          productLineKey: productLine.productLineKey.trim(),
          alias: alias.trim(),
          aliasType,
        });
        toast.success(`Alias "${alias.trim()}" added`);
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to add alias'));
      }
    });
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <Button onClick={() => handleOpenChange(true)} size="sm" type="button" variant="outline">
        Add alias
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add alias</DialogTitle>
          <DialogDescription>
            Creates a new, verified <code className="rounded bg-muted px-1.5 py-0.5 text-xs">rag.product_alias</code>{' '}
            row for &ldquo;{row.ref_label ?? row.ref_id}&rdquo;. Only add this when a real
            synonym/acronym exists — most products legitimately have none.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`orphan-alias-${row.ref_id}`}>Alias</Label>
            <Input
              disabled={isPending}
              id={`orphan-alias-${row.ref_id}`}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. an acronym or common name"
              value={alias}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`orphan-alias-type-${row.ref_id}`}>Alias type</Label>
            <Select
              onValueChange={(v) => setAliasType(v as (typeof ALIAS_TYPES)[number])}
              value={aliasType}
            >
              <SelectTrigger id={`orphan-alias-type-${row.ref_id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALIAS_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {ALIAS_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ProductLinePicker
            disabled={isPending}
            idPrefix={`orphan-alias-line-${row.ref_id}`}
            onChange={setProductLine}
            value={productLine}
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={isPending || !alias.trim() || !productLine.productLineKey.trim()}
            onClick={handleSave}
            type="button"
          >
            {isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
