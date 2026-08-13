'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import {
  PERMISSIONS_API_BASE,
  envelopeErrorMessage,
  readJsonEnvelope,
} from '~/components/permissions/api';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import type { PermissionGroup } from '~/types/permissions';

export type DeleteGroupDialogProps = {
  group: Pick<PermissionGroup, 'PERMISSION_GROUP_ID' | 'SELECTOR'>;
};

/**
 * Hard-deletes a permission group and its member/permission pivot rows.
 *
 * Port of c360's `components/custom/DeleteGroupDialog` — not in B0-410's component list, but the
 * group detail page renders it next to `MergeGroupDialog`, so the page cannot be ported without it.
 * c360 called the `'use server'` wrapper directly; this goes through
 * `DELETE /api/admin/permissions/groups/:groupId` (B0-409).
 */
export function DeleteGroupDialog({ group }: DeleteGroupDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      const res = await fetch(
        `${PERMISSIONS_API_BASE}/groups/${encodeURIComponent(group.PERMISSION_GROUP_ID)}`,
        { method: 'DELETE' },
      );
      const data = await readJsonEnvelope(res);
      if (!res.ok) {
        toast.error(envelopeErrorMessage(data, 'Failed to delete group'));
        return;
      }
      const members = Number(data.membersRemoved ?? 0);
      const perms = Number(data.permissionsRemoved ?? 0);
      toast.success(
        `Deleted ${group.SELECTOR} and removed ${members} member link${members === 1 ? '' : 's'} ` +
          `and ${perms} permission link${perms === 1 ? '' : 's'}.`,
      );
      setOpen(false);
      // The group no longer exists — return to the permissions list.
      router.push('/admin/permissions');
      router.refresh();
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete group');
    } finally {
      setDeleting(false);
    }
  }, [group, router]);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button
          className="text-destructive hover:text-destructive"
          size="sm"
          variant="outline"
        >
          <Trash2 className="size-4" />
          Delete group
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-3xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Delete {group.SELECTOR}?</DialogTitle>
          <DialogDescription>
            This permanently deletes{' '}
            <span className="font-medium text-foreground">
              {group.SELECTOR}
            </span>{' '}
            and removes every user&rsquo;s membership in it as well as its
            permission assignments. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-muted-foreground">
          Users keep any access they have through other groups or direct
          permissions — only their link to this group is removed. To preserve
          this group&rsquo;s access, use{' '}
          <span className="font-medium text-foreground">
            Merge into another group
          </span>{' '}
          instead.
        </div>

        <DialogFooter>
          <Button
            disabled={deleting}
            onClick={() => setOpen(false)}
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={deleting}
            onClick={handleDelete}
            variant="destructive"
          >
            {deleting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Deleting…
              </>
            ) : (
              'Delete permanently'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
