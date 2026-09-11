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
import { formatMultiTurnScenarioForEditing } from '~/lib/tests/multi-turn-display';
import type { Json } from '~/types/supabase.public';

type EditTestItemDialogProps = {
  testId: string;
  /** Where to redirect after saving (typically this dataset page). */
  returnPath: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
  expectedCanonicalProduct: string | null;
  expectedReasonCode: string | null;
  source: string | null;
  priority: number | null;
  idealResponse: string | null;
  /** `test_items.expected_concepts` — one verbatim phrase per element (B0-934). */
  expectedConcepts: string[];
  /** `test_items.minimum_concepts` — the mandatory subset. */
  minimumConcepts: string[];
  /** `test_items.expected_sources` — `rag.document.id` uuids. */
  expectedSources: string[];
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
            Update this prompt and its expected outcome. Optional fields use the
            same keys as CSV import; question category updates input_payload and
            prompt length updates metadata automatically.
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
                expectedCanonicalProduct: expectedCanonicalProduct ?? '',
                expectedReasonCode: expectedReasonCode ?? '',
                source: source ?? '',
                priority: priority === null ? '' : String(priority),
                idealResponse: idealResponse ?? '',
                expectedConcepts,
                minimumConcepts,
                expectedSources,
                shouldCite: shouldCiteLabel(shouldCite),
                questionCategory: payloadString(inputPayload, 'question_category'),
                // B0-537 — pretty-printed so the scenario is actually editable in a textarea.
                multiTurnJson: formatMultiTurnScenarioForEditing(inputPayload),
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
