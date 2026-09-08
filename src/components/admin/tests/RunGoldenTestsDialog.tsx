'use client';

import { useState } from 'react';

import { runGoldenTestsAction } from '~/app/(authenticated)/admin/tests/actions';
import { TestRunModelControls } from '~/components/admin/tests/TestRunModelControls';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';

type RunGoldenTestsDialogProps = {
  /** Where to redirect after submitting (typically /admin/tests). */
  returnPath?: string;
};

/**
 * B0-882 — "Run Golden": one dialog that starts a full-mode run for every active golden test set
 * with a single model / router / agent choice. The field set is `TestRunModelControls`, the same
 * component the per-test "Run dataset" form renders, so the two cannot drift; the server action
 * (`runGoldenTestsAction`) parses them with the same helper `runTestAction` uses.
 */
export function RunGoldenTestsDialog({
  returnPath = '/admin/tests',
}: RunGoldenTestsDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Same amber palette as the "Golden" badge in the test-sets table. */}
        <Button
          className="border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-200 hover:text-amber-900 aria-expanded:bg-amber-200 aria-expanded:text-amber-900"
          size="sm"
          type="button"
          variant="outline"
        >
          Run Golden
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run the golden set</DialogTitle>
          <DialogDescription>
            Creates one full-mode run per active golden test set using the model, router, and
            agent chosen below. Archived golden sets are skipped. Runs start in the background;
            watch their progress from each test set&apos;s page.
          </DialogDescription>
        </DialogHeader>

        <form action={runGoldenTestsAction} className="flex flex-col gap-6 py-2">
          <input name="returnPath" type="hidden" value={returnPath} />

          <TestRunModelControls />

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button type="submit">Run golden set</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
