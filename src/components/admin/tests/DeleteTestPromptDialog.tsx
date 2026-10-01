'use client';

import { TrashIcon } from 'lucide-react';
import { useState } from 'react';

import { deleteTestItemAction } from '~/app/(authenticated)/admin/tests/actions';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';

function truncatePrompt(text: string, max = 280) {
  const t = text.trim();
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

type DeleteTestPromptDialogProps = {
  testId: string;
  testItemId: string;
  returnPath: string;
  rowIndex: number;
  promptPreview: string;
};

export function DeleteTestPromptDialog({
  testId,
  testItemId,
  returnPath,
  rowIndex,
  promptPreview,
}: DeleteTestPromptDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Button
        aria-label={`Delete prompt row ${rowIndex}`}
        onClick={() => setOpen(true)}
        size="icon"
        type="button"
        variant="destructive"
      >
        <TrashIcon className="size-4" />
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this prompt?</DialogTitle>
          <DialogDescription>
            Row{' '}
            <span className="font-medium text-foreground">{rowIndex}</span> will
            be removed from this dataset. Related run detail rows for this prompt
            are deleted automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-32 overflow-y-auto rounded-2xl border border-border bg-muted/40 px-3 py-2 text-left text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {truncatePrompt(promptPreview)}
        </div>
        <DialogFooter className="gap-2">
          <Button
            onClick={() => setOpen(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <form action={deleteTestItemAction}>
            <input name="returnPath" type="hidden" value={returnPath} />
            <input name="testId" type="hidden" value={testId} />
            <input name="testItemId" type="hidden" value={testItemId} />
            <Button type="submit" variant="destructive">
              Delete prompt
            </Button>
          </form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
