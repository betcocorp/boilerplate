'use client';

import { PencilIcon } from 'lucide-react';
import { useState } from 'react';

import { updateTestItemAction } from '~/app/(authenticated)/admin/tests/actions';
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
import type { Json } from '~/types/supabase.public';

type EditTestItemDialogProps = {
  testId: string;
  /** Where to redirect after saving (typically this dataset page). */
  returnPath: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
  expectedShouldAnswer: boolean | null;
  expectedResultType: string | null;
  expectedCanonicalProduct: string | null;
  expectedReasonCode: string | null;
  source: string | null;
  priority: number | null;
  idealResponse: string | null;
  expectedConcepts: string | null;
  minimumConcepts: string | null;
  expectedSources: string | null;
  shouldCite: boolean | null;
  inputPayload: Json;
  /** `ProdLineKey` → display name (`ProdLineDescr`) for canonical product suggestions. */
  canonicalProductLabels: Record<string, string>;
  /** Combobox option values: mix of global test history and (for canonical) legacy product line keys. */
  suggestionLists: TestItemSuggestionLists;
};

function payloadString(payload: Json, key: string): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return '';
  }
  const raw = (payload as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : '';
}

/** Maps the stored tri-state to the preset label parsed by the update action. */
function expectedBehaviorLabel(value: boolean | null): string {
  if (value === true) {
    return 'Should answer';
  }
  if (value === false) {
    return 'Should decline';
  }
  return '';
}

/** Maps stored `should_cite` to the CSV-style preset the update action parses. */
function shouldCiteLabel(value: boolean | null): string {
  if (value === true) {
    return 'yes';
  }
  if (value === false) {
    return 'no';
  }
  return '';
}

export function EditTestItemDialog({
  testId,
  returnPath,
  testItemId,
  rowIndex,
  prompt,
  expectedShouldAnswer,
  expectedResultType,
  expectedCanonicalProduct,
  expectedReasonCode,
  source,
  priority,
  idealResponse,
  expectedConcepts,
  minimumConcepts,
  expectedSources,
  shouldCite,
  inputPayload,
  canonicalProductLabels,
  suggestionLists,
}: EditTestItemDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button
          aria-label={`Edit prompt row ${rowIndex}`}
          size="icon"
          type="button"
          variant="outline"
        >
          <PencilIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit prompt (row {rowIndex})</DialogTitle>
          <DialogDescription>
            Update this prompt and its expected outcome. Structured optional
            fields use the same keys as CSV import and update input_payload;
            prompt length and expectation mode update metadata automatically.
          </DialogDescription>
        </DialogHeader>
        {/* Remount fields per open so defaults reflect the latest saved values. */}
        {open ? (
          <form action={updateTestItemAction} className="grid gap-4">
            <input name="testId" type="hidden" value={testId} />
            <input name="testItemId" type="hidden" value={testItemId} />
            <input name="returnPath" type="hidden" value={returnPath} />

            <TestItemFields
              canonicalProductLabels={canonicalProductLabels}
              idPrefix={`edit-test-item-${testItemId}`}
              initialValues={{
                prompt,
                expectedShouldAnswer: expectedBehaviorLabel(expectedShouldAnswer),
                expectedResultType: expectedResultType ?? '',
                expectedCanonicalProduct: expectedCanonicalProduct ?? '',
                expectedReasonCode: expectedReasonCode ?? '',
                source: source ?? '',
                priority: priority === null ? '' : String(priority),
                idealResponse: idealResponse ?? '',
                expectedConcepts: expectedConcepts ?? '',
                minimumConcepts: minimumConcepts ?? '',
                expectedSources: expectedSources ?? '',
                shouldCite: shouldCiteLabel(shouldCite),
                productMention: payloadString(inputPayload, 'product_mention'),
                questionCategory: payloadString(inputPayload, 'question_category'),
                sourceStyle: payloadString(inputPayload, 'source_style'),
              }}
              suggestionLists={suggestionLists}
            />

            <DialogFooter className="gap-2 pt-2">
              <Button type="submit">Save changes</Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
