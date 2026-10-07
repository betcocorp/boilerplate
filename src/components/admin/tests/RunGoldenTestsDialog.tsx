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
 *
 * B0-1102 — the optional "Only re-run items scoring below" field. Blank submits exactly what this
 * dialog always submitted (one full-mode run per set); a 0–100 value makes the action dispatch
 * `run_mode='partial'` runs scoped to the items whose latest score is under it. Deliberately an
 * uncontrolled `<input type="number">`: the form keeps its `action={fn}` pattern, and React 19
 * resets the form on success, which is the right thing for a one-shot dialog.
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
            Creates one run per active golden test set using the model, router, and agent chosen
            below — a full run of every item, or a partial run of only the items under a score
            threshold. Archived golden sets are skipped. Runs start in the background; watch their
            progress from each test set&apos;s page.
          </DialogDescription>
        </DialogHeader>

        <form action={runGoldenTestsAction} className="flex flex-col gap-6 py-2">
          <input name="returnPath" type="hidden" value={returnPath} />

          <TestRunModelControls />

          <div className="flex flex-col gap-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="golden-score-threshold"
            >
              Only re-run items scoring below{' '}
              <span className="font-normal text-muted-foreground">(optional, 0–100)</span>
            </label>
            <input
              className="h-9 w-40 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              id="golden-score-threshold"
              inputMode="numeric"
              max={100}
              min={0}
              name="scoreThreshold"
              placeholder="e.g. 75"
              step={1}
              type="number"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to run every item as a full run. With a score, each set re-runs only the
              items whose latest score is below it; items that have never run or were Unable to
              Evaluate are always included. Partial runs never count toward golden-set metrics.
            </p>
          </div>

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
