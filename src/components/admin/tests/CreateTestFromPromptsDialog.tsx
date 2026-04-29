'use client';

import { CopyPlusIcon } from 'lucide-react';
import { useState } from 'react';

import { createTestFromPromptsAction } from '~/app/(authenticated)/admin/tests/actions';
import { TestIntendedAgentCombobox } from '~/components/admin/tests/TestIntendedAgentCombobox';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';

type CreateTestFromPromptsDialogProps = {
  sourceTestId: string;
  /** Where to redirect on validation errors. */
  returnPath: string;
  /** IDs of `test_items` selected in the parent table. */
  selectedTestItemIds: string[];
  /** Used to pre-fill a sensible default name. */
  sourceTestName: string;
  /** Disabled state surfaces when no rows are selected (parent still renders the trigger so users see the affordance). */
  disabled?: boolean;
};

export function CreateTestFromPromptsDialog({
  sourceTestId,
  returnPath,
  selectedTestItemIds,
  sourceTestName,
  disabled,
}: CreateTestFromPromptsDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${sourceTestName} (subset)`);

  const selectionCount = selectedTestItemIds.length;
  const isDisabled = disabled || selectionCount === 0;

  return (
    <>
      <Button
        aria-label={`Create new test from ${selectionCount} selected prompt${selectionCount === 1 ? '' : 's'}`}
        className="rounded-2xl"
        disabled={isDisabled}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <CopyPlusIcon className="size-4" />
        Create new test{selectionCount > 0 ? ` (${selectionCount})` : ''}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create new test set</DialogTitle>
            <DialogDescription>
              {selectionCount} prompt{selectionCount === 1 ? '' : 's'} from{' '}
              <span className="font-medium text-foreground">{sourceTestName}</span>{' '}
              will be copied into a new dataset. The original test is left
              untouched.
            </DialogDescription>
          </DialogHeader>
          <form action={createTestFromPromptsAction} className="grid gap-4">
            <input name="sourceTestId" type="hidden" value={sourceTestId} />
            <input name="returnPath" type="hidden" value={returnPath} />
            {selectedTestItemIds.map((id) => (
              <input key={id} name="testItemId" type="hidden" value={id} />
            ))}

            <div className="grid gap-2">
              <Label htmlFor="create-test-from-prompts-name">
                New test name
              </Label>
              <Input
                autoComplete="off"
                id="create-test-from-prompts-name"
                name="name"
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Bathroom subset – disinfection only"
                required
                value={name}
              />
            </div>

            <TestIntendedAgentCombobox
              agents={V1_AGENT_REGISTRY}
              id="create-test-from-prompts-agent"
              label="Intended agent (optional)"
              name="intendedAgent"
              placeholder="Select intended agent…"
            />

            <DialogFooter className="gap-2 pt-2">
              <Button
                onClick={() => setOpen(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={isDisabled} type="submit">
                Create test
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
