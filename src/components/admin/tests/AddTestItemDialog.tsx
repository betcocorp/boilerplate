'use client';

import { addTestItemAction } from '~/app/(authenticated)/admin/tests/actions';
import {
  TestItemFields,
  type TestItemSuggestionLists,
} from '~/components/admin/tests/TestItemFields';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';

type AddTestItemDialogProps = {
  testId: string;
  /** Where to redirect after adding (typically this dataset page). */
  returnPath: string;
  /** `ProdLineKey` → display name (`ProdLineDescr`) for canonical product suggestions. */
  canonicalProductLabels: Record<string, string>;
  /** Combobox option values: mix of global test history and (for canonical) legacy product line keys. */
  suggestionLists: TestItemSuggestionLists;
};

export function AddTestItemDialog({
  testId,
  returnPath,
  canonicalProductLabels,
  suggestionLists,
}: AddTestItemDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" type="button">
          Add
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add prompt</DialogTitle>
          <DialogDescription>
            Append one row to this dataset. Row number follows the highest
            existing row. Optional fields use the same keys as CSV import;
            question category populates input_payload and prompt length
            populates metadata automatically.
          </DialogDescription>
        </DialogHeader>
        <form action={addTestItemAction} className="grid gap-4">
          <input name="testId" type="hidden" value={testId} />
          <input name="returnPath" type="hidden" value={returnPath} />

          <TestItemFields
            canonicalProductLabels={canonicalProductLabels}
            idPrefix="add-test-item"
            suggestionLists={suggestionLists}
          />

          <DialogFooter className="gap-2 pt-2">
            <Button type="submit">Save prompt</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
