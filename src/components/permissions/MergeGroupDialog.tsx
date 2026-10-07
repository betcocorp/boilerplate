'use client';

import { GitMerge, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  PERMISSIONS_API_BASE,
  envelopeErrorMessage,
  readJsonEnvelope,
} from '~/components/permissions/api';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import {
  Dialog,
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
import type { PermissionGroup } from '~/types/permissions';

type Preview = { usersToAdd: number; permissionsToAdd: number };

export type MergeGroupDialogProps = {
  /** All groups, to pick the TARGET from. The source and soft-deleted groups are excluded. */
  allGroups: PermissionGroup[];
  /** The group being viewed — the SOURCE, merged into a target the admin chooses. */
  sourceGroup: Pick<PermissionGroup, 'PERMISSION_GROUP_ID' | 'SELECTOR'>;
};

/**
 * Merges the group being viewed into another group, previewing what would be added first.
 *
 * Port of c360's `components/custom/MergeGroupDialog`. c360 called two `'use server'` wrappers
 * (`getPermissionGroupMergePreview`, `mergePermissionGroups`) directly from the client; here both go
 * through the B0-409 handlers — `GET …/groups/:target/merge-preview?sourceGroupId=…` and
 * `POST …/groups/:target/merge` — so the session and permission gates apply.
 */
export function MergeGroupDialog({
  allGroups,
  sourceGroup,
}: MergeGroupDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [deleteSource, setDeleteSource] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  const targetOptions = allGroups.filter(
    (group) =>
      group.PERMISSION_GROUP_ID !== sourceGroup.PERMISSION_GROUP_ID &&
      !group.DELETED_AT,
  );

  // Reset transient state whenever the dialog is (re)opened.
  useEffect(() => {
    if (!open) return;
    setTargetId('');
    setDeleteSource(true);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
  }, [open]);

  // Dry-run preview whenever a target group is chosen.
  useEffect(() => {
    if (!open || !targetId) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void (async () => {
      try {
        const res = await fetch(
          `${PERMISSIONS_API_BASE}/groups/${encodeURIComponent(targetId)}/merge-preview` +
            `?sourceGroupId=${encodeURIComponent(sourceGroup.PERMISSION_GROUP_ID)}`,
          { cache: 'no-store' },
        );
        const data = await readJsonEnvelope(res);
        if (cancelled) return;
        if (res.ok && data.success) {
          setPreview({
            usersToAdd: Number(data.usersToAdd ?? 0),
            permissionsToAdd: Number(data.permissionsToAdd ?? 0),
          });
        } else {
          setPreviewError(
            envelopeErrorMessage(data, 'Failed to preview merge'),
          );
        }
      } catch {
        if (!cancelled) setPreviewError('Failed to preview merge');
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, targetId, sourceGroup.PERMISSION_GROUP_ID]);

  const targetSelector = targetOptions.find(
    (group) => group.PERMISSION_GROUP_ID === targetId,
  )?.SELECTOR;

  const handleMerge = useCallback(async () => {
    if (!targetId) {
      toast.error('Choose a group to merge into');
      return;
    }
    setMerging(true);
    try {
      const res = await fetch(
        `${PERMISSIONS_API_BASE}/groups/${encodeURIComponent(targetId)}/merge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceGroupId: sourceGroup.PERMISSION_GROUP_ID,
            deleteSource,
          }),
        },
      );
      const data = await readJsonEnvelope(res);
      if (!res.ok) {
        toast.error(envelopeErrorMessage(data, 'Failed to merge groups'));
        return;
      }
      const users = Number(data.usersMerged ?? 0);
      const perms = Number(data.permissionsMerged ?? 0);
      toast.success(
        `Merged ${sourceGroup.SELECTOR} into ${targetSelector ?? 'group'}: ` +
          `added ${users} user${users === 1 ? '' : 's'} and ${perms} permission${perms === 1 ? '' : 's'}` +
          (data.deletedSource
            ? `. ${sourceGroup.SELECTOR} was deleted.`
            : '.'),
      );
      setOpen(false);
      // Go to the target so the admin sees the result — and because the source group may have just
      // been soft-deleted, which would 404 the page we are on.
      router.push(
        `/admin/permissions/groups/${encodeURIComponent(targetId)}`,
      );
      router.refresh();
    } catch (err) {
      console.error(err);
      toast.error('Failed to merge groups');
    } finally {
      setMerging(false);
    }
  }, [targetId, deleteSource, targetSelector, sourceGroup, router]);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <GitMerge className="size-4" />
          Merge into another group
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-3xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Merge {sourceGroup.SELECTOR} into another group
          </DialogTitle>
          <DialogDescription>
            Copies all members and permissions from{' '}
            <span className="font-medium text-foreground">
              {sourceGroup.SELECTOR}
            </span>{' '}
            into the group you choose. Items already present are skipped (no
            duplicates). The target group keeps its name and id.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label htmlFor="merge-target-select">
              Merge into (target group)
            </Label>
            {targetOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No other groups are available to merge into.
              </p>
            ) : (
              <Select onValueChange={setTargetId} value={targetId}>
                <SelectTrigger className="w-full" id="merge-target-select">
                  <SelectValue placeholder="Select a group to merge into…" />
                </SelectTrigger>
                <SelectContent>
                  {targetOptions.map((group) => (
                    <SelectItem
                      key={group.PERMISSION_GROUP_ID}
                      value={group.PERMISSION_GROUP_ID}
                    >
                      {group.SELECTOR}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {targetId ? (
            <div className="rounded-2xl border border-border bg-muted/40 p-3 text-sm">
              {previewLoading ? (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Calculating what will be added…
                </span>
              ) : previewError ? (
                <span className="text-destructive">{previewError}</span>
              ) : preview ? (
                <div className="space-y-1">
                  <p>
                    <span className="font-medium text-foreground">
                      {preview.usersToAdd}
                    </span>{' '}
                    user{preview.usersToAdd === 1 ? '' : 's'} and{' '}
                    <span className="font-medium text-foreground">
                      {preview.permissionsToAdd}
                    </span>{' '}
                    permission{preview.permissionsToAdd === 1 ? '' : 's'} will be
                    added to {targetSelector ?? 'the target group'}.
                  </p>
                  {preview.usersToAdd === 0 &&
                  preview.permissionsToAdd === 0 ? (
                    <p className="text-muted-foreground">
                      Everything in {sourceGroup.SELECTOR} is already in{' '}
                      {targetSelector ?? 'the target group'} — the merge will
                      make no changes to the target.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox
              aria-label={`Delete ${sourceGroup.SELECTOR} after merge`}
              checked={deleteSource}
              className="mt-0.5"
              onCheckedChange={(checked) => setDeleteSource(checked === true)}
            />
            <span>
              Delete {sourceGroup.SELECTOR} (this group) after merging
              <span className="block text-xs text-muted-foreground">
                Recoverable soft delete — the group is hidden but can be
                restored.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button
            disabled={merging}
            onClick={() => setOpen(false)}
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            className="rounded-2xl"
            disabled={merging || !targetId}
            onClick={handleMerge}
          >
            {merging ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Merging…
              </>
            ) : (
              'Merge group'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
