'use client';

import { PlusIcon, XIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { DocumentPickerField } from '~/components/admin/tests/DocumentPickerField';
import { FilterableSuggestionField } from '~/components/admin/tests/FilterableSuggestionField';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';

/** Values match the `should_cite` CSV cell / `parseShouldCiteFromForm` in `~/lib/tests/csv`. */
const SHOULD_CITE_PRESETS = ['yes', 'no'] as const;

/** Common origins for a test prompt. */
const SOURCE_PRESETS = ['bex', 'email', 'contact-us'] as const;

/** B0-537 — shape hint for the multi-turn field, matching `multiTurnScenarioSchema`. */
const MULTI_TURN_PLACEHOLDER = `{
  "version": 1,
  "turns": [
    { "prompt": "First user turn (same as the Prompt field above)" },
    { "prompt": "Follow-up turn", "expectations": { "should_answer": true } }
  ],
  "assertions": [
    { "type": "context_carry", "from_turn": 1, "turn": 2, "anchor": "pH7Q" }
  ]
}`;

export type TestItemSuggestionLists = {
  canonicalProducts: string[];
  reasonCodes: string[];
  sources: string[];
  /**
   * Still built by `[testId]/page.tsx` even though the form no longer renders product-mention or
   * source-style fields (B0-934 removed both). Kept so that page keeps type-checking.
   */
  productMentions: string[];
  questionCategories: string[];
  sourceStyles: string[];
};

/** Pre-fill values when editing an existing row. All optional / default empty. */
export type TestItemFieldsInitialValues = {
  prompt?: string;
  expectedCanonicalProduct?: string;
  expectedReasonCode?: string;
  source?: string;
  priority?: string;
  idealResponse?: string;
  /** One phrase per element — `test_items.expected_concepts` is `text[]` (B0-934). */
  expectedConcepts?: string[];
  /** The mandatory subset — `test_items.minimum_concepts` `text[]`. */
  minimumConcepts?: string[];
  /** `rag.document.id` uuids — `test_items.expected_sources` `uuid[]`. */
  expectedSources?: string[];
  /** `'yes'` / `'no'` / `''` — matches the CSV cell vocabulary. */
  shouldCite?: string;
  questionCategory?: string;
  /** B0-537 — pretty-printed `input_payload.multi_turn` scenario, or '' for a single-turn row. */
  multiTurnJson?: string;
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

type PhraseListFieldProps = {
  id: string;
  /** Form field name repeated once per phrase — read with `formData.getAll(name)`. */
  name: string;
  label: ReactNode;
  description: ReactNode;
  placeholder: string;
  initialPhrases: readonly string[];
};

/**
 * Add-one-at-a-time list of verbatim phrases (B0-934).
 *
 * Regulated-data rule: a phrase is stored exactly as typed. The only change ever applied is
 * stripping leading/trailing whitespace on add — never inside the phrase, never re-cased, never
 * re-punctuated, so a dilution ratio, ppm value, contact time, CAS number or EPA registration
 * number survives a round-trip byte for byte.
 *
 * The submitted payload is repeated hidden inputs rendered from state, not controlled visible
 * fields: React 19 resets uncontrolled form fields when a `<form action>` succeeds, so the typed
 * draft input is kept deliberately separate from the inputs that carry the data.
 */
function PhraseListField({
  id,
  name,
  label,
  description,
  placeholder,
  initialPhrases,
}: PhraseListFieldProps) {
  const [phrases, setPhrases] = useState<string[]>(() => [...initialPhrases]);
  const [draft, setDraft] = useState('');

  const addDraft = () => {
    // Trimming the ends is the only permitted normalisation — see the doc comment above.
    const phrase = draft.trim();
    if (!phrase || phrases.includes(phrase)) {
      setDraft('');
      return;
    }
    setPhrases((current) => [...current, phrase]);
    setDraft('');
  };

  const removeAt = (index: number) => {
    setPhrases((current) => current.filter((_, i) => i !== index));
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              // Otherwise Enter submits the surrounding dialog form.
              event.preventDefault();
              addDraft();
            }
          }}
          placeholder={placeholder}
          value={draft}
        />
        <Button
          className="shrink-0"
          disabled={draft.trim().length === 0}
          onClick={addDraft}
          type="button"
          variant="outline"
        >
          <PlusIcon className="size-4" />
          Add
        </Button>
      </div>

      {phrases.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {phrases.map((phrase, index) => (
            <li key={`${phrase}-${index}`}>
              <span className="inline-flex max-w-full items-center gap-1 rounded-2xl border border-border bg-muted/60 py-1 pl-2.5 pr-1 text-xs">
                <span className="break-words whitespace-pre-wrap text-foreground">
                  {phrase}
                </span>
                <Button
                  aria-label={`Remove “${phrase}”`}
                  className="size-5 shrink-0 rounded-full"
                  onClick={() => removeAt(index)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <XIcon className="size-3" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {phrases.map((phrase, index) => (
        <input
          key={`${name}-${index}`}
          name={name}
          type="hidden"
          value={phrase}
        />
      ))}

      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

/** Shared regulated-data caveat under every phrase list. */
const VERBATIM_NOTE = (
  <>
    {' '}
    Each phrase is stored exactly as typed — dilution ratios, oz/gal, mL/L, ppm,
    contact times, CAS numbers and EPA registration numbers are never rounded,
    converted or reformatted.
  </>
);

/**
 * Shared form body for the admin "Add prompt" / "Edit prompt" dialogs. Renders
 * the prompt + expected fields; the surrounding `<form>` (action and hidden ids)
 * lives in the dialog component.
 */
export function TestItemFields({
  idPrefix,
  canonicalProductLabels,
  suggestionLists,
  initialValues,
}: TestItemFieldsProps) {
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

      <FilterableSuggestionField
        id={`${idPrefix}-source`}
        initialValue={initialValues?.source}
        label={
          <>
            Source{' '}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </>
        }
        name="source"
        placeholder="Choose or type where this prompt came from"
        presetSuggestions={SOURCE_PRESETS}
        suggestionsFromDataset={suggestionLists.sources}
      />
      <p className="text-xs text-muted-foreground">
        Where the prompt originated — e.g. email, bex, contact-us.
      </p>

      <FilterableSuggestionField
        id={`${idPrefix}-question-category`}
        initialValue={initialValues?.questionCategory}
        label={
          <>
            Question category{' '}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </>
        }
        name="questionCategory"
        placeholder="Choose from dataset or type a value"
        suggestionsFromDataset={suggestionLists.questionCategories}
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

      <PhraseListField
        description={
          <>
            Key concepts a complete answer should contain — should-haves. Add one
            phrase at a time (Enter or Add).{VERBATIM_NOTE}
          </>
        }
        id={`${idPrefix}-expected-concepts`}
        initialPhrases={initialValues?.expectedConcepts ?? []}
        label={
          <>
            Expected concepts{' '}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </>
        }
        name="expectedConcepts"
        placeholder="e.g. 13 oz/gal or 100 mL/L"
      />

      <PhraseListField
        description={
          <>
            The must-have subset a reviewer has to see for this row to pass.
            {VERBATIM_NOTE}
          </>
        }
        id={`${idPrefix}-minimum-concepts`}
        initialPhrases={initialValues?.minimumConcepts ?? []}
        label={
          <>
            Minimum concepts{' '}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </>
        }
        name="minimumConcepts"
        placeholder="e.g. 13 oz/gal"
      />

      <DocumentPickerField
        description="Betco documents the answer should be grounded in. Search by product or document title; the row stores each document's id, so a renamed document keeps matching."
        id={`${idPrefix}-expected-sources`}
        initialDocumentIds={initialValues?.expectedSources ?? []}
        label={
          <>
            Expected sources{' '}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </>
        }
        name="expectedSources"
      />

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

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-multi-turn-json`}>
          Multi-turn scenario{' '}
          <span className="font-normal text-muted-foreground">
            (JSON · optional)
          </span>
        </Label>
        <Textarea
          className="font-mono text-xs"
          defaultValue={initialValues?.multiTurnJson}
          id={`${idPrefix}-multi-turn-json`}
          name="multiTurnJson"
          placeholder={MULTI_TURN_PLACEHOLDER}
          rows={6}
        />
        <p className="text-xs text-muted-foreground">
          Turns this row into an ordered conversation (B0-537): an{' '}
          <code>turns</code> array of two or more prompts, replayed in one conversation, plus
          optional cross-turn <code>assertions</code> (<code>context_carry</code>,{' '}
          <code>no_reask</code>, <code>consistent_product_anchor</code>,{' '}
          <code>mentions</code>, <code>not_mentions</code>). Turn 1&rsquo;s prompt must match the
          Prompt field above. Leave blank for an ordinary single-turn row; clearing it converts the
          row back. Keep expectations structural — never author dilution ratios, contact times, or
          EPA numbers you have not read verbatim off a label.
        </p>
      </div>
    </>
  );
}
