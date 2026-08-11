'use client';

import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useState } from 'react';

import { FilterableSuggestionField } from '~/components/admin/tests/FilterableSuggestionField';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { cn } from '~/lib/utils';

/** Aligns with common CSV / runner evaluation rules in `~/lib/tests/runner`. */
const RESULT_TYPE_PRESETS = ['decline', 'none'] as const;

/** Labels match `parseExpectedShouldAnswerFromForm` in `~/lib/tests/csv`. */
const EXPECTED_BEHAVIOR_PRESETS = [
  'No expectation (n/a)',
  'Should answer',
  'Should decline',
] as const;

/** Values match the `should_cite` CSV cell / `parseShouldCiteFromForm` in `~/lib/tests/csv`. */
const SHOULD_CITE_PRESETS = ['yes', 'no'] as const;

export type TestItemSuggestionLists = {
  resultTypes: string[];
  canonicalProducts: string[];
  reasonCodes: string[];
  productMentions: string[];
  questionCategories: string[];
  sourceStyles: string[];
};

/** Pre-fill values when editing an existing row. All optional / default empty. */
export type TestItemFieldsInitialValues = {
  prompt?: string;
  expectedShouldAnswer?: string;
  expectedResultType?: string;
  expectedCanonicalProduct?: string;
  expectedReasonCode?: string;
  priority?: string;
  idealResponse?: string;
  expectedConcepts?: string;
  minimumConcepts?: string;
  expectedSources?: string;
  /** `'yes'` / `'no'` / `''` — matches the CSV cell vocabulary. */
  shouldCite?: string;
  productMention?: string;
  questionCategory?: string;
  sourceStyle?: string;
};

type TestItemFieldsProps = {
  /** Disambiguates input ids when multiple instances mount on a page. */
  idPrefix: string;
  /** `ProdLineKey` → display name (`ProdLineDescr`) for canonical product suggestions. */
  canonicalProductLabels: Record<string, string>;
  /** Combobox option values: mix of global test history and (for canonical) legacy product line keys. */
  suggestionLists: TestItemSuggestionLists;
  initialValues?: TestItemFieldsInitialValues;
};

/**
 * Shared form body for the admin "Add prompt" / "Edit prompt" dialogs. Renders
 * the prompt + expected/structured fields; the surrounding `<form>` (action and
 * hidden ids) lives in the dialog component.
 */
export function TestItemFields({
  idPrefix,
  canonicalProductLabels,
  suggestionLists,
  initialValues,
}: TestItemFieldsProps) {
  const hasStructured = Boolean(
    initialValues?.productMention ||
      initialValues?.questionCategory ||
      initialValues?.sourceStyle,
  );
  const [structuredOpen, setStructuredOpen] = useState(hasStructured);

  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-prompt`}>Prompt</Label>
        <Textarea
          defaultValue={initialValues?.prompt}
          id={`${idPrefix}-prompt`}
          name="prompt"
          placeholder="Question or instruction for the assistant…"
          required
          rows={4}
        />
      </div>

      <FilterableSuggestionField
        id={`${idPrefix}-expected`}
        initialValue={initialValues?.expectedShouldAnswer}
        label="Expected behavior"
        name="expectedShouldAnswer"
        placeholder="Choose or type expected behavior"
        presetSuggestions={EXPECTED_BEHAVIOR_PRESETS}
        suggestionsFromDataset={[]}
      />

      <FilterableSuggestionField
        id={`${idPrefix}-result-type`}
        initialValue={initialValues?.expectedResultType}
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
        id={`${idPrefix}-canonical`}
        initialValue={initialValues?.expectedCanonicalProduct}
        label={
          <>
            Expected canonical product{' '}
            <span className="font-normal text-muted-foreground">
              (product line · optional)
            </span>
          </>
        }
        name="expectedCanonicalProduct"
        optionLabels={canonicalProductLabels}
        placeholder="Choose a product line or type a catalog key"
        suggestionsFromDataset={suggestionLists.canonicalProducts}
      />

      <FilterableSuggestionField
        id={`${idPrefix}-reason`}
        initialValue={initialValues?.expectedReasonCode}
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

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-priority`}>
          Priority{' '}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          defaultValue={initialValues?.priority}
          id={`${idPrefix}-priority`}
          inputMode="numeric"
          max={32767}
          min={-32768}
          name="priority"
          placeholder="e.g. 1"
          step={1}
          type="number"
        />
        <p className="text-xs text-muted-foreground">
          Whole number rank — lower = more important. Leave blank for none.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-ideal-response`}>
          Ideal response{' '}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          defaultValue={initialValues?.idealResponse}
          id={`${idPrefix}-ideal-response`}
          name="idealResponse"
          placeholder="Gold-standard answer to compare against…"
          rows={4}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-expected-concepts`}>
          Expected concepts{' '}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          defaultValue={initialValues?.expectedConcepts}
          id={`${idPrefix}-expected-concepts`}
          name="expectedConcepts"
          placeholder="e.g. 13 oz/gal or 100 mL/L; 1:10 with water"
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          Key concepts a complete answer should contain. Stored exactly as typed
          — dilution ratios, ppm, and contact times are never reformatted.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-minimum-concepts`}>
          Minimum concepts{' '}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          defaultValue={initialValues?.minimumConcepts}
          id={`${idPrefix}-minimum-concepts`}
          name="minimumConcepts"
          placeholder="e.g. 13 oz/gal"
          rows={2}
        />
        <p className="text-xs text-muted-foreground">
          The subset of the above a reviewer must see for this row to pass.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-expected-sources`}>
          Expected sources{' '}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          defaultValue={initialValues?.expectedSources}
          id={`${idPrefix}-expected-sources`}
          name="expectedSources"
          placeholder="e.g. Ax-It Plus TDS, Selector Guide Section 1"
        />
        <p className="text-xs text-muted-foreground">
          Comma-separated sources the answer should be grounded in.
        </p>
      </div>

      <FilterableSuggestionField
        id={`${idPrefix}-should-cite`}
        initialValue={initialValues?.shouldCite}
        label={
          <>
            Should cite sources{' '}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </>
        }
        name="shouldCite"
        placeholder="Choose yes or no"
        presetSuggestions={SHOULD_CITE_PRESETS}
        suggestionsFromDataset={[]}
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
                id={`${idPrefix}-product-mention`}
                initialValue={initialValues?.productMention}
                label="Product mention"
                name="productMention"
                placeholder="Choose from dataset or type a value"
                suggestionsFromDataset={suggestionLists.productMentions}
              />
              <FilterableSuggestionField
                id={`${idPrefix}-question-category`}
                initialValue={initialValues?.questionCategory}
                label="Question category"
                name="questionCategory"
                placeholder="Choose from dataset or type a value"
                suggestionsFromDataset={suggestionLists.questionCategories}
              />
              <FilterableSuggestionField
                id={`${idPrefix}-source-style`}
                initialValue={initialValues?.sourceStyle}
                label="Source style"
                name="sourceStyle"
                placeholder="Choose from dataset or type a value"
                suggestionsFromDataset={suggestionLists.sourceStyles}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
