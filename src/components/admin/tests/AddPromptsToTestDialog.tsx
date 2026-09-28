'use client';

import { ListPlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { addPromptsToTestAction } from '~/app/(authenticated)/admin/tests/actions';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Label } from '~/components/ui/label';
import { LabeledCombobox } from '~/components/ui/labeled-combobox';
import type { TestPickerOption } from '~/lib/tests/repository';

type AddPromptsToTestDialogProps = {
  sourceTestId: string;
  /** Where to redirect on validation errors. */
  returnPath: string;
  /** IDs of `test_items` selected in the parent table. */
  selectedTestItemIds: string[];
  /** Shown in the dialog copy so the user knows what is being copied. */
  sourceTestName: string;
  /** Candidate destinations — active tests only, already excluding the current test. */
  targets: TestPickerOption[];
  /** Disabled state surfaces when no rows are selected (parent still renders the trigger so users see the affordance). */
  disabled?: boolean;
};

/**
 * B0-1098 — "Add to existing test set": copies the selected prompts into a test chosen from a
 * picker. Sibling of `CreateTestFromPromptsDialog`; the server action skips prompts the target
 * already has and leaves the source untouched.
 */
export function AddPromptsToTestDialog({
  sourceTestId,
  returnPath,
  selectedTestItemIds,
  sourceTestName,
  targets,
  disabled,
}: AddPromptsToTestDialogProps) {
  const [open, setOpen] = useState(false);
  const [targetTestId, setTargetTestId] = useState('');

  const selectionCount = selectedTestItemIds.length;
  const isDisabled = disabled || selectionCount === 0;

  const options = useMemo(
    () =>
      targets.map((target) => ({
        id: target.id,
        label: target.name,
        description: `${target.row_count} prompt${target.row_count === 1 ? '' : 's'}${
          target.is_golden ? ' · golden' : ''
        }`,
        keywords: target.is_golden ? ['golden'] : undefined,
      })),
    [targets],
  );

  return (
    <>
      <Button
        aria-label={`Add ${selectionCount} selected prompt${selectionCount === 1 ? '' : 's'} to an existing test set`}
        className="rounded-2xl"
        disabled={isDisabled}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <ListPlusIcon className="size-4" />
        Add to existing test{selectionCount > 0 ? ` (${selectionCount})` : ''}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add to existing test set</DialogTitle>
            <DialogDescription>
              {selectionCount} prompt{selectionCount === 1 ? '' : 's'} from{' '}
              <span className="font-medium text-foreground">{sourceTestName}</span>{' '}
              will be copied into the test set you choose. Prompts already in
              that set are skipped. The original test is left untouched.
            </DialogDescription>
          </DialogHeader>
          <form action={addPromptsToTestAction} className="grid gap-4">
            <input name="sourceTestId" type="hidden" value={sourceTestId} />
            <input name="returnPath" type="hidden" value={returnPath} />
            <input name="targetTestId" type="hidden" value={targetTestId} />
            {selectedTestItemIds.map((id) => (
              <input key={id} name="testItemId" type="hidden" value={id} />
            ))}

            <div className="flex flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="add-prompts-to-test-target"
              >
                Target test set
              </Label>
              <LabeledCombobox
                emptyText={
                  targets.length === 0
                    ? 'No other active test sets to add to.'
                    : 'No test set matches that search.'
                }
                id="add-prompts-to-test-target"
                onValueChange={setTargetTestId}
                options={options}
                placeholder="Select a test set…"
                renderInDialog
                searchPlaceholder="Search test sets…"
                value={targetTestId || null}
              />
            </div>

            <DialogFooter className="gap-2 pt-2">
              <Button
                onClick={() => setOpen(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={isDisabled || !targetTestId} type="submit">
                Add prompts
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
