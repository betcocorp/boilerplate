'use client';

import { TrashIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { deleteRoutingTestItemAction } from '~/lib/routing-test/actions';

function truncatePrompt(text: string, max = 280) {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

type DeleteRoutingTestItemDialogProps = {
  itemId: string;
  promptPreview: string;
  returnPath: string;
};

export function DeleteRoutingTestItemDialog({
  itemId,
  promptPreview,
  returnPath,
}: DeleteRoutingTestItemDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Button
        aria-label="Delete routing test item"
        onClick={() => setOpen(true)}
        size="icon"
        type="button"
        variant="destructive"
      >
        <TrashIcon className="size-4" />
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this routing test item?</DialogTitle>
          <DialogDescription>
            The prompt and its expected agent are deleted permanently. Run
            results are never stored, so nothing else is affected.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-32 overflow-y-auto rounded-2xl border border-border bg-muted/40 px-3 py-2 text-left text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {truncatePrompt(promptPreview)}
        </div>
        <DialogFooter className="gap-2">
          <Button onClick={() => setOpen(false)} type="button" variant="outline">
            Cancel
          </Button>
          <form action={deleteRoutingTestItemAction}>
            <input name="returnPath" type="hidden" value={returnPath} />
            <input name="itemId" type="hidden" value={itemId} />
            <Button type="submit" variant="destructive">
              Delete item
            </Button>
          </form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
