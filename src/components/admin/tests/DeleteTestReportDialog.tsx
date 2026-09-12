'use client';

import { TrashIcon } from 'lucide-react';
import { useState } from 'react';

import { deleteTestReportAction } from '~/app/(authenticated)/admin/tests/actions';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';

type DeleteTestReportDialogProps = {
  testId: string;
  runId: string;
  testName: string;
  returnPath: string;
};

/**
 * B0-965 — confirmation dialog for clearing a run's generated report. Deliberately narrower than
 * `DeleteRoutingTestRunDialog`/`deleteTestRunAction`: only the report fields are cleared, so the
 * copy here must not read like the run itself is being deleted.
 */
export function DeleteTestReportDialog({
  runId,
  testName,
  returnPath,
}: DeleteTestReportDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Button
        aria-label="Delete report"
        onClick={() => setOpen(true)}
        size="icon"
        type="button"
        variant="destructive"
      >
        <TrashIcon className="size-4" />
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this report?</DialogTitle>
          <DialogDescription>
            Only the generated report is deleted. The run and its results stay
            and can be viewed or re-reported from the run&rsquo;s page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-2xl border border-border bg-muted/40 px-3 py-2 text-left text-xs leading-relaxed text-muted-foreground">
          <div>
            <span className="font-medium">Test:</span> {testName}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button onClick={() => setOpen(false)} type="button" variant="outline">
            Cancel
          </Button>
          <form action={deleteTestReportAction}>
            <input name="returnPath" type="hidden" value={returnPath} />
            <input name="runId" type="hidden" value={runId} />
            <Button type="submit" variant="destructive">
              Delete report
            </Button>
          </form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
