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
import {
  ROUTING_TEST_ROUTER_LABELS,
  ROUTING_TEST_ACCURACY_TONE_CLASSES,
} from '~/lib/routing-test/constants';
import {
  formatRoutingTestRunScore,
  routingTestAccuracyTone,
} from '~/lib/routing-test/scoring';
import type { RoutingTestRunRecord } from '~/lib/routing-test/types';
import { deleteRoutingTestRunAction } from '~/lib/routing-test/actions';
import { formatDate } from '~/lib/utils/time';

type DeleteRoutingTestRunDialogProps = {
  run: RoutingTestRunRecord;
  returnPath: string;
};

/**
 * B0-678 — confirmation dialog for deleting a routing test run and its associated
 * item snapshots.
 */
export function DeleteRoutingTestRunDialog({
  run,
  returnPath,
}: DeleteRoutingTestRunDialogProps) {
  const [open, setOpen] = useState(false);
  const accuracy = run.total_items === 0 ? 0 : run.passed_items / run.total_items;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Button
        aria-label="Delete routing test run"
        onClick={() => setOpen(true)}
        size="icon"
        type="button"
        variant="destructive"
      >
        <TrashIcon className="size-4" />
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this routing test run?</DialogTitle>
          <DialogDescription>
            This run and all its item snapshots are deleted permanently.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-2xl border border-border bg-muted/40 px-3 py-2 text-left text-xs leading-relaxed text-muted-foreground">
          <div>
            <span className="font-medium">Router:</span>{' '}
            {ROUTING_TEST_ROUTER_LABELS[run.router_type]}
            {run.model ? <span className="text-xs"> ({run.model})</span> : null}
          </div>
          <div>
            <span className="font-medium">Ran at:</span> {formatDate(run.ran_at)}
          </div>
          <div>
            <span className="font-medium">Score:</span>{' '}
            <span
              className={`font-medium ${ROUTING_TEST_ACCURACY_TONE_CLASSES[routingTestAccuracyTone(accuracy)]}`}
            >
              {formatRoutingTestRunScore(run.passed_items, run.total_items)}
            </span>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button onClick={() => setOpen(false)} type="button" variant="outline">
            Cancel
          </Button>
          <form action={deleteRoutingTestRunAction}>
            <input name="returnPath" type="hidden" value={returnPath} />
            <input name="runId" type="hidden" value={run.id} />
            <Button type="submit" variant="destructive">
              Delete run
            </Button>
          </form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
