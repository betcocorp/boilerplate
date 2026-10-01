'use client';

import { CopyPlusIcon, XIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import {
  addPromptsToTestAction,
  createTestFromPromptsAction,
} from '~/app/(authenticated)/admin/tests/actions';
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
import type { TestPickerOption } from '~/lib/tests/repository';
import { cn } from '~/lib/utils';

/** How many matching existing sets the name field lists at once. */
const MAX_SUGGESTIONS = 8;

type CreateTestFromPromptsDialogProps = {
  sourceTestId: string;
  /** Where to redirect on validation errors. */
  returnPath: string;
  /** IDs of `test_items` selected in the parent table. */
  selectedTestItemIds: string[];
  /** Used to pre-fill a sensible default name. */
  sourceTestName: string;
  /**
   * B0-1098 — active test sets the selection can be added to instead of creating a new one
   * (the current test already excluded). Typing in the name field filters this list.
   */
  existingTests: TestPickerOption[];
  /** Disabled state surfaces when no rows are selected (parent still renders the trigger so users see the affordance). */
  disabled?: boolean;
};

/**
 * One dialog, two outcomes. The name field is freeform: type a new name to CREATE a test set,
 * or pick one of the existing sets it suggests to ADD the selection to that set (B0-1098).
 * Editing the text after picking drops back to create mode.
 */
export function CreateTestFromPromptsDialog({
  sourceTestId,
  returnPath,
  selectedTestItemIds,
  sourceTestName,
  existingTests,
  disabled,
}: CreateTestFromPromptsDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${sourceTestName} (subset)`);
  const [target, setTarget] = useState<TestPickerOption | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();

  const selectionCount = selectedTestItemIds.length;
  const isDisabled = disabled || selectionCount === 0;

  const suggestions = useMemo(() => {
    const query = name.trim().toLowerCase();
    if (!query) {
      return existingTests.slice(0, MAX_SUGGESTIONS);
    }
    return existingTests
      .filter((test) => test.name.toLowerCase().includes(query))
      .slice(0, MAX_SUGGESTIONS);
  }, [existingTests, name]);

  const showList = listOpen && target === null && suggestions.length > 0;

  function pickTarget(test: TestPickerOption) {
    setTarget(test);
    setName(test.name);
    setListOpen(false);
  }

  function clearTarget() {
    setTarget(null);
    setName('');
    setListOpen(true);
  }

  function handleNameChange(value: string) {
    setName(value);
    setTarget(null);
    setActiveIndex(0);
    setListOpen(true);
  }

  function handleNameKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!showList) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, suggestions.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      // Enter picks the highlighted set instead of submitting the form.
      event.preventDefault();
      const pick = suggestions[activeIndex];
      if (pick) {
        pickTarget(pick);
      }
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      setListOpen(false);
    }
  }

  return (
    <>
      <Button
        aria-label={`Create a new test set or add to an existing one from ${selectionCount} selected prompt${selectionCount === 1 ? '' : 's'}`}
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
            <DialogTitle>
              {target ? 'Add to existing test set' : 'Create new test set'}
            </DialogTitle>
            <DialogDescription>
              {selectionCount} prompt{selectionCount === 1 ? '' : 's'} from{' '}
              <span className="font-medium text-foreground">{sourceTestName}</span>{' '}
              {target ? (
                <>
                  will be added to{' '}
                  <span className="font-medium text-foreground">{target.name}</span>.
                  Prompts already in that set are skipped.
                </>
              ) : (
                <>will be copied into a new dataset.</>
              )}{' '}
              The original test is left untouched.
            </DialogDescription>
          </DialogHeader>
          <form
            action={target ? addPromptsToTestAction : createTestFromPromptsAction}
            className="grid gap-4"
          >
            <input name="sourceTestId" type="hidden" value={sourceTestId} />
            <input name="returnPath" type="hidden" value={returnPath} />
            {target ? (
              <input name="targetTestId" type="hidden" value={target.id} />
            ) : null}
            {selectedTestItemIds.map((id) => (
              <input key={id} name="testItemId" type="hidden" value={id} />
            ))}

            <div className="grid gap-2">
              <Label htmlFor="create-test-from-prompts-name">
                Test set name
              </Label>
              <div className="relative">
                <Input
                  aria-activedescendant={
                    showList ? `${listboxId}-${activeIndex}` : undefined
                  }
                  aria-autocomplete="list"
                  aria-controls={showList ? listboxId : undefined}
                  aria-expanded={showList}
                  autoComplete="off"
                  className={cn(target && 'pr-9')}
                  id="create-test-from-prompts-name"
                  name="name"
                  onBlur={() => setListOpen(false)}
                  onChange={(event) => handleNameChange(event.target.value)}
                  onFocus={() => setListOpen(true)}
                  onKeyDown={handleNameKeyDown}
                  placeholder="Type a new name, or pick an existing set…"
                  readOnly={target !== null}
                  required
                  role="combobox"
                  value={name}
                />
                {target ? (
                  <button
                    aria-label="Clear selected test set and create a new one instead"
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={clearTarget}
                    type="button"
                  >
                    <XIcon className="size-4" />
                  </button>
                ) : null}
                {showList ? (
                  <ul
                    className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-2xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
                    id={listboxId}
                    role="listbox"
                  >
                    {suggestions.map((test, index) => (
                      <li
                        aria-selected={index === activeIndex}
                        className={cn(
                          'cursor-pointer rounded-xl px-3 py-2 text-sm',
                          index === activeIndex && 'bg-accent text-accent-foreground',
                        )}
                        id={`${listboxId}-${index}`}
                        key={test.id}
                        // mousedown (not click) so the input's blur does not close the list first.
                        onMouseDown={(event) => {
                          event.preventDefault();
                          pickTarget(test);
                        }}
                        onMouseEnter={() => setActiveIndex(index)}
                        role="option"
                      >
                        <div className="font-medium">{test.name}</div>
                        <div className="text-xs text-muted-foreground">
                          Add to existing · {test.row_count} prompt
                          {test.row_count === 1 ? '' : 's'}
                          {test.is_golden ? ' · golden' : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {target
                  ? 'Adding to an existing set. Clear the field to create a new one instead.'
                  : 'Typing filters existing sets; pick one to add the prompts there instead of creating a new set.'}
              </p>
            </div>

            {target ? null : (
              <TestIntendedAgentCombobox
                agents={V1_AGENT_REGISTRY}
                id="create-test-from-prompts-agent"
                label="Intended agent (optional)"
                name="intendedAgent"
                placeholder="Select intended agent…"
              />
            )}

            <DialogFooter className="gap-2 pt-2">
              <Button
                onClick={() => setOpen(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={isDisabled} type="submit">
                {target ? 'Add prompts' : 'Create test'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
