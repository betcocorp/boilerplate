'use client';

import { useState } from 'react';

import { runSearchEvalAction } from '~/app/(authenticated)/admin/tests/actions';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';

type RunSearchEvalDialogProps = {
  testId: string;
};

export function RunSearchEvalDialog({ testId }: RunSearchEvalDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Button onClick={() => setOpen(true)} size="sm" type="button" variant="outline">
        Run search eval
      </Button>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Run search eval</DialogTitle>
          <DialogDescription>
            Configure retrieval options for this eval run.
          </DialogDescription>
        </DialogHeader>
        <form action={runSearchEvalAction}>
          <input name="testId" type="hidden" value={testId} />
          <div className="flex flex-col gap-3 py-2">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                className="mt-0.5 size-4 shrink-0"
                name="useHybrid"
                type="checkbox"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium leading-none">Hybrid search</span>
                <span className="text-xs text-muted-foreground">
                  Combines vector + BM25 full-text search via reciprocal rank fusion.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                className="mt-0.5 size-4 shrink-0"
                name="useReranker"
                type="checkbox"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium leading-none">Reranker</span>
                <span className="text-xs text-muted-foreground">
                  Re-scores results with a cross-encoder model after retrieval (requires
                  COHERE_API_KEY).
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                className="mt-0.5 size-4 shrink-0"
                name="useMultiIntent"
                type="checkbox"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium leading-none">Multi-intent fan-out</span>
                <span className="text-xs text-muted-foreground">
                  Decomposes multi-part queries into sub-queries, searches each in parallel,
                  and merges results.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button type="submit">Start run</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
