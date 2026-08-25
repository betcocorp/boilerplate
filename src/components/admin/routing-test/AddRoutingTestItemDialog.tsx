'use client';

import { PlusIcon } from 'lucide-react';

import { RoutingTestItemFields } from '~/components/admin/routing-test/RoutingTestItemFields';
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
import { addRoutingTestItemAction } from '~/lib/routing-test/actions';

type AddRoutingTestItemDialogProps = {
  returnPath: string;
};

export function AddRoutingTestItemDialog({
  returnPath,
}: AddRoutingTestItemDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" type="button">
          <PlusIcon className="size-4" />
          Add item
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add routing test item</DialogTitle>
          <DialogDescription>
            One prompt plus the SME agent it should route to. The routing test is
            a single flat list — there are no datasets to pick between.
          </DialogDescription>
        </DialogHeader>
        <form action={addRoutingTestItemAction} className="grid gap-4">
          <input name="returnPath" type="hidden" value={returnPath} />
          <RoutingTestItemFields idPrefix="add-routing-test-item" />
          <DialogFooter className="gap-2 pt-2">
            <Button type="submit">Save item</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
