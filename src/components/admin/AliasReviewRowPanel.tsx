'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { ProductLinePicker } from '~/components/admin/ProductLinePicker';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import {
  approveProductAlias,
  editProductAlias,
  rejectProductAlias,
} from '~/lib/rag/product-alias-review-actions';
import {
  PRODUCT_ALIAS_TYPES,
  type ProductAliasReviewRow,
  type ProductAliasType,
} from '~/lib/rag/product-alias-review-schemas';
import { getErrorMessage } from '~/lib/utils';

const ALIAS_TYPE_LABELS: Record<ProductAliasType, string> = {
  acronym: 'Acronym',
  common_name: 'Common name',
  sku: 'SKU',
  misspelling: 'Misspelling',
  legacy_name: 'Legacy name',
  synonym: 'Synonym',
  title: 'Title',
};

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDate(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function AliasReviewRowPanel({ row }: { row: ProductAliasReviewRow }) {
  const [editing, setEditing] = useState(false);
  const [productLineKey, setProductLineKey] = useState(row.productLineKey);
  const [productLineTitle, setProductLineTitle] = useState(row.productLineTitle ?? '');
  const [aliasType, setAliasType] = useState<ProductAliasType>(row.aliasType);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleApprove() {
    startTransition(async () => {
      try {
        const result = await approveProductAlias(row.id);
        if (!result.ok) {
          // B0-486 — the formulation-variant guard refused the merge. Surface the field-by-field
          // reason (exact stored values) rather than a generic failure; the full decision is in
          // `audit_logs` under `product_alias_approval_blocked`.
          toast.error(`Cannot approve "${row.alias}"`, {
            description: result.decision.reason,
            duration: 12_000,
          });
          return;
        }
        toast.success(`Approved "${row.alias}"`);
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to approve alias'));
      }
    });
  }

  function handleSaveEdit() {
    const patch: { productLineKey?: string; aliasType?: ProductAliasType } = {};
    if (productLineKey.trim() && productLineKey.trim() !== row.productLineKey) {
      patch.productLineKey = productLineKey.trim();
    }
    if (aliasType !== row.aliasType) {
      patch.aliasType = aliasType;
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      try {
        await editProductAlias(row.id, patch);
        toast.success('Alias updated');
        setEditing(false);
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to update alias'));
      }
    });
  }

  function handleReject() {
    startTransition(async () => {
      try {
        await rejectProductAlias(row.id);
        toast.success(`Rejected "${row.alias}" — row deleted`);
        setRejectOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to reject alias'));
      }
    });
  }

  return (
    <li
      className={`rounded-2xl border p-4 ${
        row.isConflict
          ? 'border-amber-300/70 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30'
          : 'border-border/60 bg-muted/30'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">{row.alias}</p>
            <Badge variant="outline">{ALIAS_TYPE_LABELS[row.aliasType]}</Badge>
            {row.isConflict ? (
              <Badge variant="destructive">
                Conflict — {row.conflictingProductLines.length + 1} product lines
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{row.aliasNorm}</p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>
            {formatPercent(row.confidence)} confidence · {row.source}
          </p>
          <p>{formatDate(row.createdAt)}</p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-border/60 bg-background/60 p-3">
        {editing ? (
          <div className="space-y-3">
            <ProductLinePicker
              disabled={isPending}
              idPrefix={`alias-${row.id}`}
              onChange={({ productLineKey: key, title }) => {
                setProductLineKey(key);
                setProductLineTitle(title);
              }}
              value={{ productLineKey, title: productLineTitle }}
            />
            <div className="space-y-1">
              <Label htmlFor={`alias-type-${row.id}`}>Alias type</Label>
              <Select
                onValueChange={(v) => setAliasType(v as ProductAliasType)}
                value={aliasType}
              >
                <SelectTrigger id={`alias-type-${row.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_ALIAS_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {ALIAS_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button disabled={isPending} onClick={handleSaveEdit} size="sm" type="button">
                {isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
                Save
              </Button>
              <Button
                onClick={() => {
                  setProductLineKey(row.productLineKey);
                  setProductLineTitle(row.productLineTitle ?? '');
                  setAliasType(row.aliasType);
                  setEditing(false);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {row.productLineTitle ?? 'Unknown product line'}
              </p>
              <p className="font-mono text-xs text-muted-foreground">{row.productLineKey}</p>
            </div>
            <Button
              className="h-auto p-0 text-xs"
              disabled={isPending}
              onClick={() => setEditing(true)}
              size="sm"
              type="button"
              variant="link"
            >
              Edit product line / alias type
            </Button>
          </div>
        )}

        {row.isConflict && row.conflictingProductLines.length > 0 ? (
          <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            Also mapped to:{' '}
            {row.conflictingProductLines
              .map((c) => c.title ?? c.productLineKey)
              .join(', ')}
          </div>
        ) : null}
      </div>

      {!editing ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={isPending} onClick={handleApprove} size="sm" type="button">
            {isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
            Approve
          </Button>

          <Dialog onOpenChange={setRejectOpen} open={rejectOpen}>
            <DialogTrigger asChild>
              <Button disabled={isPending} size="sm" type="button" variant="outline">
                Reject
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reject alias</DialogTitle>
                <DialogDescription>
                  This permanently deletes the row for &ldquo;{row.alias}&rdquo; from{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">rag.product_alias</code>.
                  This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="ghost">
                    Cancel
                  </Button>
                </DialogClose>
                <Button disabled={isPending} onClick={handleReject} type="button" variant="destructive">
                  {isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  Confirm reject
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </li>
  );
}
