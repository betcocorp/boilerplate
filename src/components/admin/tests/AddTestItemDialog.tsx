'use client';

import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useState } from 'react';

import { addTestItemAction } from '~/app/(authenticated)/admin/tests/actions';
import { FilterableSuggestionField } from '~/components/admin/tests/FilterableSuggestionField';
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
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { cn } from '~/lib/utils';

type AddTestItemDialogProps = {
  testId: string;
  /** Where to redirect after adding (typically this dataset page). */
  returnPath: string;
  /** Distinct values from all `test_items` in this test (combobox suggestions). */
  suggestionLists: {
    resultTypes: string[];
    canonicalProducts: string[];
    reasonCodes: string[];
    productMentions: string[];
    questionCategories: string[];
    sourceStyles: string[];
  };
};

/** Aligns with common CSV / runner expectations (`evaluateResult`). */
const RESULT_TYPE_PRESETS = ['decline', 'none'] as const;

/** Labels match `parseExpectedShouldAnswerFromForm` in `~/lib/tests/csv`. */
const EXPECTED_BEHAVIOR_PRESETS = [
  'No expectation (n/a)',
  'Should answer',
  'Should decline',
] as const;

export function AddTestItemDialog({
  testId,
  returnPath,
  suggestionLists,
}: AddTestItemDialogProps) {
  const [structuredOpen, setStructuredOpen] = useState(false);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          Add prompt
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add prompt</DialogTitle>
          <DialogDescription>
            Append one row to this dataset. Row number follows the highest
            existing row. Structured optional fields use the same keys as CSV
            import and populate input_payload; prompt length and expectation
            mode populate metadata automatically.
          </DialogDescription>
        </DialogHeader>
        <form action={addTestItemAction} className="grid gap-4">
          <input name="testId" type="hidden" value={testId} />
          <input name="returnPath" type="hidden" value={returnPath} />

          <div className="grid gap-2">
            <Label htmlFor="add-test-item-prompt">Prompt</Label>
            <Textarea
              id="add-test-item-prompt"
              name="prompt"
              placeholder="Question or instruction for the assistant…"
              required
              rows={4}
            />
          </div>

          <FilterableSuggestionField
            id="add-test-item-expected"
            label="Expected behavior"
            name="expectedShouldAnswer"
            placeholder="Choose or type expected behavior"
            presetSuggestions={EXPECTED_BEHAVIOR_PRESETS}
            suggestionsFromDataset={[]}
          />

          <FilterableSuggestionField
            id="add-test-item-result-type"
            label={
              <>
                Expected result type{' '}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </>
            }
            name="expectedResultType"
            placeholder="Choose or type a result type"
            presetSuggestions={RESULT_TYPE_PRESETS}
            suggestionsFromDataset={suggestionLists.resultTypes}
          />

          <FilterableSuggestionField
            id="add-test-item-canonical"
            label={
              <>
                Expected canonical product{' '}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </>
            }
            name="expectedCanonicalProduct"
            placeholder="Choose from dataset or type SKU / product key"
            suggestionsFromDataset={suggestionLists.canonicalProducts}
          />

          <FilterableSuggestionField
            id="add-test-item-reason"
            label={
              <>
                Expected reason code{' '}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </>
            }
            name="expectedReasonCode"
            placeholder="Choose from dataset or type a reason code"
            suggestionsFromDataset={suggestionLists.reasonCodes}
          />

          <div className="rounded-2xl border border-slate-200 bg-slate-50/80">
            <Button
              aria-expanded={structuredOpen}
              className="h-auto w-full justify-start rounded-2xl p-4 text-left font-normal hover:bg-slate-100/80"
              onClick={() => setStructuredOpen((open) => !open)}
              type="button"
              variant="ghost"
            >
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full bg-red-500 ring-2 ring-red-500/25"
              />
              <span className="min-w-0 flex-1 text-sm font-medium text-slate-800">
                Structured inputs{' '}
                <span className="font-normal text-muted-foreground">
                  (optional — CSV columns → input_payload)
                </span>
              </span>
              {structuredOpen ? (
                <ChevronUpIcon
                  aria-hidden
                  className="size-5 shrink-0 text-slate-600"
                />
              ) : (
                <ChevronDownIcon
                  aria-hidden
                  className="size-5 shrink-0 text-slate-600"
                />
              )}
            </Button>
            <div
              className={cn(
                'grid transition-[grid-template-rows] duration-300 ease-out',
                structuredOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="grid gap-3 border-t border-slate-200/80 px-4 pb-4 pt-4">
                  <FilterableSuggestionField
                    id="add-test-item-product-mention"
                    label="Product mention"
                    name="productMention"
                    placeholder="Choose from dataset or type a value"
                    suggestionsFromDataset={suggestionLists.productMentions}
                  />
                  <FilterableSuggestionField
                    id="add-test-item-question-category"
                    label="Question category"
                    name="questionCategory"
                    placeholder="Choose from dataset or type a value"
                    suggestionsFromDataset={suggestionLists.questionCategories}
                  />
                  <FilterableSuggestionField
                    id="add-test-item-source-style"
                    label="Source style"
                    name="sourceStyle"
                    placeholder="Choose from dataset or type a value"
                    suggestionsFromDataset={suggestionLists.sourceStyles}
                  />
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button type="submit">Save prompt</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
