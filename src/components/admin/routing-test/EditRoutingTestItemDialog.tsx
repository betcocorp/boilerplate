'use client';

import { PencilIcon } from 'lucide-react';
import { useState } from 'react';

import { RoutingTestItemFields } from '~/components/admin/routing-test/RoutingTestItemFields';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { updateRoutingTestItemAction } from '~/lib/routing-test/actions';
import type { RoutingTestItemRecord } from '~/lib/routing-test/types';

type EditRoutingTestItemDialogProps = {
  item: RoutingTestItemRecord;
  returnPath: string;
};

export function EditRoutingTestItemDialog({
  item,
  returnPath,
}: EditRoutingTestItemDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Button
        aria-label="Edit routing test item"
        onClick={() => setOpen(true)}
        size="icon"
        type="button"
        variant="outline"
      >
        <PencilIcon className="size-4" />
      </Button>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit routing test item</DialogTitle>
          <DialogDescription>
            Update the prompt or the agent it is expected to route to.
          </DialogDescription>
        </DialogHeader>
        {/* Remounted per open so a cancelled edit never leaves stale values behind. */}
        {open ? (
          <form action={updateRoutingTestItemAction} className="grid gap-4">
            <input name="returnPath" type="hidden" value={returnPath} />
            <input name="itemId" type="hidden" value={item.id} />
            <RoutingTestItemFields
              defaultExpectedAgent={item.expected_agent}
              defaultPrompt={item.prompt}
              idPrefix={`edit-routing-test-item-${item.id}`}
            />
            <DialogFooter className="gap-2 pt-2">
              <Button
                onClick={() => setOpen(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button type="submit">Save changes</Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
